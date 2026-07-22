"""Component-held-out probe for rare mapped anthropogenic seafloor structure."""

from __future__ import annotations

import json
from contextlib import ExitStack
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import f1_score

from .geo import GeoGrid, verify_projected_crs
from .habitat_probe import _fit_probe
from .hybrid_probe import (
    HYBRID_PROBE_SCHEMA_VERSION,
    _declared_feature_sets,
    _load_hybrid_checkpoint,
)
from .metadata import build_run_record, sha256_file, verify_run_record_integrity, write_json
from .patches import extract_multiscale_patches, load_patch_corpus
from .sources import assert_source_operation, get_source_manifest
from .structure import STRUCTURE_CHANNELS, derive_structure_channels
from .training import HYBRID_BACKSCATTER_PREFIX, HYBRID_PRETRAINING_MODALITIES

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    TAXON_CATALOG_VERSION,
    target_scope,
)


RARE_CORPUS_SCHEMA_VERSION = "castingcompass.rare-structure-corpus/1.0.0"
RARE_PROBE_SCHEMA_VERSION = "castingcompass.rare-structure-probe/1.0.0"
RARE_CLASS_NAMES: Tuple[str, ...] = (
    "natural_control",
    "smooth_anthropogenic",
    "rugged_anthropogenic",
)


def _take_component_diverse(
    indices: np.ndarray,
    component_ids: np.ndarray,
    limit: int,
    *,
    seed: int,
) -> np.ndarray:
    """Round-robin components before taking extra within-component centers."""

    if limit < 1 or len(indices) < limit:
        raise ValueError("component-diverse sample has insufficient candidates")
    generator = np.random.default_rng(seed)
    groups: Dict[str, list[int]] = {}
    for index in indices:
        groups.setdefault(str(component_ids[index]), []).append(int(index))
    order = sorted(groups)
    generator.shuffle(order)
    for values in groups.values():
        generator.shuffle(values)
    selected: list[int] = []
    while len(selected) < limit:
        advanced = False
        for group in order:
            values = groups[group]
            if values:
                selected.append(values.pop())
                advanced = True
                if len(selected) == limit:
                    break
        if not advanced:
            raise ValueError("component-diverse sample exhausted before its declared size")
    return np.asarray(sorted(selected), dtype=np.int64)


def _label_candidates(
    label_raster_path: Path,
    *,
    expected_sha256: str | None,
    samples_per_class: int,
    candidate_multiplier: float,
    spacing_m: float,
    minimum_resolvable_cells: int,
    control_min_distance_m: float,
    control_max_distance_m: float,
    seed: int,
) -> Mapping[str, Any]:
    """Select label-only candidates before any model feature is inspected."""

    if samples_per_class < 16:
        raise ValueError("rare probe needs at least sixteen requested rows per class")
    if candidate_multiplier < 1:
        raise ValueError("candidate_multiplier must be at least one")
    if spacing_m <= 0 or minimum_resolvable_cells < 3:
        raise ValueError("rare probe spacing/resolution contract is invalid")
    if not 0 < control_min_distance_m < control_max_distance_m:
        raise ValueError("natural-control distance interval is invalid")
    actual_sha256 = sha256_file(label_raster_path)
    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise ValueError("rare-structure label raster checksum mismatch")
    try:
        import rasterio
        from scipy import ndimage
    except ImportError as error:
        raise RuntimeError("rare-structure sampling requires rasterio and scipy") from error

    candidate_target = int(np.ceil(samples_per_class * candidate_multiplier))
    with rasterio.open(label_raster_path) as dataset:
        if dataset.count != 1 or not dataset.crs:
            raise ValueError("rare-structure labels need one band and an explicit CRS")
        transform = dataset.transform
        if not np.isclose(transform.b, 0) or not np.isclose(transform.d, 0):
            raise ValueError("rare-structure label raster must be north-up")
        dx, dy = float(abs(transform.a)), float(abs(transform.e))
        if dx <= 0 or dy <= 0:
            raise ValueError("rare-structure label raster pixel size is invalid")
        raw = dataset.read(1)
        substrate = np.where(raw > 0, np.mod(raw, 10), 0).astype(np.int8)
        rare_mask = np.isin(substrate, (5, 6))
        rare_rows, rare_cols = np.nonzero(rare_mask)
        if not len(rare_rows):
            raise ValueError("rare-structure label raster contains no anthropogenic classes")
        row_min, row_max = int(rare_rows.min()), int(rare_rows.max()) + 1
        col_min, col_max = int(rare_cols.min()), int(rare_cols.max()) + 1
        substrate_crop = substrate[row_min:row_max, col_min:col_max]
        spacing_cells = max(1, int(np.ceil(spacing_m / min(dx, dy))))
        resolution_radius = minimum_resolvable_cells / 2.0

        rows_parts: list[np.ndarray] = []
        cols_parts: list[np.ndarray] = []
        labels_parts: list[np.ndarray] = []
        components_parts: list[np.ndarray] = []
        component_summary: Dict[str, Any] = {}
        for class_label, substrate_code in ((1, 5), (2, 6)):
            mask = substrate_crop == substrate_code
            components, component_count = ndimage.label(
                mask,
                structure=np.ones((3, 3), dtype=np.int8),
            )
            interior = ndimage.distance_transform_edt(mask) >= resolution_radius
            local_rows, local_cols = np.nonzero(interior)
            if not len(local_rows):
                raise ValueError(f"substrate code {substrate_code} has no resolvable centers")
            global_rows = local_rows + row_min
            global_cols = local_cols + col_min
            component_values = components[local_rows, local_cols]
            grid_keys = np.column_stack(
                [global_rows // spacing_cells, global_cols // spacing_cells]
            )
            generator = np.random.default_rng(seed + substrate_code)
            permutation = generator.permutation(len(global_rows))
            _, first = np.unique(grid_keys[permutation], axis=0, return_index=True)
            spaced = permutation[np.sort(first)]
            global_rows = global_rows[spaced]
            global_cols = global_cols[spaced]
            component_values = component_values[spaced]
            component_ids = np.asarray(
                [f"substrate-{substrate_code}-component-{int(value)}" for value in component_values]
            )
            local_indices = np.arange(len(global_rows), dtype=np.int64)
            selected = _take_component_diverse(
                local_indices,
                component_ids,
                candidate_target,
                seed=seed + 100 + substrate_code,
            )
            rows_parts.append(global_rows[selected])
            cols_parts.append(global_cols[selected])
            labels_parts.append(np.full(len(selected), class_label, dtype=np.int64))
            components_parts.append(component_ids[selected])
            component_summary[str(substrate_code)] = {
                "all_connected_components": int(component_count),
                "resolvable_components": int(len(np.unique(component_values))),
                "spaced_resolvable_candidates": int(len(global_rows)),
                "candidate_rows": int(len(selected)),
            }

        rare_selected_rows = np.concatenate(rows_parts)
        rare_selected_cols = np.concatenate(cols_parts)
        rare_selected_labels = np.concatenate(labels_parts)
        rare_selected_components = np.concatenate(components_parts)

        margin = int(np.ceil(control_max_distance_m / min(dx, dy))) + 2
        ext_row_min = max(0, row_min - margin)
        ext_row_max = min(dataset.height, row_max + margin)
        ext_col_min = max(0, col_min - margin)
        ext_col_max = min(dataset.width, col_max + margin)
        ext_rare = rare_mask[ext_row_min:ext_row_max, ext_col_min:ext_col_max]
        natural_distance = ndimage.distance_transform_edt(~ext_rare)
        min_row_offset = int(np.ceil(control_min_distance_m / dy))
        max_row_offset = int(np.ceil(control_max_distance_m / dy))
        min_col_offset = int(np.ceil(control_min_distance_m / dx))
        max_col_offset = int(np.ceil(control_max_distance_m / dx))
        offsets = []
        for row_offset in range(-max_row_offset, max_row_offset + 1):
            for col_offset in range(-max_col_offset, max_col_offset + 1):
                distance = np.hypot(row_offset * dy, col_offset * dx)
                if control_min_distance_m <= distance <= control_max_distance_m:
                    offsets.append((row_offset, col_offset))
        if not offsets or min_row_offset < 1 or min_col_offset < 1:
            raise ValueError("natural-control annulus produced no pixel offsets")
        generator = np.random.default_rng(seed + 500)
        generator.shuffle(offsets)
        anchor_order = generator.permutation(len(rare_selected_rows))
        control_rows: list[int] = []
        control_cols: list[int] = []
        control_components: list[str] = []
        occupied_control_cells: set[Tuple[int, int]] = set()
        for anchor_index in anchor_order:
            anchor_row = int(rare_selected_rows[anchor_index])
            anchor_col = int(rare_selected_cols[anchor_index])
            for row_offset, col_offset in offsets:
                row = anchor_row + row_offset
                col = anchor_col + col_offset
                if not (0 <= row < dataset.height and 0 <= col < dataset.width):
                    continue
                if not (1 <= int(substrate[row, col]) <= 4):
                    continue
                ext_row = row - ext_row_min
                ext_col = col - ext_col_min
                if not (
                    0 <= ext_row < natural_distance.shape[0]
                    and 0 <= ext_col < natural_distance.shape[1]
                    and natural_distance[ext_row, ext_col] >= resolution_radius
                ):
                    continue
                cell = (row // spacing_cells, col // spacing_cells)
                if cell in occupied_control_cells:
                    continue
                occupied_control_cells.add(cell)
                control_rows.append(row)
                control_cols.append(col)
                control_components.append(str(rare_selected_components[anchor_index]))
                break
            if len(control_rows) == candidate_target:
                break
        if len(control_rows) != candidate_target:
            raise ValueError("could not construct enough nearby natural controls")

        all_rows = np.concatenate(
            [np.asarray(control_rows, dtype=np.int64), rare_selected_rows]
        )
        all_cols = np.concatenate(
            [np.asarray(control_cols, dtype=np.int64), rare_selected_cols]
        )
        all_labels = np.concatenate(
            [np.zeros(candidate_target, dtype=np.int64), rare_selected_labels]
        )
        all_components = np.concatenate(
            [np.asarray(control_components), rare_selected_components]
        )
        x, y = rasterio.transform.xy(transform, all_rows, all_cols, offset="center")
        raw_values, raw_counts = np.unique(raw, return_counts=True)
        metadata = {
            "label_raster_sha256": actual_sha256,
            "label_crs": dataset.crs.to_string(),
            "label_bounds": list(dataset.bounds),
            "label_shape": [dataset.height, dataset.width],
            "label_nodata": dataset.nodata,
            "raw_value_counts": {
                str(int(value)): int(count)
                for value, count in zip(raw_values, raw_counts)
            },
            "full_raster_substrate_counts": {
                str(code): int(np.sum(substrate == code)) for code in range(1, 7)
            },
            "components": component_summary,
            "sampling": {
                "candidate_rows_per_class": candidate_target,
                "requested_final_rows_per_class": samples_per_class,
                "candidate_multiplier": candidate_multiplier,
                "minimum_resolvable_cells": minimum_resolvable_cells,
                "minimum_resolvable_width_m": minimum_resolvable_cells * min(dx, dy),
                "center_spacing_m": spacing_m,
                "natural_control_annulus_m": [
                    control_min_distance_m,
                    control_max_distance_m,
                ],
                "labels_used_only_for_sampling_and_probe_target": True,
                "seed": seed,
            },
        }
    return {
        "x": np.asarray(x, dtype=float),
        "y": np.asarray(y, dtype=float),
        "labels": all_labels,
        "component_ids": all_components,
        "metadata": metadata,
    }


def _extract_hybrid_patches_at_coordinates(
    source_path: Path,
    x: np.ndarray,
    y: np.ndarray,
    *,
    source_id: str,
    vertical_datum: str,
    aligned_layer_paths: Mapping[str, Path],
    radii_m: Sequence[float],
    output_size: int,
    min_valid_fraction: float,
    min_aligned_valid_fraction: float,
    local_radius: int,
    broad_radius: int,
    relief_radius: int,
    horizontal_accuracy_m: float | None,
    tile_size: int,
) -> Tuple[np.ndarray, np.ndarray, Tuple[str, ...], Mapping[str, Any]]:
    """Apply the pretraining feature derivation at caller-frozen probe centers."""

    if len(x) != len(y) or len(x) < 2:
        raise ValueError("targeted probe coordinates are inconsistent")
    if tile_size < 128 or not 0 <= min_aligned_valid_fraction <= 1:
        raise ValueError("targeted patch extraction configuration is invalid")
    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.warp import reproject
        from rasterio.windows import Window
    except ImportError as error:
        raise RuntimeError("rare-structure patch extraction requires rasterio") from error

    radii = tuple(float(radius) for radius in radii_m)
    with ExitStack() as stack:
        dataset = stack.enter_context(rasterio.open(source_path))
        if dataset.count != 1 or not dataset.crs:
            raise ValueError("bathymetry GeoTIFF needs one band and an explicit CRS")
        crs = dataset.crs.to_string()
        verify_projected_crs(crs)
        transform = dataset.transform
        if not np.isclose(transform.b, 0) or not np.isclose(transform.d, 0):
            raise ValueError("bathymetry GeoTIFF must be north-up")
        dx, dy = float(transform.a), float(abs(transform.e))
        rows, cols = rasterio.transform.rowcol(transform, x, y)
        rows = np.asarray(rows, dtype=np.int64)
        cols = np.asarray(cols, dtype=np.int64)
        inside = (
            (rows >= 0)
            & (rows < dataset.height)
            & (cols >= 0)
            & (cols < dataset.width)
        )
        if not np.all(inside):
            raise ValueError("rare-structure coordinates fall outside bathymetry coverage")
        aligned_datasets = {
            name: stack.enter_context(rasterio.open(path))
            for name, path in aligned_layer_paths.items()
        }
        for name, aligned in aligned_datasets.items():
            if aligned.count != 1 or not aligned.crs:
                raise ValueError(f"aligned layer {name!r} lacks one band or CRS")
        largest_radius_cells = int(np.ceil(max(radii) / min(dx, dy)))
        halo = largest_radius_cells + max(broad_radius, relief_radius) + 2
        tile_keys = np.column_stack([rows // tile_size, cols // tile_size])
        unique_keys = np.unique(tile_keys, axis=0)
        patches_parts: list[np.ndarray] = []
        index_parts: list[np.ndarray] = []
        channel_names: Tuple[str, ...] = STRUCTURE_CHANNELS
        derivation_metadata: Mapping[str, Any] | None = None
        for tile_row, tile_col in unique_keys:
            source_indices = np.flatnonzero(
                (tile_keys[:, 0] == tile_row) & (tile_keys[:, 1] == tile_col)
            )
            inner_row = int(tile_row * tile_size)
            inner_col = int(tile_col * tile_size)
            inner_height = min(tile_size, dataset.height - inner_row)
            inner_width = min(tile_size, dataset.width - inner_col)
            window = Window(
                inner_col - halo,
                inner_row - halo,
                inner_width + 2 * halo,
                inner_height + 2 * halo,
            )
            nodata = dataset.nodata
            elevation = dataset.read(
                1,
                window=window,
                boundless=True,
                fill_value=nodata if nodata is not None else np.nan,
            )
            window_transform = dataset.window_transform(window)
            grid = GeoGrid(
                values=elevation,
                crs=crs,
                transform=(
                    window_transform.c,
                    window_transform.a,
                    window_transform.b,
                    window_transform.f,
                    window_transform.d,
                    window_transform.e,
                ),
                vertical_datum=vertical_datum,
                nodata=nodata,
                source_id=source_id,
            )
            channels, derivation_metadata = derive_structure_channels(
                grid,
                local_radius=local_radius,
                broad_radius=broad_radius,
                relief_radius=relief_radius,
                horizontal_accuracy_m=horizontal_accuracy_m,
            )
            tile_names = STRUCTURE_CHANNELS
            for name, aligned in aligned_datasets.items():
                layer_nodata = aligned.nodata
                layer_fill = layer_nodata if layer_nodata is not None else 0
                layer_values = np.full(
                    (int(window.height), int(window.width)),
                    layer_fill,
                    dtype=aligned.dtypes[0],
                )
                reproject(
                    source=rasterio.band(aligned, 1),
                    destination=layer_values,
                    src_transform=aligned.transform,
                    src_crs=aligned.crs,
                    src_nodata=layer_nodata,
                    dst_transform=window_transform,
                    dst_crs=dataset.crs,
                    dst_nodata=layer_fill,
                    resampling=Resampling.nearest,
                )
                valid = np.isfinite(layer_values)
                if layer_nodata is not None and np.isfinite(layer_nodata):
                    valid &= ~np.isclose(layer_values, layer_nodata)
                fill = float(np.median(layer_values[valid])) if np.any(valid) else 0.0
                channels = np.concatenate(
                    [
                        channels,
                        np.where(valid, layer_values, fill).astype(np.float32)[None, ...],
                        valid.astype(np.float32)[None, ...],
                    ],
                    axis=0,
                )
                tile_names = tile_names + (name, f"{name}__available")
            tile_x = x[source_indices]
            tile_y = y[source_indices]
            try:
                patches, audit = extract_multiscale_patches(
                    channels,
                    grid,
                    tile_x,
                    tile_y,
                    radii_m=radii,
                    output_size=output_size,
                    min_valid_fraction=min_valid_fraction,
                    nearest_channel_indices=tuple(
                        index for index, name in enumerate(tile_names) if name.endswith("__available")
                    ),
                )
            except ValueError as error:
                if "no patches meet min_valid_fraction" in str(error):
                    continue
                raise
            retained = np.flatnonzero(np.asarray(audit["retained_mask"], dtype=bool))
            kept_source_indices = source_indices[retained]
            if aligned_datasets and min_aligned_valid_fraction > 0:
                availability = tuple(
                    index for index, name in enumerate(tile_names) if name.endswith("__available")
                )
                union = np.max(patches[:, :, availability], axis=2)
                aligned_keep = np.all(
                    np.mean(union, axis=(2, 3)) >= min_aligned_valid_fraction,
                    axis=1,
                )
                patches = patches[aligned_keep]
                kept_source_indices = kept_source_indices[aligned_keep]
            if len(patches):
                patches_parts.append(patches)
                index_parts.append(kept_source_indices)
                channel_names = tile_names
        if not patches_parts or derivation_metadata is None:
            raise ValueError("no rare-structure patches passed the coverage contract")
        patches = np.concatenate(patches_parts)
        retained_indices = np.concatenate(index_parts)
        order = np.argsort(retained_indices)
        patches = patches[order]
        retained_indices = retained_indices[order]
        metadata = {
            "crs": crs,
            "vertical_datum": vertical_datum,
            "feature_metadata": dict(derivation_metadata),
            "patch_design": {
                "radii_m": list(radii),
                "diameters_m": [2 * radius for radius in radii],
                "output_size": output_size,
                "min_valid_fraction": min_valid_fraction,
                "min_aligned_valid_fraction": min_aligned_valid_fraction,
                "tile_size_cells": tile_size,
                "halo_cells": halo,
            },
        }
    return patches, retained_indices, channel_names, metadata


def _component_folds(
    x: np.ndarray,
    y: np.ndarray,
    labels: np.ndarray,
    component_ids: np.ndarray,
    *,
    split_regions: int,
    seed: int,
) -> Tuple[np.ndarray, int, Mapping[str, Any]]:
    """Cluster component centroids so a mapped feature never crosses a split."""

    groups = np.unique(component_ids)
    if len(groups) < split_regions:
        raise ValueError("rare probe has too few components for requested folds")
    centroid = np.asarray(
        [
            [float(np.mean(x[component_ids == group])), float(np.mean(y[component_ids == group]))]
            for group in groups
        ]
    )
    scale = np.std(centroid, axis=0)
    scale[scale == 0] = 1.0
    group_fold = KMeans(
        n_clusters=split_regions,
        random_state=seed,
        n_init=20,
    ).fit_predict((centroid - np.mean(centroid, axis=0)) / scale)
    fold_lookup = {str(group): int(fold) for group, fold in zip(groups, group_fold)}
    row_fold = np.asarray([fold_lookup[str(group)] for group in component_ids], dtype=np.int64)
    fold_summary: Dict[str, Any] = {}
    candidate_folds = []
    for fold in range(split_regions):
        test = row_fold == fold
        train = ~test
        test_counts = np.bincount(labels[test], minlength=len(RARE_CLASS_NAMES))
        train_counts = np.bincount(labels[train], minlength=len(RARE_CLASS_NAMES))
        component_counts = []
        for class_label in (1, 2):
            class_groups = {
                str(group)
                for group in component_ids[test & (labels == class_label)]
            }
            component_counts.append(len(class_groups))
        eligible = bool(
            np.all(test_counts > 0)
            and np.all(train_counts > 0)
            and min(component_counts) >= 2
        )
        fold_summary[str(fold)] = {
            "train_class_counts": train_counts.tolist(),
            "test_class_counts": test_counts.tolist(),
            "test_rare_component_counts": component_counts,
            "eligible": eligible,
        }
        if eligible:
            candidate_folds.append(
                (min(component_counts), int(np.min(test_counts)), -fold, fold)
            )
    if not candidate_folds:
        raise ValueError("no component-held-out fold contains every rare-probe class")
    selected_fold = max(candidate_folds)[-1]
    return row_fold, selected_fold, fold_summary


def build_rare_structure_corpus(
    source_path: Path,
    label_raster_path: Path,
    output_path: Path,
    *,
    source_id: str,
    vertical_datum: str,
    aligned_layer_paths: Mapping[str, Path],
    expected_source_sha256: str | None = None,
    aligned_layer_expected_sha256: Mapping[str, str] | None = None,
    label_raster_sha256: str | None = None,
    samples_per_class: int = 64,
    candidate_multiplier: float = 1.75,
    spacing_m: float = 8.0,
    minimum_resolvable_cells: int = 3,
    control_min_distance_m: float = 16.0,
    control_max_distance_m: float = 128.0,
    radii_m: Sequence[float] = (32.0, 128.0, 512.0),
    output_size: int = 33,
    min_valid_fraction: float = 0.8,
    min_aligned_valid_fraction: float = 0.5,
    local_radius: int = 4,
    broad_radius: int = 24,
    relief_radius: int = 8,
    horizontal_accuracy_m: float | None = 2.0,
    tile_size: int = 1024,
    split_regions: int = 3,
    seed: int = 42,
) -> Mapping[str, Any]:
    """Build a case-control corpus with component-level geographic folds."""

    assert_source_operation(source_id, "terrain-pretraining")
    manifest = get_source_manifest(source_id)
    source_sha256 = sha256_file(source_path)
    if expected_source_sha256 and expected_source_sha256.lower() != source_sha256:
        raise ValueError("rare probe bathymetry checksum mismatch")
    aligned_hashes = dict(aligned_layer_expected_sha256 or {})
    if set(aligned_hashes) - set(aligned_layer_paths):
        raise ValueError("rare probe has a checksum for an undeclared aligned layer")
    for name, path in aligned_layer_paths.items():
        if not name.startswith(HYBRID_BACKSCATTER_PREFIX) or name.endswith("__available"):
            raise ValueError("rare probe aligned layer name is invalid")
        actual = sha256_file(path)
        if name in aligned_hashes and aligned_hashes[name].lower() != actual:
            raise ValueError(f"rare probe aligned layer {name!r} checksum mismatch")
        aligned_hashes[name] = actual
    candidates = _label_candidates(
        label_raster_path,
        expected_sha256=label_raster_sha256,
        samples_per_class=samples_per_class,
        candidate_multiplier=candidate_multiplier,
        spacing_m=spacing_m,
        minimum_resolvable_cells=minimum_resolvable_cells,
        control_min_distance_m=control_min_distance_m,
        control_max_distance_m=control_max_distance_m,
        seed=seed,
    )
    try:
        import rasterio
        from pyproj import Transformer
    except ImportError as error:
        raise RuntimeError("rare-structure corpus building requires rasterio and pyproj") from error
    with rasterio.open(label_raster_path) as labels_dataset, rasterio.open(source_path) as source:
        transformer = Transformer.from_crs(
            labels_dataset.crs,
            source.crs,
            always_xy=True,
        )
        source_x, source_y = transformer.transform(candidates["x"], candidates["y"])
    source_x = np.asarray(source_x, dtype=float)
    source_y = np.asarray(source_y, dtype=float)
    patches, retained, channel_names, patch_metadata = _extract_hybrid_patches_at_coordinates(
        source_path,
        source_x,
        source_y,
        source_id=source_id,
        vertical_datum=vertical_datum,
        aligned_layer_paths=aligned_layer_paths,
        radii_m=radii_m,
        output_size=output_size,
        min_valid_fraction=min_valid_fraction,
        min_aligned_valid_fraction=min_aligned_valid_fraction,
        local_radius=local_radius,
        broad_radius=broad_radius,
        relief_radius=relief_radius,
        horizontal_accuracy_m=horizontal_accuracy_m,
        tile_size=tile_size,
    )
    source_x = source_x[retained]
    source_y = source_y[retained]
    labels = np.asarray(candidates["labels"], dtype=np.int64)[retained]
    components = np.asarray(candidates["component_ids"])[retained]
    selected_parts = []
    retained_rare_components: set[str] = set()
    for class_label in (1, 2):
        class_indices = np.flatnonzero(labels == class_label)
        class_selected = _take_component_diverse(
            class_indices,
            components,
            samples_per_class,
            seed=seed + 700 + class_label,
        )
        selected_parts.append(class_selected)
        retained_rare_components.update(str(value) for value in components[class_selected])
    natural_indices = np.asarray(
        [
            index
            for index in np.flatnonzero(labels == 0)
            if str(components[index]) in retained_rare_components
        ],
        dtype=np.int64,
    )
    selected_parts.append(
        _take_component_diverse(
            natural_indices,
            components,
            samples_per_class,
            seed=seed + 700,
        )
    )
    selected = np.sort(np.concatenate(selected_parts))
    patches = patches[selected]
    source_x = source_x[selected]
    source_y = source_y[selected]
    labels = labels[selected]
    components = components[selected]
    row_fold, selected_fold, fold_summary = _component_folds(
        source_x,
        source_y,
        labels,
        components,
        split_regions=split_regions,
        seed=seed,
    )
    aligned_metadata = {
        name: {
            "source_id": source_id,
            "source_path": str(path.resolve()),
            "source_sha256": aligned_hashes[name],
            "missingness_channel": f"{name}__available",
            "valid_fraction": float(
                np.mean(patches[:, :, channel_names.index(f"{name}__available")])
            ),
            "resampling": "nearest onto the exact bathymetry reference grid",
            "overlap_policy": "survey channels remain separate; no blending or priority fill",
        }
        for name, path in aligned_layer_paths.items()
    }
    feature_metadata = dict(patch_metadata["feature_metadata"])
    feature_metadata["aligned_layers"] = aligned_metadata
    corpus_metadata = {
        "schema_version": RARE_CORPUS_SCHEMA_VERSION,
        "source_id": source_id,
        "source_title": manifest["title"],
        "source_path": str(source_path.resolve()),
        "source_sha256": source_sha256,
        "official_landing_page": manifest["official_landing_page"],
        "crs": patch_metadata["crs"],
        "vertical_datum": vertical_datum,
        "feature_metadata": feature_metadata,
        "patch_design": patch_metadata["patch_design"],
        "label_metadata": candidates["metadata"],
        "class_names": list(RARE_CLASS_NAMES),
        "class_counts": np.bincount(labels, minlength=len(RARE_CLASS_NAMES)).tolist(),
        "component_holdout": {
            "split_regions": split_regions,
            "seed": seed,
            "selected_validation_fold": selected_fold,
            "folds": fold_summary,
            "whole_connected_components_held_out": True,
            "selection_used_labels_and_coordinates_only": True,
        },
        "claim_boundary": (
            "This is an intentionally class-balanced, label-guided case-control corpus. "
            "It cannot estimate natural prevalence, population accuracy, habitat quality, "
            "fishing skill, or catch probability."
        ),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        output_path,
        patches=patches.astype(np.float32),
        x=source_x.astype(np.float64),
        y=source_y.astype(np.float64),
        labels=labels,
        component_ids=components,
        geographic_fold=row_fold,
        channel_names=np.asarray(channel_names),
        metadata=json.dumps(corpus_metadata, sort_keys=True, separators=(",", ":")),
    )
    report = {
        "status": "completed",
        "schema_version": RARE_CORPUS_SCHEMA_VERSION,
        "output_path": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "rows": int(len(labels)),
        "class_counts": corpus_metadata["class_counts"],
        "components": int(len(np.unique(components))),
        "selected_validation_fold": selected_fold,
        "claim_boundary": corpus_metadata["claim_boundary"],
    }
    write_json(output_path.with_suffix(".provenance.json"), report)
    return report


def _load_rare_corpus(
    path: Path,
) -> Tuple[
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    Tuple[str, ...],
    Mapping[str, Any],
]:
    with np.load(path, allow_pickle=False) as archive:
        required = {
            "patches",
            "x",
            "y",
            "labels",
            "component_ids",
            "geographic_fold",
            "channel_names",
            "metadata",
        }
        if set(archive.files) != required:
            raise ValueError("rare-structure corpus members are invalid")
        patches = archive["patches"].astype(np.float32)
        x = archive["x"].astype(float)
        y = archive["y"].astype(float)
        labels = archive["labels"].astype(np.int64)
        components = archive["component_ids"].astype(str)
        folds = archive["geographic_fold"].astype(np.int64)
        channel_names = tuple(str(value) for value in archive["channel_names"])
        metadata = json.loads(str(archive["metadata"].item()))
    rows = len(x)
    if (
        patches.ndim != 5
        or patches.shape[0] != rows
        or any(len(values) != rows for values in (y, labels, components, folds))
        or patches.shape[2] != len(channel_names)
    ):
        raise ValueError("rare-structure corpus dimensions are inconsistent")
    if metadata.get("schema_version") != RARE_CORPUS_SCHEMA_VERSION:
        raise ValueError("rare-structure corpus schema is unsupported")
    if tuple(metadata.get("class_names", ())) != RARE_CLASS_NAMES:
        raise ValueError("rare-structure corpus class contract differs")
    if not np.array_equal(
        np.bincount(labels, minlength=len(RARE_CLASS_NAMES)),
        np.asarray(metadata.get("class_counts")),
    ):
        raise ValueError("rare-structure corpus class counts differ from metadata")
    return patches, x, y, labels, components, folds, channel_names, metadata


def _near_any(candidate: np.ndarray, reference: np.ndarray, distance_m: float) -> np.ndarray:
    output = np.zeros(len(candidate), dtype=bool)
    threshold = float(distance_m) ** 2
    for start in range(0, len(candidate), 1024):
        chunk = candidate[start : start + 1024]
        squared = np.sum((chunk[:, None, :] - reference[None, :, :]) ** 2, axis=2)
        output[start : start + len(chunk)] = np.any(squared < threshold, axis=1)
    return output


def _cluster_bootstrap_pairs(
    truth: np.ndarray,
    predictions: Mapping[str, np.ndarray],
    component_ids: np.ndarray,
    pairs: Sequence[Tuple[str, str]],
    *,
    samples: int,
    seed: int,
) -> Mapping[str, Any]:
    generator = np.random.default_rng(seed)
    group_rows = {
        group: np.flatnonzero(component_ids == group) for group in np.unique(component_ids)
    }
    groups_by_rare_class: Dict[int, list[str]] = {1: [], 2: []}
    for group, rows in group_rows.items():
        rare = np.unique(truth[rows][truth[rows] > 0])
        if len(rare) != 1:
            raise ValueError("held-out component does not map to one rare class")
        groups_by_rare_class[int(rare[0])].append(str(group))
    if samples < 1 or any(len(groups) < 2 for groups in groups_by_rare_class.values()):
        raise ValueError("component bootstrap needs two held-out components per rare class")
    output: Dict[str, Any] = {}
    for left, right in pairs:
        deltas = np.empty(samples, dtype=float)
        for draw in range(samples):
            rows = []
            for groups in groups_by_rare_class.values():
                sampled = generator.choice(groups, len(groups), replace=True)
                rows.extend(group_rows[str(group)] for group in sampled)
            indices = np.concatenate(rows)
            deltas[draw] = f1_score(
                truth[indices],
                predictions[left][indices],
                labels=np.arange(len(RARE_CLASS_NAMES)),
                average="macro",
                zero_division=0,
            ) - f1_score(
                truth[indices],
                predictions[right][indices],
                labels=np.arange(len(RARE_CLASS_NAMES)),
                average="macro",
                zero_division=0,
            )
        low, median, high = np.quantile(deltas, [0.025, 0.5, 0.975])
        output[f"{left}_minus_{right}"] = {
            "median_macro_f1_delta": float(median),
            "ci_95_low": float(low),
            "ci_95_high": float(high),
            "bootstrap_samples": samples,
            "resampling_unit": "held-out-connected-component-within-rare-class",
            "held_out_components_by_rare_class": {
                RARE_CLASS_NAMES[key]: len(value)
                for key, value in groups_by_rare_class.items()
            },
        }
    return output


def run_rare_structure_probe(
    probe_corpus_path: Path,
    pretraining_corpus_path: Path,
    checkpoint_paths: Mapping[str, Path],
    label_raster_path: Path,
    output_dir: Path,
    *,
    validation_fold: int | None = None,
    buffer_m: float = 512.0,
    batch_size: int = 64,
    device: str = "cpu",
    bootstrap_samples: int = 1000,
    seed: int = 42,
) -> Mapping[str, Any]:
    """Evaluate rare classes without treating case-control rows as prevalence."""

    if set(checkpoint_paths) != set(HYBRID_PRETRAINING_MODALITIES):
        raise ValueError("exact bathymetry, backscatter, and fused checkpoints are required")
    patches, x, y, labels, components, folds, channel_names, metadata = _load_rare_corpus(
        probe_corpus_path
    )
    training_patches, _, _, training_names, training_metadata = load_patch_corpus(
        pretraining_corpus_path
    )
    del training_patches
    if training_names != channel_names:
        raise ValueError("rare probe channel order differs from pretraining")
    corpus_sha256 = sha256_file(pretraining_corpus_path)
    checkpoints = {
        modality: _load_hybrid_checkpoint(
            checkpoint_paths[modality],
            corpus_sha256=corpus_sha256,
            modality=modality,
            channel_names=training_names,
            corpus_metadata=training_metadata,
        )
        for modality in HYBRID_PRETRAINING_MODALITIES
    }
    selected_fold = int(
        metadata["component_holdout"]["selected_validation_fold"]
        if validation_fold is None
        else validation_fold
    )
    if selected_fold not in set(int(value) for value in np.unique(folds)):
        raise ValueError("rare probe validation fold is absent")
    test_indices = np.flatnonzero(folds == selected_fold)
    candidate_train = np.flatnonzero(folds != selected_fold)
    xy = np.column_stack([x, y])
    excluded = _near_any(xy[candidate_train], xy[test_indices], buffer_m)
    train_indices = candidate_train[~excluded]
    buffer_excluded = candidate_train[excluded]
    for name, indices in (("training", train_indices), ("held-out", test_indices)):
        if len(np.unique(labels[indices])) != len(RARE_CLASS_NAMES):
            raise ValueError(f"{name} rare-structure rows do not contain every class")
    train_components = set(components[train_indices])
    test_components = set(components[test_indices])
    if train_components & test_components:
        raise ValueError("rare-structure component leaked across the holdout")

    feature_sets, feature_contract = _declared_feature_sets(
        patches,
        channel_names,
        checkpoints,
        device=device,
        batch_size=batch_size,
        seed=seed,
    )
    metrics: Dict[str, Any] = {}
    predictions: Dict[str, np.ndarray] = {}
    probabilities: Dict[str, np.ndarray] = {}
    for offset, (name, features) in enumerate(feature_sets.items()):
        result, prediction, probability = _fit_probe(
            features,
            labels,
            train_indices,
            test_indices,
            seed=seed + offset,
            class_names=RARE_CLASS_NAMES,
        )
        metrics[name] = {**result, "feature_count": int(features.shape[1])}
        predictions[name] = prediction
        probabilities[name] = probability
    declared_pairs = (
        ("bathymetry_pretrained_frozen_encoder", "bathymetry_random_frozen_encoder"),
        ("bathymetry_pretrained_frozen_encoder", "bathymetry_classical_summaries"),
        ("backscatter_pretrained_frozen_encoder", "backscatter_random_frozen_encoder"),
        ("backscatter_pretrained_frozen_encoder", "backscatter_classical_summaries"),
        ("fused_pretrained_frozen_encoder", "fused_random_frozen_encoder"),
        ("fused_pretrained_frozen_encoder", "fused_classical_summaries"),
        ("fused_pretrained_frozen_encoder", "bathymetry_pretrained_frozen_encoder"),
        ("fused_pretrained_frozen_encoder", "backscatter_pretrained_frozen_encoder"),
    )
    truth = labels[test_indices]
    deltas = _cluster_bootstrap_pairs(
        truth,
        predictions,
        components[test_indices],
        declared_pairs,
        samples=bootstrap_samples,
        seed=seed + 2000,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "rare_structure_probe_metrics.json"
    predictions_path = output_dir / "rare_structure_probe_predictions.npz"
    claim_boundary = (
        "This label-guided class-balanced case-control probe estimates transfer to mapped "
        "anthropogenic seafloor-character classes under a component-held-out split. It does "
        "not estimate natural prevalence or population accuracy, validate present-day structure, "
        "measure habitat or fishing skill, or authorize model promotion or live-score changes."
    )
    config = {
        "probe_contract": RARE_PROBE_SCHEMA_VERSION,
        "parent_probe_contract": HYBRID_PROBE_SCHEMA_VERSION,
        "validation_fold": selected_fold,
        "buffer_m": buffer_m,
        "batch_size": batch_size,
        "device": device,
        "bootstrap_samples": bootstrap_samples,
        "seed": seed,
        "target": "usgs_anthropogenic_substrate_3class_case_control",
        "declared_pairwise_comparisons": [list(pair) for pair in declared_pairs],
    }
    ordered_checkpoints = tuple(
        checkpoint_paths[modality] for modality in HYBRID_PRETRAINING_MODALITIES
    )
    run_record = build_run_record(
        command="probe-rare-seafloor-structure",
        target_taxon_id=None,
        config=config,
        input_paths=(
            probe_corpus_path,
            pretraining_corpus_path,
            *ordered_checkpoints,
            label_raster_path,
        ),
        dataset_kind="official_seafloor_character_probe",
        status="completed",
        metrics={
            "metrics_artifact": str(metrics_path.resolve()),
            "predictions_artifact": str(predictions_path.resolve()),
        },
        notes=claim_boundary,
    )
    result = {
        "schema_version": RARE_PROBE_SCHEMA_VERSION,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": None,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": None,
        "target_scope": target_scope(None),
        "experiment_version": run_record["experiment_version"],
        "model_version": run_record["model_version"],
        "status": "completed",
        "probe_target": {
            "name": config["target"],
            "class_names": list(RARE_CLASS_NAMES),
            "source_substrate_codes": {
                "smooth_anthropogenic": 5,
                "rugged_anthropogenic": 6,
            },
            "natural_control_source_codes": [1, 2, 3, 4],
            "case_control_prevalence_metrics_prohibited": True,
        },
        "strict_transfer_design": {
            "validation_fold": selected_fold,
            "buffer_m": buffer_m,
            "train_rows": int(len(train_indices)),
            "test_rows": int(len(test_indices)),
            "buffer_excluded_rows": int(len(buffer_excluded)),
            "train_class_counts": np.bincount(
                labels[train_indices], minlength=len(RARE_CLASS_NAMES)
            ).tolist(),
            "test_class_counts": np.bincount(
                truth, minlength=len(RARE_CLASS_NAMES)
            ).tolist(),
            "train_components": len(train_components),
            "test_components": len(test_components),
            "component_overlap": 0,
        },
        "probe_corpus_sha256": sha256_file(probe_corpus_path),
        "pretraining_corpus_sha256": corpus_sha256,
        "checkpoint_sha256": {
            modality: sha256_file(checkpoint_paths[modality])
            for modality in HYBRID_PRETRAINING_MODALITIES
        },
        "label_raster_sha256": sha256_file(label_raster_path),
        "feature_contract": feature_contract,
        "models": metrics,
        "component_stratified_bootstrap": deltas,
        "claim_boundary": claim_boundary,
    }
    write_json(metrics_path, result)
    np.savez_compressed(
        predictions_path,
        contract_identity_json=json.dumps(
            {
                "schema_version": RARE_PROBE_SCHEMA_VERSION,
                "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
                "observation_contract_version": None,
                "taxon_catalog_version": TAXON_CATALOG_VERSION,
                "target_scope": target_scope(None),
                "target_taxon_id": None,
                "experiment_version": run_record["experiment_version"],
                "model_version": run_record["model_version"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        corpus_indices=test_indices,
        component_ids=components[test_indices],
        x=x[test_indices],
        y=y[test_indices],
        truth=truth,
        **{f"prediction__{name}": value for name, value in predictions.items()},
        **{f"probability__{name}": value for name, value in probabilities.items()},
    )
    run_record["metrics"]["metrics_sha256"] = sha256_file(metrics_path)
    run_record["metrics"]["predictions_sha256"] = sha256_file(predictions_path)
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={
            "metrics_sha256": metrics_path,
            "predictions_sha256": predictions_path,
        },
    )
    run_metadata_path = output_dir / "rare_structure_probe_run_metadata.json"
    write_json(run_metadata_path, run_record)
    return {
        "status": "completed",
        "metrics": metrics_path,
        "predictions": predictions_path,
        "run_metadata": run_metadata_path,
        "claim_boundary": claim_boundary,
    }
