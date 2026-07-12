"""Command-line entry point for reproducible ContourCast data and ML work."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Sequence

from .deep_model import architecture_smoke_test
from .geo import validate_observation_extent, verify_projected_crs
from .ingest import ingest_bathymetry, ingest_observations, load_grid, load_model_observations
from .metadata import sha256_file, write_json
from .sources import summarize_sources
from .structure import (
    audit_feature_resolution,
    derive_structure_channels,
    save_feature_stack,
)
from .terrain import (
    derive_terrain_channels,
    robust_channel_stats,
    save_terrain_stack,
)
from .training import build_pretraining_corpus, run_bathymetry_pretraining
from .workflow import run_baseline_workflow, run_smoke_workflow


def _path(value: str) -> Path:
    return Path(value).expanduser()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="contourcast-pipeline",
        description="Bathymetry ingestion, terrain features, and spatially blocked ML evaluation.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    subcommands.add_parser("sources", help="List official source manifests")

    bathymetry = subcommands.add_parser("ingest-bathymetry")
    bathymetry.add_argument("--input", required=True, type=_path)
    bathymetry.add_argument("--output", required=True, type=_path)
    bathymetry.add_argument("--source-id", required=True)
    bathymetry.add_argument("--vertical-datum", required=True)
    bathymetry.add_argument("--expected-sha256")
    bathymetry.add_argument("--crs-override")

    observations = subcommands.add_parser("ingest-observations")
    observations.add_argument("--input", required=True, type=_path)
    observations.add_argument("--output", required=True, type=_path)
    observations.add_argument("--source-id", required=True)
    observations.add_argument("--column-map", type=_path)
    observations.add_argument("--expected-sha256")

    terrain = subcommands.add_parser("derive-terrain")
    terrain.add_argument("--bathymetry", required=True, type=_path)
    terrain.add_argument("--output", required=True, type=_path)
    terrain.add_argument("--local-radius", type=int, default=2)
    terrain.add_argument("--broad-radius", type=int, default=6)

    structure = subcommands.add_parser("derive-structure")
    structure.add_argument("--bathymetry", required=True, type=_path)
    structure.add_argument("--output", required=True, type=_path)
    structure.add_argument("--local-radius", type=int, default=2)
    structure.add_argument("--broad-radius", type=int, default=6)
    structure.add_argument("--relief-radius", type=int, default=3)
    structure.add_argument("--horizontal-accuracy-m", type=float)

    resolution = subcommands.add_parser("audit-resolution")
    resolution.add_argument("--bathymetry", required=True, type=_path)
    resolution.add_argument("--horizontal-accuracy-m", type=float)
    resolution.add_argument("--feature-widths-m", type=float, nargs="+")

    corpus = subcommands.add_parser("build-pretraining-corpus")
    corpus.add_argument("--feature-stack", required=True, type=_path)
    corpus.add_argument("--output", required=True, type=_path)
    corpus.add_argument("--radii-m", type=float, nargs="+", default=[64, 256, 1024])
    corpus.add_argument("--output-size", type=int, default=33)
    corpus.add_argument("--stride-m", type=float, default=100)
    corpus.add_argument("--max-centers", type=int, default=2000)
    corpus.add_argument("--min-valid-fraction", type=float, default=0.8)
    corpus.add_argument("--seed", type=int, default=42)

    pretrain = subcommands.add_parser("pretrain-bathymetry")
    pretrain.add_argument("--corpus", required=True, type=_path)
    pretrain.add_argument("--output-dir", required=True, type=_path)
    pretrain.add_argument("--epochs", type=int, default=10)
    pretrain.add_argument("--batch-size", type=int, default=32)
    pretrain.add_argument("--learning-rate", type=float, default=3e-4)
    pretrain.add_argument("--weight-decay", type=float, default=1e-4)
    pretrain.add_argument("--base-width", type=int, default=32)
    pretrain.add_argument("--blocks-per-stage", type=int, default=2)
    pretrain.add_argument("--projection-dim", type=int, default=128)
    pretrain.add_argument("--temperature", type=float, default=0.2)
    pretrain.add_argument("--min-negative-distance-m", type=float, default=512)
    pretrain.add_argument("--validation-fold", type=int, default=0)
    pretrain.add_argument("--split-regions", type=int, default=5)
    pretrain.add_argument("--device", default="auto")
    pretrain.add_argument("--seed", type=int, default=42)

    validate = subcommands.add_parser("validate")
    validate.add_argument("--bathymetry", required=True, type=_path)
    validate.add_argument("--observations", required=True, type=_path)

    evaluate = subcommands.add_parser("evaluate-baselines")
    evaluate.add_argument("--terrain", required=True, type=_path)
    evaluate.add_argument("--observations", required=True, type=_path)
    evaluate.add_argument("--output-dir", required=True, type=_path)
    evaluate.add_argument("--dataset-kind", default="real_observations")
    evaluate.add_argument("--patch-size", type=int, default=17)
    evaluate.add_argument("--splits", type=int, default=5)
    evaluate.add_argument("--buffer-m", type=float, default=250.0)
    evaluate.add_argument("--seed", type=int, default=42)

    smoke = subcommands.add_parser("smoke")
    smoke.add_argument("--output-dir", required=True, type=_path)
    smoke.add_argument("--seed", type=int, default=42)
    smoke.add_argument("--observations", type=int, default=480)

    deep_smoke = subcommands.add_parser("deep-smoke")
    deep_smoke.add_argument("--batch-size", type=int, default=4)
    deep_smoke.add_argument("--patch-size", type=int, default=17)
    return parser


def _print(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, default=str))


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "sources":
        _print(list(summarize_sources()))
    elif args.command == "ingest-bathymetry":
        _print(
            ingest_bathymetry(
                args.input,
                args.output,
                source_id=args.source_id,
                vertical_datum=args.vertical_datum,
                expected_sha256=args.expected_sha256,
                crs_override=args.crs_override,
            )
        )
    elif args.command == "ingest-observations":
        _print(
            ingest_observations(
                args.input,
                args.output,
                source_id=args.source_id,
                column_map_path=args.column_map,
                expected_sha256=args.expected_sha256,
            )
        )
    elif args.command == "derive-terrain":
        grid = load_grid(args.bathymetry)
        channels, metadata = derive_terrain_channels(
            grid, local_radius=args.local_radius, broad_radius=args.broad_radius
        )
        save_terrain_stack(args.output, channels, grid, metadata)
        provenance = {
            "status": "completed",
            "input_sha256": sha256_file(args.bathymetry),
            "output_sha256": sha256_file(args.output),
            "derivation": metadata,
            "channel_stats": robust_channel_stats(channels),
        }
        write_json(args.output.with_suffix(".provenance.json"), provenance)
        _print(provenance)
    elif args.command == "derive-structure":
        grid = load_grid(args.bathymetry)
        channels, metadata = derive_structure_channels(
            grid,
            local_radius=args.local_radius,
            broad_radius=args.broad_radius,
            relief_radius=args.relief_radius,
            horizontal_accuracy_m=args.horizontal_accuracy_m,
        )
        save_feature_stack(args.output, channels, grid, metadata["channels"], metadata)
        provenance = {
            "status": "completed",
            "input_sha256": sha256_file(args.bathymetry),
            "output_sha256": sha256_file(args.output),
            "derivation": metadata,
        }
        write_json(args.output.with_suffix(".provenance.json"), provenance)
        _print(provenance)
    elif args.command == "audit-resolution":
        grid = load_grid(args.bathymetry)
        widths = args.feature_widths_m or (1, 2, 5, 10, 20, 50, 100)
        _print(
            audit_feature_resolution(
                grid,
                horizontal_accuracy_m=args.horizontal_accuracy_m,
                candidate_widths_m=widths,
            )
        )
    elif args.command == "build-pretraining-corpus":
        _print(
            build_pretraining_corpus(
                args.feature_stack,
                args.output,
                radii_m=args.radii_m,
                output_size=args.output_size,
                stride_m=args.stride_m,
                max_centers=args.max_centers,
                min_valid_fraction=args.min_valid_fraction,
                seed=args.seed,
            )
        )
    elif args.command == "pretrain-bathymetry":
        _print(
            run_bathymetry_pretraining(
                args.corpus,
                args.output_dir,
                epochs=args.epochs,
                batch_size=args.batch_size,
                learning_rate=args.learning_rate,
                weight_decay=args.weight_decay,
                base_width=args.base_width,
                blocks_per_stage=args.blocks_per_stage,
                projection_dim=args.projection_dim,
                temperature=args.temperature,
                min_negative_distance_m=args.min_negative_distance_m,
                validation_fold=args.validation_fold,
                split_regions=args.split_regions,
                device=args.device,
                seed=args.seed,
            )
        )
    elif args.command == "validate":
        grid = load_grid(args.bathymetry)
        frame = load_model_observations(args.observations, grid.crs)
        _print(
            {
                "status": "valid",
                "crs": verify_projected_crs(grid.crs),
                "extent": validate_observation_extent(grid, frame["x"], frame["y"]),
                "vertical_datum": grid.vertical_datum,
            }
        )
    elif args.command == "evaluate-baselines":
        _print(
            run_baseline_workflow(
                args.terrain,
                args.observations,
                args.output_dir,
                dataset_kind=args.dataset_kind,
                patch_size=args.patch_size,
                n_splits=args.splits,
                buffer_m=args.buffer_m,
                random_state=args.seed,
            )
        )
    elif args.command == "smoke":
        _print(
            run_smoke_workflow(
                args.output_dir, seed=args.seed, observations=args.observations
            )
        )
    elif args.command == "deep-smoke":
        _print(architecture_smoke_test(args.batch_size, args.patch_size))
    else:  # pragma: no cover
        raise AssertionError(args.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
