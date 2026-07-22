"""Command-line entry point for reproducible CastingCompass data and ML work."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Sequence

from .deep_model import architecture_smoke_test
from .first_party_validation import evaluate_site_window
from .geo import validate_observation_extent, verify_projected_crs
from .habitat_probe import run_frozen_seafloor_probe
from .hybrid_probe import run_hybrid_seafloor_probe
from .hybrid_shortcut_diagnostic import run_hybrid_shortcut_diagnostic
from .ingest import ingest_bathymetry, ingest_observations, load_grid, load_model_observations
from .metadata import sha256_file, write_json
from .rare_structure_probe import build_rare_structure_corpus, run_rare_structure_probe
from .sources import summarize_sources
from .structure import (
    append_aligned_layers,
    audit_feature_resolution,
    derive_structure_channels,
    load_feature_stack,
    save_feature_stack,
)
from .terrain import (
    derive_terrain_channels,
    robust_channel_stats,
    save_terrain_stack,
)
from .training import (
    build_geotiff_pretraining_corpus,
    build_pretraining_corpus,
    run_bathymetry_pretraining,
    run_hybrid_seafloor_pretraining,
)
from .video_endpoint_audit import (
    audit_usgs_residual_statewide_video_support,
    audit_usgs_sf_video_endpoint,
    audit_usgs_south_coast_video_endpoint,
)
from .validation_protocol import (
    DEFAULT_PROTOCOL_PATH,
    seal_validation_finalization,
    seal_validation_label_lock,
    seal_validation_splits,
)
from .workflow import run_baseline_workflow, run_smoke_workflow


def _path(value: str) -> Path:
    return Path(value).expanduser()


def _named_values(values: Sequence[str], *, paths: bool = False) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for value in values:
        name, separator, item = value.partition("=")
        if not separator or not name or not item or name in parsed:
            raise ValueError("named values must be unique NAME=VALUE pairs")
        parsed[name] = _path(item) if paths else item
    return parsed


def _region_named_paths(values: Sequence[str]) -> dict[str, dict[str, Path]]:
    parsed: dict[str, dict[str, Path]] = {}
    for value in values:
        key, separator, item = value.partition("=")
        region, region_separator, name = key.partition(":")
        if not separator or not region_separator or not region or not name or not item:
            raise ValueError("region layers must be REGION:NAME=PATH values")
        region_layers = parsed.setdefault(region, {})
        if name in region_layers:
            raise ValueError("region-layer names must be unique within each region")
        region_layers[name] = _path(item)
    return parsed


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
    observations.add_argument("--primary-target-taxon-id", required=True)
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

    aligned = subcommands.add_parser("append-aligned-layer")
    aligned.add_argument("--feature-stack", required=True, type=_path)
    aligned.add_argument("--layer", required=True, type=_path)
    aligned.add_argument("--layer-name", required=True)
    aligned.add_argument("--output", required=True, type=_path)
    aligned.add_argument("--feature-stack-sha256")
    aligned.add_argument("--layer-sha256")

    corpus = subcommands.add_parser("build-pretraining-corpus")
    corpus.add_argument("--feature-stack", required=True, type=_path)
    corpus.add_argument("--output", required=True, type=_path)
    corpus.add_argument("--radii-m", type=float, nargs="+", default=[64, 256, 1024])
    corpus.add_argument("--output-size", type=int, default=33)
    corpus.add_argument("--stride-m", type=float, default=100)
    corpus.add_argument("--max-centers", type=int, default=2000)
    corpus.add_argument("--min-valid-fraction", type=float, default=0.8)
    corpus.add_argument("--seed", type=int, default=42)

    geotiff_corpus = subcommands.add_parser("build-geotiff-pretraining-corpus")
    geotiff_corpus.add_argument("--input", required=True, type=_path)
    geotiff_corpus.add_argument("--output", required=True, type=_path)
    geotiff_corpus.add_argument("--source-id", required=True)
    geotiff_corpus.add_argument("--vertical-datum", required=True)
    geotiff_corpus.add_argument("--expected-sha256")
    geotiff_corpus.add_argument("--radii-m", type=float, nargs="+", default=[32, 128, 512])
    geotiff_corpus.add_argument("--output-size", type=int, default=33)
    geotiff_corpus.add_argument("--stride-m", type=float, default=64)
    geotiff_corpus.add_argument("--max-centers", type=int, default=4096)
    geotiff_corpus.add_argument("--min-valid-fraction", type=float, default=0.8)
    geotiff_corpus.add_argument("--local-radius", type=int, default=4)
    geotiff_corpus.add_argument("--broad-radius", type=int, default=24)
    geotiff_corpus.add_argument("--relief-radius", type=int, default=8)
    geotiff_corpus.add_argument("--horizontal-accuracy-m", type=float)
    geotiff_corpus.add_argument("--tile-size", type=int, default=1024)
    geotiff_corpus.add_argument("--seed", type=int, default=42)
    geotiff_corpus.add_argument("--aligned-layer", action="append", default=[])
    geotiff_corpus.add_argument("--aligned-layer-sha256", action="append", default=[])
    geotiff_corpus.add_argument("--min-aligned-valid-fraction", type=float, default=0.0)

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

    hybrid = subcommands.add_parser("pretrain-hybrid-seafloor")
    hybrid.add_argument("--corpus", required=True, type=_path)
    hybrid.add_argument("--output-dir", required=True, type=_path)
    hybrid.add_argument(
        "--modality",
        required=True,
        choices=("bathymetry", "backscatter", "fused"),
    )
    hybrid.add_argument("--epochs", type=int, default=10)
    hybrid.add_argument("--batch-size", type=int, default=32)
    hybrid.add_argument("--learning-rate", type=float, default=3e-4)
    hybrid.add_argument("--weight-decay", type=float, default=1e-4)
    hybrid.add_argument("--base-width", type=int, default=32)
    hybrid.add_argument("--blocks-per-stage", type=int, default=2)
    hybrid.add_argument("--projection-dim", type=int, default=128)
    hybrid.add_argument("--temperature", type=float, default=0.2)
    hybrid.add_argument("--min-negative-distance-m", type=float, default=512)
    hybrid.add_argument("--reconstruction-weight", type=float, default=1.0)
    hybrid.add_argument("--mask-fraction", type=float, default=0.25)
    hybrid.add_argument("--mask-block-size", type=int, default=4)
    hybrid.add_argument("--validation-fold", type=int, default=0)
    hybrid.add_argument("--split-regions", type=int, default=5)
    hybrid.add_argument("--device", default="auto")
    hybrid.add_argument("--seed", type=int, default=42)

    probe = subcommands.add_parser("probe-seafloor-character")
    probe.add_argument("--corpus", required=True, type=_path)
    probe.add_argument("--checkpoint", required=True, type=_path)
    probe.add_argument("--labels", required=True, type=_path)
    probe.add_argument("--output-dir", required=True, type=_path)
    probe.add_argument("--label-sha256")
    probe.add_argument("--validation-fold", type=int, default=0)
    probe.add_argument("--split-regions", type=int, default=5)
    probe.add_argument("--batch-size", type=int, default=64)
    probe.add_argument("--device", default="cpu")
    probe.add_argument("--bootstrap-samples", type=int, default=1000)
    probe.add_argument("--seed", type=int, default=42)

    hybrid_probe = subcommands.add_parser("probe-hybrid-seafloor-character")
    hybrid_probe.add_argument("--corpus", required=True, type=_path)
    hybrid_probe.add_argument("--bathymetry-checkpoint", required=True, type=_path)
    hybrid_probe.add_argument("--backscatter-checkpoint", required=True, type=_path)
    hybrid_probe.add_argument("--fused-checkpoint", required=True, type=_path)
    hybrid_probe.add_argument("--labels", required=True, type=_path)
    hybrid_probe.add_argument("--output-dir", required=True, type=_path)
    hybrid_probe.add_argument("--label-sha256")
    hybrid_probe.add_argument("--validation-fold", type=int, default=3)
    hybrid_probe.add_argument("--split-regions", type=int, default=5)
    hybrid_probe.add_argument("--batch-size", type=int, default=64)
    hybrid_probe.add_argument("--device", default="cpu")
    hybrid_probe.add_argument("--bootstrap-samples", type=int, default=1000)
    hybrid_probe.add_argument("--seed", type=int, default=42)

    shortcut_diagnostic = subcommands.add_parser(
        "diagnose-hybrid-seafloor-shortcuts"
    )
    shortcut_diagnostic.add_argument("--corpus", required=True, type=_path)
    shortcut_diagnostic.add_argument("--bathymetry-checkpoint", required=True, type=_path)
    shortcut_diagnostic.add_argument("--backscatter-checkpoint", required=True, type=_path)
    shortcut_diagnostic.add_argument("--fused-checkpoint", required=True, type=_path)
    shortcut_diagnostic.add_argument("--labels", required=True, type=_path)
    shortcut_diagnostic.add_argument("--output-dir", required=True, type=_path)
    shortcut_diagnostic.add_argument("--label-sha256")
    shortcut_diagnostic.add_argument("--validation-fold", type=int, default=3)
    shortcut_diagnostic.add_argument("--split-regions", type=int, default=5)
    shortcut_diagnostic.add_argument("--min-domain-rows", type=int, default=32)
    shortcut_diagnostic.add_argument("--min-domain-class-rows", type=int, default=16)
    shortcut_diagnostic.add_argument("--batch-size", type=int, default=64)
    shortcut_diagnostic.add_argument("--device", default="cpu")
    shortcut_diagnostic.add_argument("--bootstrap-samples", type=int, default=1000)
    shortcut_diagnostic.add_argument("--seed", type=int, default=42)

    video_endpoint = subcommands.add_parser("audit-usgs-sf-video-endpoint")
    video_endpoint.add_argument("--bathymetry", required=True, type=_path)
    video_endpoint.add_argument(
        "--aligned-layer",
        action="append",
        default=[],
        metavar="NAME=PATH",
        help="Repeat for each source-manifest backscatter layer.",
    )
    video_endpoint.add_argument(
        "--video-archive",
        action="append",
        default=[],
        metavar="CRUISE_ID=PATH",
        help="Repeat for each source-manifest video cruise archive.",
    )
    video_endpoint.add_argument("--output-dir", required=True, type=_path)
    video_endpoint.add_argument("--source-id", default="usgs_sf_state_waters_2m")
    video_endpoint.add_argument("--vertical-datum", default="NAVD88")
    video_endpoint.add_argument("--radii-m", type=float, nargs="+", default=[32, 128, 512])
    video_endpoint.add_argument("--output-size", type=int, default=33)
    video_endpoint.add_argument("--min-valid-fraction", type=float, default=0.8)
    video_endpoint.add_argument("--min-aligned-valid-fraction", type=float, default=0.5)
    video_endpoint.add_argument("--local-radius", type=int, default=4)
    video_endpoint.add_argument("--broad-radius", type=int, default=24)
    video_endpoint.add_argument("--relief-radius", type=int, default=8)
    video_endpoint.add_argument("--horizontal-accuracy-m", type=float, default=2.0)
    video_endpoint.add_argument("--tile-size", type=int, default=1024)
    video_endpoint.add_argument("--min-group-class-rows", type=int, default=16)

    south_coast_video = subcommands.add_parser(
        "audit-usgs-south-coast-video-endpoint"
    )
    south_coast_video.add_argument(
        "--region-bathymetry",
        action="append",
        default=[],
        metavar="REGION=PATH",
        help="Repeat for each frozen South Coast map block.",
    )
    south_coast_video.add_argument(
        "--region-aligned-layer",
        action="append",
        default=[],
        metavar="REGION:NAME=PATH",
        help="Repeat for every region-specific source-manifest backscatter layer.",
    )
    south_coast_video.add_argument(
        "--video-archive",
        action="append",
        default=[],
        metavar="CRUISE_ID=PATH",
        help="Repeat for each source-manifest video cruise archive.",
    )
    south_coast_video.add_argument("--output-dir", required=True, type=_path)
    south_coast_video.add_argument(
        "--source-id", default="usgs_santa_barbara_south_coast_2m"
    )
    south_coast_video.add_argument("--vertical-datum", default="NAVD88")
    south_coast_video.add_argument(
        "--radii-m", type=float, nargs="+", default=[32, 128, 512]
    )
    south_coast_video.add_argument("--output-size", type=int, default=33)
    south_coast_video.add_argument("--min-valid-fraction", type=float, default=0.8)
    south_coast_video.add_argument(
        "--min-aligned-valid-fraction", type=float, default=0.5
    )
    south_coast_video.add_argument("--local-radius", type=int, default=4)
    south_coast_video.add_argument("--broad-radius", type=int, default=24)
    south_coast_video.add_argument("--relief-radius", type=int, default=8)
    south_coast_video.add_argument(
        "--horizontal-accuracy-m", type=float, default=2.0
    )
    south_coast_video.add_argument("--tile-size", type=int, default=1024)
    south_coast_video.add_argument("--min-group-class-rows", type=int, default=16)

    residual_video = subcommands.add_parser(
        "audit-usgs-residual-statewide-video-support"
    )
    residual_video.add_argument(
        "--video-archive",
        action="append",
        default=[],
        metavar="CRUISE_ID=PATH",
        help="Repeat for each frozen residual DS 781 video cruise archive.",
    )
    residual_video.add_argument("--output-dir", required=True, type=_path)
    residual_video.add_argument(
        "--source-id", default="usgs_ds781_residual_video_observations"
    )
    residual_video.add_argument("--min-group-class-rows", type=int, default=16)

    rare_corpus = subcommands.add_parser("build-rare-structure-corpus")
    rare_corpus.add_argument("--input", required=True, type=_path)
    rare_corpus.add_argument("--labels", required=True, type=_path)
    rare_corpus.add_argument("--output", required=True, type=_path)
    rare_corpus.add_argument("--source-id", required=True)
    rare_corpus.add_argument("--vertical-datum", required=True)
    rare_corpus.add_argument("--expected-sha256")
    rare_corpus.add_argument("--label-sha256")
    rare_corpus.add_argument("--aligned-layer", action="append", default=[])
    rare_corpus.add_argument("--aligned-layer-sha256", action="append", default=[])
    rare_corpus.add_argument("--samples-per-class", type=int, default=64)
    rare_corpus.add_argument("--candidate-multiplier", type=float, default=1.75)
    rare_corpus.add_argument("--spacing-m", type=float, default=8)
    rare_corpus.add_argument("--minimum-resolvable-cells", type=int, default=3)
    rare_corpus.add_argument("--control-min-distance-m", type=float, default=16)
    rare_corpus.add_argument("--control-max-distance-m", type=float, default=128)
    rare_corpus.add_argument("--radii-m", type=float, nargs="+", default=[32, 128, 512])
    rare_corpus.add_argument("--output-size", type=int, default=33)
    rare_corpus.add_argument("--min-valid-fraction", type=float, default=0.8)
    rare_corpus.add_argument("--min-aligned-valid-fraction", type=float, default=0.5)
    rare_corpus.add_argument("--local-radius", type=int, default=4)
    rare_corpus.add_argument("--broad-radius", type=int, default=24)
    rare_corpus.add_argument("--relief-radius", type=int, default=8)
    rare_corpus.add_argument("--horizontal-accuracy-m", type=float, default=2)
    rare_corpus.add_argument("--tile-size", type=int, default=1024)
    rare_corpus.add_argument("--split-regions", type=int, default=3)
    rare_corpus.add_argument("--seed", type=int, default=42)

    rare_probe = subcommands.add_parser("probe-rare-seafloor-structure")
    rare_probe.add_argument("--probe-corpus", required=True, type=_path)
    rare_probe.add_argument("--pretraining-corpus", required=True, type=_path)
    rare_probe.add_argument("--bathymetry-checkpoint", required=True, type=_path)
    rare_probe.add_argument("--backscatter-checkpoint", required=True, type=_path)
    rare_probe.add_argument("--fused-checkpoint", required=True, type=_path)
    rare_probe.add_argument("--labels", required=True, type=_path)
    rare_probe.add_argument("--output-dir", required=True, type=_path)
    rare_probe.add_argument("--validation-fold", type=int)
    rare_probe.add_argument("--buffer-m", type=float, default=512)
    rare_probe.add_argument("--batch-size", type=int, default=64)
    rare_probe.add_argument("--device", default="cpu")
    rare_probe.add_argument("--bootstrap-samples", type=int, default=1000)
    rare_probe.add_argument("--seed", type=int, default=42)

    validate = subcommands.add_parser("validate")
    validate.add_argument("--bathymetry", required=True, type=_path)
    validate.add_argument("--observations", required=True, type=_path)
    validate.add_argument("--target-taxon-id", required=True)

    evaluate = subcommands.add_parser("evaluate-baselines")
    evaluate.add_argument("--terrain", required=True, type=_path)
    evaluate.add_argument("--observations", required=True, type=_path)
    evaluate.add_argument("--output-dir", required=True, type=_path)
    evaluate.add_argument("--dataset-kind", default="real_observations")
    evaluate.add_argument("--target-taxon-id", required=True)
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

    activation = subcommands.add_parser(
        "seal-validation-activation",
        help="Seal the empty activation manifest before validation enrollment",
    )
    activation.add_argument("--protocol", type=_path, default=DEFAULT_PROTOCOL_PATH)
    activation.add_argument("--output", required=True, type=_path)
    activation.add_argument("--release-commit", required=True)
    activation.add_argument("--scoring-system-kind", required=True)
    activation.add_argument("--scoring-system-version", required=True)
    activation.add_argument("--scoring-system-sha256", required=True)
    activation.add_argument("--opportunity-contract-version", required=True)
    activation.add_argument("--validation-export-signing-key-id", required=True)
    activation.add_argument(
        "--validation-export-public-key-ed25519", required=True
    )
    activation.add_argument("--external-log-anchor-provider-id", required=True)
    activation.add_argument("--external-log-anchor-signing-key-id", required=True)
    activation.add_argument(
        "--external-log-anchor-public-key-ed25519", required=True
    )

    seal = subcommands.add_parser(
        "seal-validation-splits",
        help="Append a cumulative label-free assignment batch",
    )
    seal.add_argument("--protocol", type=_path, default=DEFAULT_PROTOCOL_PATH)
    seal.add_argument("--label-free-evidence", required=True, type=_path)
    seal.add_argument("--opportunity-ledger", required=True, type=_path)
    seal.add_argument("--predictions", required=True, type=_path)
    seal.add_argument("--manifest-chain", required=True, type=_path, nargs="+")
    seal.add_argument("--output", required=True, type=_path)

    finalization = subcommands.add_parser(
        "seal-validation-finalization",
        help="Seal the terminal signed census after the fixed enrollment interval",
    )
    finalization.add_argument("--protocol", type=_path, default=DEFAULT_PROTOCOL_PATH)
    finalization.add_argument("--label-free-evidence", required=True, type=_path)
    finalization.add_argument("--opportunity-ledger", required=True, type=_path)
    finalization.add_argument("--predictions", required=True, type=_path)
    finalization.add_argument("--census-export", required=True, type=_path)
    finalization.add_argument("--manifest-chain", required=True, type=_path, nargs="+")
    finalization.add_argument("--output", required=True, type=_path)

    label_lock = subcommands.add_parser(
        "seal-validation-label-lock",
        help="Revalidate the frozen evaluator and seal label access before export",
    )
    label_lock.add_argument("--protocol", type=_path, default=DEFAULT_PROTOCOL_PATH)
    label_lock.add_argument("--manifest-chain", required=True, type=_path, nargs="+")
    label_lock.add_argument("--output", required=True, type=_path)

    site_window = subcommands.add_parser(
        "evaluate-site-window",
        help="Lock labels and evaluate the frozen site-by-window protocol",
    )
    site_window.add_argument("--protocol", type=_path, default=DEFAULT_PROTOCOL_PATH)
    site_window.add_argument("--label-free-evidence", required=True, type=_path)
    site_window.add_argument("--labeled-evidence", required=True, type=_path)
    site_window.add_argument("--opportunity-ledger", required=True, type=_path)
    site_window.add_argument("--predictions", required=True, type=_path)
    site_window.add_argument("--census-export", required=True, type=_path)
    site_window.add_argument(
        "--deletion-reconciliation", required=True, type=_path, nargs="+"
    )
    site_window.add_argument("--manifest-chain", required=True, type=_path, nargs="+")
    site_window.add_argument("--label-lock", required=True, type=_path)
    site_window.add_argument("--label-access-receipt", type=_path)
    site_window.add_argument("--publication-audit", type=_path)
    site_window.add_argument("--audit-receipt", type=_path)
    site_window.add_argument("--output", required=True, type=_path)
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
                primary_target_taxon_id=args.primary_target_taxon_id,
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
    elif args.command == "append-aligned-layer":
        if args.output.resolve() == args.feature_stack.resolve():
            raise ValueError("append-aligned-layer requires a distinct output path")
        for path, expected, label in (
            (args.feature_stack, args.feature_stack_sha256, "feature stack"),
            (args.layer, args.layer_sha256, "aligned layer"),
        ):
            if expected and sha256_file(path) != expected.lower():
                raise ValueError(f"{label} checksum does not match the declared SHA-256")
        channels, reference, channel_names, feature_metadata = load_feature_stack(
            args.feature_stack
        )
        layer = load_grid(args.layer)
        combined, combined_names, layer_metadata = append_aligned_layers(
            channels,
            channel_names,
            reference,
            {args.layer_name: layer},
        )
        existing_layers = feature_metadata.get("aligned_layers", {})
        if not isinstance(existing_layers, dict):
            raise ValueError("feature stack aligned_layers metadata must be an object")
        if args.layer_name in existing_layers:
            raise ValueError("feature stack already declares this aligned layer")
        combined_metadata = {
            **feature_metadata,
            "aligned_layers": {**existing_layers, **layer_metadata},
        }
        save_feature_stack(
            args.output,
            combined,
            reference,
            combined_names,
            combined_metadata,
        )
        provenance = {
            "status": "completed",
            "feature_stack_sha256": sha256_file(args.feature_stack),
            "layer_sha256": sha256_file(args.layer),
            "output_sha256": sha256_file(args.output),
            "layer_name": args.layer_name,
            "layer_metadata": layer_metadata[args.layer_name],
            "claim_boundary": (
                "Alignment and missingness are recorded preprocessing facts only; this output "
                "does not establish habitat, catch, or live-score validity."
            ),
        }
        write_json(args.output.with_suffix(".provenance.json"), provenance)
        _print(provenance)
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
    elif args.command == "build-geotiff-pretraining-corpus":
        _print(
            build_geotiff_pretraining_corpus(
                args.input,
                args.output,
                source_id=args.source_id,
                vertical_datum=args.vertical_datum,
                expected_sha256=args.expected_sha256,
                radii_m=args.radii_m,
                output_size=args.output_size,
                stride_m=args.stride_m,
                max_centers=args.max_centers,
                min_valid_fraction=args.min_valid_fraction,
                local_radius=args.local_radius,
                broad_radius=args.broad_radius,
                relief_radius=args.relief_radius,
                horizontal_accuracy_m=args.horizontal_accuracy_m,
                tile_size=args.tile_size,
                seed=args.seed,
                aligned_layer_paths=_named_values(args.aligned_layer, paths=True),
                aligned_layer_expected_sha256=_named_values(args.aligned_layer_sha256),
                min_aligned_valid_fraction=args.min_aligned_valid_fraction,
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
    elif args.command == "pretrain-hybrid-seafloor":
        _print(
            run_hybrid_seafloor_pretraining(
                args.corpus,
                args.output_dir,
                modality=args.modality,
                epochs=args.epochs,
                batch_size=args.batch_size,
                learning_rate=args.learning_rate,
                weight_decay=args.weight_decay,
                base_width=args.base_width,
                blocks_per_stage=args.blocks_per_stage,
                projection_dim=args.projection_dim,
                temperature=args.temperature,
                min_negative_distance_m=args.min_negative_distance_m,
                reconstruction_weight=args.reconstruction_weight,
                mask_fraction=args.mask_fraction,
                mask_block_size=args.mask_block_size,
                validation_fold=args.validation_fold,
                split_regions=args.split_regions,
                device=args.device,
                seed=args.seed,
            )
        )
    elif args.command == "probe-seafloor-character":
        _print(
            run_frozen_seafloor_probe(
                args.corpus,
                args.checkpoint,
                args.labels,
                args.output_dir,
                label_raster_sha256=args.label_sha256,
                validation_fold=args.validation_fold,
                split_regions=args.split_regions,
                batch_size=args.batch_size,
                device=args.device,
                bootstrap_samples=args.bootstrap_samples,
                seed=args.seed,
            )
        )
    elif args.command == "probe-hybrid-seafloor-character":
        _print(
            run_hybrid_seafloor_probe(
                args.corpus,
                {
                    "bathymetry": args.bathymetry_checkpoint,
                    "backscatter": args.backscatter_checkpoint,
                    "fused": args.fused_checkpoint,
                },
                args.labels,
                args.output_dir,
                label_raster_sha256=args.label_sha256,
                validation_fold=args.validation_fold,
                split_regions=args.split_regions,
                batch_size=args.batch_size,
                device=args.device,
                bootstrap_samples=args.bootstrap_samples,
                seed=args.seed,
            )
        )
    elif args.command == "diagnose-hybrid-seafloor-shortcuts":
        _print(
            run_hybrid_shortcut_diagnostic(
                args.corpus,
                {
                    "bathymetry": args.bathymetry_checkpoint,
                    "backscatter": args.backscatter_checkpoint,
                    "fused": args.fused_checkpoint,
                },
                args.labels,
                args.output_dir,
                label_raster_sha256=args.label_sha256,
                validation_fold=args.validation_fold,
                split_regions=args.split_regions,
                min_domain_rows=args.min_domain_rows,
                min_domain_class_rows=args.min_domain_class_rows,
                batch_size=args.batch_size,
                device=args.device,
                bootstrap_samples=args.bootstrap_samples,
                seed=args.seed,
            )
        )
    elif args.command == "audit-usgs-sf-video-endpoint":
        _print(
            audit_usgs_sf_video_endpoint(
                args.bathymetry,
                _named_values(args.aligned_layer, paths=True),
                _named_values(args.video_archive, paths=True),
                args.output_dir,
                source_id=args.source_id,
                vertical_datum=args.vertical_datum,
                radii_m=args.radii_m,
                output_size=args.output_size,
                min_valid_fraction=args.min_valid_fraction,
                min_aligned_valid_fraction=args.min_aligned_valid_fraction,
                local_radius=args.local_radius,
                broad_radius=args.broad_radius,
                relief_radius=args.relief_radius,
                horizontal_accuracy_m=args.horizontal_accuracy_m,
                tile_size=args.tile_size,
                min_group_class_rows=args.min_group_class_rows,
            )
        )
    elif args.command == "audit-usgs-south-coast-video-endpoint":
        _print(
            audit_usgs_south_coast_video_endpoint(
                _named_values(args.region_bathymetry, paths=True),
                _region_named_paths(args.region_aligned_layer),
                _named_values(args.video_archive, paths=True),
                args.output_dir,
                source_id=args.source_id,
                vertical_datum=args.vertical_datum,
                radii_m=args.radii_m,
                output_size=args.output_size,
                min_valid_fraction=args.min_valid_fraction,
                min_aligned_valid_fraction=args.min_aligned_valid_fraction,
                local_radius=args.local_radius,
                broad_radius=args.broad_radius,
                relief_radius=args.relief_radius,
                horizontal_accuracy_m=args.horizontal_accuracy_m,
                tile_size=args.tile_size,
                min_group_class_rows=args.min_group_class_rows,
            )
        )
    elif args.command == "audit-usgs-residual-statewide-video-support":
        _print(
            audit_usgs_residual_statewide_video_support(
                _named_values(args.video_archive, paths=True),
                args.output_dir,
                source_id=args.source_id,
                min_group_class_rows=args.min_group_class_rows,
            )
        )
    elif args.command == "build-rare-structure-corpus":
        _print(
            build_rare_structure_corpus(
                args.input,
                args.labels,
                args.output,
                source_id=args.source_id,
                vertical_datum=args.vertical_datum,
                aligned_layer_paths=_named_values(args.aligned_layer, paths=True),
                expected_source_sha256=args.expected_sha256,
                aligned_layer_expected_sha256=_named_values(
                    args.aligned_layer_sha256
                ),
                label_raster_sha256=args.label_sha256,
                samples_per_class=args.samples_per_class,
                candidate_multiplier=args.candidate_multiplier,
                spacing_m=args.spacing_m,
                minimum_resolvable_cells=args.minimum_resolvable_cells,
                control_min_distance_m=args.control_min_distance_m,
                control_max_distance_m=args.control_max_distance_m,
                radii_m=args.radii_m,
                output_size=args.output_size,
                min_valid_fraction=args.min_valid_fraction,
                min_aligned_valid_fraction=args.min_aligned_valid_fraction,
                local_radius=args.local_radius,
                broad_radius=args.broad_radius,
                relief_radius=args.relief_radius,
                horizontal_accuracy_m=args.horizontal_accuracy_m,
                tile_size=args.tile_size,
                split_regions=args.split_regions,
                seed=args.seed,
            )
        )
    elif args.command == "probe-rare-seafloor-structure":
        _print(
            run_rare_structure_probe(
                args.probe_corpus,
                args.pretraining_corpus,
                {
                    "bathymetry": args.bathymetry_checkpoint,
                    "backscatter": args.backscatter_checkpoint,
                    "fused": args.fused_checkpoint,
                },
                args.labels,
                args.output_dir,
                validation_fold=args.validation_fold,
                buffer_m=args.buffer_m,
                batch_size=args.batch_size,
                device=args.device,
                bootstrap_samples=args.bootstrap_samples,
                seed=args.seed,
            )
        )
    elif args.command == "validate":
        grid = load_grid(args.bathymetry)
        frame = load_model_observations(
            args.observations,
            grid.crs,
            expected_target_taxon_id=args.target_taxon_id,
        )
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
                target_taxon_id=args.target_taxon_id,
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
    elif args.command == "seal-validation-activation":
        _print(
            seal_validation_splits(
                protocol_path=args.protocol,
                output_path=args.output,
                release_commit=args.release_commit,
                scoring_system_kind=args.scoring_system_kind,
                scoring_system_version=args.scoring_system_version,
                scoring_system_sha256=args.scoring_system_sha256,
                opportunity_contract_version=args.opportunity_contract_version,
                validation_export_signing_key_id=(
                    args.validation_export_signing_key_id
                ),
                validation_export_public_key_ed25519=(
                    args.validation_export_public_key_ed25519
                ),
                external_log_anchor_provider_id=(
                    args.external_log_anchor_provider_id
                ),
                external_log_anchor_signing_key_id=(
                    args.external_log_anchor_signing_key_id
                ),
                external_log_anchor_public_key_ed25519=(
                    args.external_log_anchor_public_key_ed25519
                ),
            )
        )
    elif args.command == "seal-validation-splits":
        _print(
            seal_validation_splits(
                protocol_path=args.protocol,
                output_path=args.output,
                evidence_path=args.label_free_evidence,
                opportunity_ledger_path=args.opportunity_ledger,
                candidate_predictions_path=args.predictions,
                existing_manifest_path=args.manifest_chain[-1],
                activation_manifest_path=args.manifest_chain[0],
                manifest_chain_paths=args.manifest_chain,
            )
        )
    elif args.command == "seal-validation-finalization":
        seal_validation_finalization(
            protocol_path=args.protocol,
            output_path=args.output,
            label_free_evidence_path=args.label_free_evidence,
            opportunity_ledger_path=args.opportunity_ledger,
            candidate_predictions_path=args.predictions,
            census_export_path=args.census_export,
            manifest_chain_paths=args.manifest_chain,
        )
        _print(
            {
                "status": "sealed",
                "manifest_path": str(args.output),
                "manifest_role": "finalization",
            }
        )
    elif args.command == "seal-validation-label-lock":
        _print(
            seal_validation_label_lock(
                protocol_path=args.protocol,
                output_path=args.output,
                finalization_manifest_path=args.manifest_chain[-1],
                manifest_chain_paths=args.manifest_chain,
            )
        )
    elif args.command == "evaluate-site-window":
        _print(
            evaluate_site_window(
                protocol_path=args.protocol,
                label_free_evidence_path=args.label_free_evidence,
                labeled_evidence_path=args.labeled_evidence,
                split_manifest_path=args.manifest_chain[-1],
                activation_manifest_path=args.manifest_chain[0],
                manifest_chain_paths=args.manifest_chain,
                opportunity_ledger_path=args.opportunity_ledger,
                candidate_predictions_path=args.predictions,
                census_export_path=args.census_export,
                deletion_reconciliation_paths=args.deletion_reconciliation,
                label_lock_path=args.label_lock,
                label_access_receipt_path=args.label_access_receipt,
                publication_audit_path=args.publication_audit,
                audit_receipt_path=args.audit_receipt,
                output_path=args.output,
            )
        )
    else:  # pragma: no cover
        raise AssertionError(args.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
