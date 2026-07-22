"""Patch extraction and tabular summaries shared by deep and baseline models."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, Mapping, Sequence, Tuple

import numpy as np

from .geo import GeoGrid, validate_observation_extent
from .terrain import TERRAIN_CHANNELS


def extract_patches(
    channels: np.ndarray,
    grid: GeoGrid,
    x: Sequence[float],
    y: Sequence[float],
    patch_size: int = 17,
) -> np.ndarray:
    """Extract edge-padded terrain patches centered on projected coordinates."""

    if channels.shape != (len(TERRAIN_CHANNELS), grid.height, grid.width):
        raise ValueError("terrain channels do not align with the supplied grid")
    if patch_size < 3 or patch_size % 2 == 0:
        raise ValueError("patch_size must be an odd integer of at least three")
    validate_observation_extent(grid, x, y)
    rows, cols = grid.xy_to_row_col(np.asarray(x), np.asarray(y))
    radius = patch_size // 2
    finite = np.isfinite(channels)
    channel_medians = np.nanmedian(channels.reshape(channels.shape[0], -1), axis=1)
    filled = np.where(finite, channels, channel_medians[:, None, None])
    padded = np.pad(filled, ((0, 0), (radius, radius), (radius, radius)), mode="edge")
    patches = np.empty((len(rows), channels.shape[0], patch_size, patch_size), dtype=np.float32)
    for index, (row, col) in enumerate(zip(rows, cols)):
        patches[index] = padded[:, row : row + patch_size, col : col + patch_size]
    return patches


def summarize_patches(patches: np.ndarray) -> Tuple[np.ndarray, Tuple[str, ...]]:
    """Create interpretable per-channel features for classical baselines."""

    if patches.ndim != 4 or patches.shape[1] != len(TERRAIN_CHANNELS):
        raise ValueError("patches must have shape (N, 6, H, W)")
    center_row = patches.shape[2] // 2
    center_col = patches.shape[3] // 2
    features = []
    names = []
    for channel_index, channel_name in enumerate(TERRAIN_CHANNELS):
        layer = patches[:, channel_index]
        summaries = (
            layer[:, center_row, center_col],
            np.mean(layer, axis=(1, 2)),
            np.std(layer, axis=(1, 2)),
            np.min(layer, axis=(1, 2)),
            np.max(layer, axis=(1, 2)),
        )
        for suffix, values in zip(("center", "mean", "std", "min", "max"), summaries):
            features.append(values)
            names.append(f"{channel_name}__{suffix}")
    return np.column_stack(features).astype(np.float32), tuple(names)


def select_channels(
    features: np.ndarray,
    feature_names: Sequence[str],
    channels: Iterable[str],
) -> Tuple[np.ndarray, Tuple[str, ...]]:
    requested = set(channels)
    unknown = requested - set(TERRAIN_CHANNELS)
    if unknown:
        raise ValueError(f"unknown terrain channels: {sorted(unknown)}")
    mask = np.asarray([name.split("__", 1)[0] in requested for name in feature_names])
    if not np.any(mask):
        raise ValueError("channel selection produced zero features")
    return features[:, mask], tuple(name for name, keep in zip(feature_names, mask) if keep)


def sample_water_centers(
    channels: np.ndarray,
    grid: GeoGrid,
    *,
    depth_channel: int = 0,
    stride_m: float = 100.0,
    max_centers: int | None = None,
    seed: int = 42,
) -> Tuple[np.ndarray, np.ndarray]:
    """Sample deterministic, spaced underwater centers for unlabeled pretraining."""

    if channels.ndim != 3 or channels.shape[1:] != grid.values.shape:
        raise ValueError("channels do not align with the supplied grid")
    if not 0 <= depth_channel < channels.shape[0]:
        raise ValueError("depth_channel is out of range")
    if stride_m <= 0:
        raise ValueError("stride_m must be positive")
    dx, dy = grid.pixel_size
    row_stride = max(1, int(round(stride_m / dy)))
    col_stride = max(1, int(round(stride_m / dx)))
    rows = np.arange(0, grid.height, row_stride, dtype=int)
    cols = np.arange(0, grid.width, col_stride, dtype=int)
    row_grid, col_grid = np.meshgrid(rows, cols, indexing="ij")
    candidate_rows = row_grid.ravel()
    candidate_cols = col_grid.ravel()
    depth = channels[depth_channel, candidate_rows, candidate_cols]
    valid = np.isfinite(depth) & (depth > 0)
    candidate_rows = candidate_rows[valid]
    candidate_cols = candidate_cols[valid]
    if len(candidate_rows) == 0:
        raise ValueError("no underwater cells were available for pretraining centers")
    if max_centers is not None:
        if max_centers < 1:
            raise ValueError("max_centers must be positive")
        if len(candidate_rows) > max_centers:
            generator = np.random.default_rng(seed)
            selected = np.sort(generator.choice(len(candidate_rows), max_centers, replace=False))
            candidate_rows = candidate_rows[selected]
            candidate_cols = candidate_cols[selected]
    x0, cell_x, _, y0, _, cell_y = grid.transform
    xs = x0 + (candidate_cols + 0.5) * cell_x
    ys = y0 + (candidate_rows + 0.5) * cell_y
    return xs.astype(float), ys.astype(float)


def _bilinear_sample(layer: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Sample ``(C,H,W)`` data at a square row/column coordinate mesh."""

    height, width = layer.shape[1:]
    row_grid, col_grid = np.meshgrid(rows, cols, indexing="ij")
    row_grid = np.clip(row_grid, 0, height - 1)
    col_grid = np.clip(col_grid, 0, width - 1)
    row0 = np.floor(row_grid).astype(int)
    col0 = np.floor(col_grid).astype(int)
    row1 = np.minimum(row0 + 1, height - 1)
    col1 = np.minimum(col0 + 1, width - 1)
    row_weight = row_grid - row0
    col_weight = col_grid - col0
    top = layer[:, row0, col0] * (1.0 - col_weight) + layer[:, row0, col1] * col_weight
    bottom = layer[:, row1, col0] * (1.0 - col_weight) + layer[:, row1, col1] * col_weight
    return (top * (1.0 - row_weight) + bottom * row_weight).astype(np.float32)


def _nearest_sample(layer: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Sample categorical or availability channels without inventing fractions."""

    height, width = layer.shape[1:]
    row_grid, col_grid = np.meshgrid(rows, cols, indexing="ij")
    row_indices = np.clip(np.floor(row_grid + 0.5).astype(int), 0, height - 1)
    col_indices = np.clip(np.floor(col_grid + 0.5).astype(int), 0, width - 1)
    return layer[:, row_indices, col_indices].astype(np.float32)


def extract_multiscale_patches(
    channels: np.ndarray,
    grid: GeoGrid,
    x: Sequence[float],
    y: Sequence[float],
    *,
    radii_m: Sequence[float] = (64.0, 256.0, 1024.0),
    output_size: int = 33,
    min_valid_fraction: float = 0.8,
    nearest_channel_indices: Sequence[int] = (),
) -> Tuple[np.ndarray, Dict[str, object]]:
    """Extract physically sized views without pretending resampling adds detail.

    Output is ``(N, scales, channels, output_size, output_size)``. Fine,
    neighborhood, and landscape views therefore share a tensor shape while
    retaining their true native-cell footprint in metadata.
    """

    if channels.ndim != 3 or channels.shape[1:] != grid.values.shape:
        raise ValueError("channels do not align with the supplied grid")
    if output_size < 9 or output_size % 2 == 0:
        raise ValueError("output_size must be an odd integer of at least nine")
    if not 0 < min_valid_fraction <= 1:
        raise ValueError("min_valid_fraction must be in (0, 1]")
    scales = tuple(float(radius) for radius in radii_m)
    if not scales or any(radius <= 0 for radius in scales):
        raise ValueError("radii_m must contain positive values")
    if tuple(sorted(scales)) != scales:
        raise ValueError("radii_m must be strictly nondecreasing")
    nearest = tuple(int(index) for index in nearest_channel_indices)
    if len(set(nearest)) != len(nearest):
        raise ValueError("nearest_channel_indices must be unique")
    if nearest and (min(nearest) < 0 or max(nearest) >= channels.shape[0]):
        raise ValueError("nearest_channel_indices contains an out-of-range channel")
    validate_observation_extent(grid, x, y)
    rows, cols = grid.xy_to_row_col(np.asarray(x), np.asarray(y))
    valid_source = np.all(np.isfinite(channels), axis=0)
    medians = np.nanmedian(channels.reshape(channels.shape[0], -1), axis=1)
    if not np.all(np.isfinite(medians)):
        raise ValueError("every feature channel needs at least one finite value")
    filled = np.where(np.isfinite(channels), channels, medians[:, None, None])
    output = np.empty(
        (len(rows), len(scales), channels.shape[0], output_size, output_size),
        dtype=np.float32,
    )
    valid_fractions = np.empty((len(rows), len(scales)), dtype=np.float32)
    dx, dy = grid.pixel_size
    for example, (center_row, center_col) in enumerate(zip(rows, cols)):
        for scale_index, radius_m in enumerate(scales):
            row_radius = radius_m / dy
            col_radius = radius_m / dx
            sample_rows = np.linspace(center_row - row_radius, center_row + row_radius, output_size)
            sample_cols = np.linspace(center_col - col_radius, center_col + col_radius, output_size)
            output[example, scale_index] = _bilinear_sample(filled, sample_rows, sample_cols)
            if nearest:
                output[example, scale_index, list(nearest)] = _nearest_sample(
                    filled[list(nearest)], sample_rows, sample_cols
                )
            sampled_valid = _bilinear_sample(
                valid_source.astype(np.float32)[None, ...], sample_rows, sample_cols
            )[0]
            valid_fractions[example, scale_index] = float(np.mean(sampled_valid >= 0.999))
    keep = np.all(valid_fractions >= min_valid_fraction, axis=1)
    if not np.any(keep):
        raise ValueError("no patches meet min_valid_fraction at every requested scale")
    audit = {
        "radii_m": list(scales),
        "diameters_m": [2.0 * radius for radius in scales],
        "output_size": output_size,
        "native_pixel_m": [dx, dy],
        "native_cells_across": [
            [2.0 * radius / dx, 2.0 * radius / dy] for radius in scales
        ],
        "requested_centers": int(len(rows)),
        "retained_centers": int(np.sum(keep)),
        "min_valid_fraction": min_valid_fraction,
        "nearest_channel_indices": list(nearest),
        "resampling_warning": (
            "views with fewer native cells than output pixels are interpolated for tensor "
            "alignment only; they contain no additional spatial detail"
        ),
    }
    return output[keep], {**audit, "retained_mask": keep.tolist()}


def save_patch_corpus(
    path: Path,
    patches: np.ndarray,
    x: Sequence[float],
    y: Sequence[float],
    channel_names: Sequence[str],
    metadata: Mapping[str, object],
) -> None:
    if patches.ndim != 5 or patches.shape[0] != len(x) or len(x) != len(y):
        raise ValueError("patch corpus must be (N,S,C,H,W) with matching coordinates")
    if patches.shape[2] != len(channel_names):
        raise ValueError("patch channels do not match channel_names")
    artifact = {
        "schema_version": "1.0",
        "channel_names": list(channel_names),
        "metadata": dict(metadata),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        patches=patches.astype(np.float32),
        x=np.asarray(x, dtype=np.float64),
        y=np.asarray(y, dtype=np.float64),
        metadata=json.dumps(artifact, sort_keys=True),
    )


def load_patch_corpus(
    path: Path,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, Tuple[str, ...], Mapping[str, object]]:
    with np.load(path, allow_pickle=False) as archive:
        patches = archive["patches"].astype(np.float32)
        x = archive["x"].astype(float)
        y = archive["y"].astype(float)
        artifact = json.loads(str(archive["metadata"].item()))
    names = tuple(artifact["channel_names"])
    if patches.ndim != 5 or patches.shape[0] != len(x) or len(x) != len(y):
        raise ValueError("invalid patch corpus dimensions")
    if patches.shape[2] != len(names):
        raise ValueError("patch corpus channel contract is inconsistent")
    return patches, x, y, names, artifact.get("metadata", {})
