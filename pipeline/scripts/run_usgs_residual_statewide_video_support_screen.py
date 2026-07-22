#!/usr/bin/env python3
"""Materialize the locked residual DS 781 archives and run the support screen."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.contourcast.metadata import sha256_file  # noqa: E402
from pipeline.contourcast.sources import get_source_manifest  # noqa: E402
from pipeline.contourcast.video_endpoint_audit import (  # noqa: E402
    RESIDUAL_STATEWIDE_VIDEO_CRUISES,
    audit_usgs_residual_statewide_video_support,
)


SOURCE_ID = "usgs_ds781_residual_video_observations"


def _materialize(url: str, expected_sha256: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if sha256_file(destination) != expected_sha256:
            raise ValueError(f"cached artifact checksum mismatch: {destination}")
        return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if sha256_file(partial) != expected_sha256:
            raise ValueError(f"download checksum mismatch: {url}")
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination


def _archive_path(raw_dir: Path, url: str) -> Path:
    name = Path(urlparse(url).path).name
    if not name or name in {".", ".."}:
        raise ValueError(f"official URL has no safe archive filename: {url}")
    return raw_dir / name


def run(source_root: Path, output_dir: Path) -> dict[str, str]:
    manifest = get_source_manifest(SOURCE_ID)
    specs = manifest["access"]["video_observation_assets"]
    if tuple(spec["cruise_id"] for spec in specs) != RESIDUAL_STATEWIDE_VIDEO_CRUISES:
        raise ValueError("runner archive order disagrees with the frozen catalog selection")
    raw_dir = source_root / "raw"
    video_archives = {
        spec["cruise_id"]: _materialize(
            spec["url"],
            spec["archive_sha256"],
            _archive_path(raw_dir, spec["url"]),
        )
        for spec in specs
    }
    result = audit_usgs_residual_statewide_video_support(
        video_archives,
        output_dir,
        source_id=SOURCE_ID,
        min_group_class_rows=16,
    )
    return {key: str(path.resolve()) for key, path in result.items()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Download exact official residual DS 781 video archives and screen whole-cruise "
            "class support. This command never acquires rasters, trains, or promotes a model."
        )
    )
    default_root = ROOT / "work" / "usgs-residual-statewide-video-support-screen-v1"
    parser.add_argument("--source-root", type=Path, default=default_root / "sources")
    parser.add_argument("--output-dir", type=Path, default=default_root / "results")
    args = parser.parse_args()
    print(json.dumps(run(args.source_root, args.output_dir), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
