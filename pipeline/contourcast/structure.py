"""Resolution-aware seafloor structure features and extensible feature stacks.

The original six terrain channels remain the stable baseline contract.  This
module adds orientation and relief channels that matter for linear structure,
bedforms, scour, and reef edges, plus explicit source-resolution diagnostics.
Nothing in this module infers detail finer than the source grid.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Mapping, Sequence, Tuple

import numpy as np

from .geo import GeoGrid, validate_alignment
from .terrain import TERRAIN_CHANNELS, derive_terrain_channels


STRUCTURE_CHANNELS: Tuple[str, ...] = TERRAIN_CHANNELS + (
    "local_relief_m",
    "rugosity_ratio",
    "aspect_sin",
    "aspect_cos",
)


def _window_extreme(values: np.ndarray, radius: int, reducer: str) -> np.ndarray:
    if radius < 1:
        raise ValueError("window radius must be positive")
    padded = np.pad(values, radius, mode="edge")
    height, width = values.shape
    layers = [
        padded[row : row + height, col : col + width]
        for row in range(2 * radius + 1)
        for col in range(2 * radius + 1)
    ]
    stack = np.stack(layers)
    if reducer == "min":
        return np.min(stack, axis=0)
    if reducer == "max":
        return np.max(stack, axis=0)
    raise ValueError("reducer must be 'min' or 'max'")


def audit_feature_resolution(
    grid: GeoGrid,
    *,
    horizontal_accuracy_m: float | None = None,
    candidate_widths_m: Sequence[float] = (1, 2, 5, 10, 20, 50, 100),
) -> Dict[str, object]:
    """Classify feature widths against the grid's real resolving power.

    Two cells is a marginal sampling threshold. Three cells is the conservative
    threshold used by ContourCast for a repeatable structure claim. Published
    horizontal accuracy, when supplied, can only make those thresholds larger.
    """

    dx, dy = grid.pixel_size
    native_pixel_m = float(max(dx, dy))
    if horizontal_accuracy_m is not None and horizontal_accuracy_m <= 0:
        raise ValueError("horizontal_accuracy_m must be positive")
    accuracy_floor = float(horizontal_accuracy_m or 0.0)
    marginal_m = max(2.0 * native_pixel_m, accuracy_floor)
    conservative_m = max(3.0 * native_pixel_m, accuracy_floor)
    classifications = []
    for width in candidate_widths_m:
        width = float(width)
        if width <= 0:
            raise ValueError("candidate feature widths must be positive")
        if width >= conservative_m:
            status = "resolvable"
        elif width >= marginal_m:
            status = "marginal"
        else:
            status = "unresolved"
        classifications.append(
            {
                "feature_width_m": width,
                "native_cells_across": width / native_pixel_m,
                "status": status,
            }
        )
    return {
        "native_pixel_m": native_pixel_m,
        "published_horizontal_accuracy_m": horizontal_accuracy_m,
        "marginal_feature_width_m": marginal_m,
        "conservative_feature_width_m": conservative_m,
        "feature_classifications": classifications,
        "interpretation": (
            "resolvable means at least three native cells (and no smaller than published "
            "horizontal accuracy); resampling never upgrades this classification"
        ),
    }


def derive_structure_channels(
    grid: GeoGrid,
    *,
    local_radius: int = 2,
    broad_radius: int = 6,
    relief_radius: int = 3,
    horizontal_accuracy_m: float | None = None,
) -> Tuple[np.ndarray, Dict[str, object]]:
    """Return ten structure channels from a positive-up bathymetry grid."""

    core, core_metadata = derive_terrain_channels(
        grid, local_radius=local_radius, broad_radius=broad_radius
    )
    valid = grid.valid_mask
    elevation = grid.values.astype(np.float64, copy=True)
    fill = float(np.nanmedian(elevation[valid]))
    elevation[~valid] = fill
    depth = np.maximum(-elevation, 0.0)
    dx, dy = grid.pixel_size
    dz_dy, dz_dx = np.gradient(elevation, dy, dx)

    local_min = _window_extreme(depth, relief_radius, "min")
    local_max = _window_extreme(depth, relief_radius, "max")
    local_relief = local_max - local_min

    # Surface-area ratio is one for a flat cell and increases with gradient.
    rugosity = np.sqrt(1.0 + np.square(dz_dx) + np.square(dz_dy))
    gradient = np.hypot(dz_dx, dz_dy)
    safe_gradient = np.where(gradient > 1e-12, gradient, 1.0)
    aspect_sin = np.where(gradient > 1e-12, dz_dy / safe_gradient, 0.0)
    aspect_cos = np.where(gradient > 1e-12, dz_dx / safe_gradient, 0.0)

    extra = np.stack([local_relief, rugosity, aspect_sin, aspect_cos]).astype(np.float32)
    extra[:, ~valid] = np.nan
    channels = np.concatenate([core, extra], axis=0)
    metadata: Dict[str, object] = {
        **core_metadata,
        "channels": list(STRUCTURE_CHANNELS),
        "channel_count": len(STRUCTURE_CHANNELS),
        "relief_radius_cells": relief_radius,
        "aspect_convention": (
            "sin/cos of the positive-up elevation gradient in projected grid axes; "
            "flat cells are zero"
        ),
        "resolution_audit": audit_feature_resolution(
            grid, horizontal_accuracy_m=horizontal_accuracy_m
        ),
    }
    return channels, metadata


def append_aligned_layers(
    channels: np.ndarray,
    channel_names: Sequence[str],
    reference: GeoGrid,
    layers: Mapping[str, GeoGrid],
) -> Tuple[np.ndarray, Tuple[str, ...], Dict[str, object]]:
    """Append aligned backscatter/character/quality rasters with missing masks.

    Each auxiliary value layer is followed by an availability channel. Missing
    values are median-filled only after the mask is captured, allowing the model
    to distinguish measured structure from coverage gaps.
    """

    if channels.ndim != 3 or channels.shape[0] != len(channel_names):
        raise ValueError("channels and channel_names do not align")
    if channels.shape[1:] != reference.values.shape:
        raise ValueError("feature channels do not align with the reference grid")
    output = [channels.astype(np.float32, copy=False)]
    names = list(channel_names)
    layer_metadata: Dict[str, object] = {}
    for name, layer in layers.items():
        if not name or "__available" in name:
            raise ValueError("auxiliary layer names must be nonempty and reserved-suffix free")
        validate_alignment(reference, layer)
        valid = layer.valid_mask
        if not np.any(valid):
            raise ValueError(f"auxiliary layer {name!r} contains no valid values")
        median = float(np.nanmedian(layer.values[valid]))
        values = np.where(valid, layer.values, median).astype(np.float32)
        availability = valid.astype(np.float32)
        output.extend([values[None, ...], availability[None, ...]])
        names.extend([name, f"{name}__available"])
        layer_metadata[name] = {
            "source_id": layer.source_id,
            "valid_fraction": float(np.mean(valid)),
            "fill_value": median,
            "missingness_channel": f"{name}__available",
        }
    return np.concatenate(output, axis=0), tuple(names), layer_metadata


def save_feature_stack(
    path: Path,
    channels: np.ndarray,
    grid: GeoGrid,
    channel_names: Sequence[str],
    metadata: Mapping[str, object],
) -> None:
    if channels.ndim != 3 or channels.shape[0] != len(channel_names):
        raise ValueError("feature stack and channel names do not align")
    if channels.shape[1:] != grid.values.shape:
        raise ValueError("feature stack and reference grid do not align")
    artifact = {
        "schema_version": "2.0",
        "crs": grid.crs,
        "transform": list(grid.transform),
        "vertical_datum": grid.vertical_datum,
        "horizontal_units": grid.horizontal_units,
        "nodata": grid.nodata,
        "source_id": grid.source_id,
        "channel_names": list(channel_names),
        "feature_metadata": dict(metadata),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, values=channels, metadata=json.dumps(artifact, sort_keys=True))


def load_feature_stack(path: Path) -> Tuple[np.ndarray, GeoGrid, Tuple[str, ...], Mapping[str, object]]:
    with np.load(path, allow_pickle=False) as archive:
        channels = archive["values"].astype(np.float32)
        metadata = json.loads(str(archive["metadata"].item()))
    names = tuple(metadata["channel_names"])
    if channels.ndim != 3 or channels.shape[0] != len(names):
        raise ValueError("feature artifact channel order does not match its values")
    reference = GeoGrid(
        values=channels[0],
        crs=metadata["crs"],
        transform=tuple(metadata["transform"]),
        vertical_datum=metadata["vertical_datum"],
        horizontal_units=metadata.get("horizontal_units", "metre"),
        nodata=metadata.get("nodata"),
        source_id=metadata.get("source_id", "unknown"),
    )
    return channels, reference, names, metadata.get("feature_metadata", {})
