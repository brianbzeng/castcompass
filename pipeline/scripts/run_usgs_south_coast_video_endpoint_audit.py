#!/usr/bin/env python3
"""Materialize locked USGS South Coast assets and run the no-training audit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.contourcast.metadata import sha256_file  # noqa: E402
from pipeline.contourcast.sources import get_source_manifest  # noqa: E402
from pipeline.contourcast.video_endpoint_audit import (  # noqa: E402
    SOUTH_COAST_REGION_PRIORITY,
    audit_usgs_south_coast_video_endpoint,
)


SOURCE_ID = "usgs_santa_barbara_south_coast_2m"


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


def _extract_locked_member(
    archive_path: Path,
    member_name: str,
    expected_sha256: str,
    destination: Path,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if sha256_file(destination) != expected_sha256:
            raise ValueError(f"cached extracted artifact checksum mismatch: {destination}")
        return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    try:
        with ZipFile(archive_path) as archive:
            names = archive.namelist()
            if names.count(member_name) != 1:
                raise ValueError(f"locked archive member is absent or duplicated: {member_name}")
            with archive.open(member_name) as source, partial.open("wb") as output:
                digest = hashlib.sha256()
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
        if digest.hexdigest() != expected_sha256:
            raise ValueError(f"extracted member checksum mismatch: {member_name}")
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
    access = manifest["access"]
    raw_dir = source_root / "raw"
    extracted_dir = source_root / "extracted"
    region_bathymetry: dict[str, Path] = {}
    region_layers: dict[str, dict[str, Path]] = {}

    for region_id in SOUTH_COAST_REGION_PRIORITY:
        region = access["regions"][region_id]
        bathymetry = region["bathymetry"]
        bathymetry_archive = _materialize(
            bathymetry["url"],
            bathymetry["archive_sha256"],
            _archive_path(raw_dir, bathymetry["url"]),
        )
        region_bathymetry[region_id] = _extract_locked_member(
            bathymetry_archive,
            bathymetry["geotiff_path"],
            bathymetry["geotiff_sha256"],
            extracted_dir / region_id / bathymetry["geotiff_path"],
        )
        layers: dict[str, Path] = {}
        for layer in region["backscatter_assets"]:
            archive_path = _materialize(
                layer["url"],
                layer["archive_sha256"],
                _archive_path(raw_dir, layer["url"]),
            )
            name = f"backscatter_intensity_{layer['survey']}"
            layers[name] = _extract_locked_member(
                archive_path,
                layer["geotiff_path"],
                layer["geotiff_sha256"],
                extracted_dir / region_id / layer["geotiff_path"],
            )
        region_layers[region_id] = layers

    video_archives = {
        spec["cruise_id"]: _materialize(
            spec["url"],
            spec["archive_sha256"],
            _archive_path(raw_dir, spec["url"]),
        )
        for spec in access["video_observation_assets"]
    }
    result = audit_usgs_south_coast_video_endpoint(
        region_bathymetry,
        region_layers,
        video_archives,
        output_dir,
        source_id=SOURCE_ID,
        vertical_datum="NAVD88",
        radii_m=(32, 128, 512),
        output_size=33,
        min_valid_fraction=0.8,
        min_aligned_valid_fraction=0.5,
        local_radius=4,
        broad_radius=24,
        relief_radius=8,
        horizontal_accuracy_m=2,
        tile_size=1024,
        min_group_class_rows=16,
    )
    return {key: str(path.resolve()) for key, path in result.items()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Download exact official USGS inputs and audit South Coast video endpoint support. "
            "This command never trains or promotes a model."
        )
    )
    default_root = ROOT / "work" / "usgs-south-coast-video-endpoint-audit-v1"
    parser.add_argument("--source-root", type=Path, default=default_root / "sources")
    parser.add_argument("--output-dir", type=Path, default=default_root / "results")
    args = parser.parse_args()
    print(json.dumps(run(args.source_root, args.output_dir), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
