#!/usr/bin/env python3
"""Materialize exact USGS DS182 inputs and run the frozen support audit."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.contourcast.metadata import sha256_file  # noqa: E402
from pipeline.contourcast.sediment_endpoint_audit import (  # noqa: E402
    DS182_SOURCE_ID,
    audit_usgs_ds182_sediment_endpoint_support,
)
from pipeline.contourcast.sources import get_source_manifest  # noqa: E402


def _safe_url_name(url: str) -> str:
    name = Path(urlparse(url).path).name
    if not name or name in {".", ".."}:
        raise ValueError(f"official URL has no safe filename: {url}")
    return name


def _materialize(
    url: str,
    expected_sha256: str,
    expected_bytes: int | None,
    destination: Path,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if (
            (expected_bytes is not None and destination.stat().st_size != expected_bytes)
            or sha256_file(destination) != expected_sha256
        ):
            raise ValueError(f"cached artifact checksum mismatch: {destination}")
        return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "CastingCompass/1.0 (+https://castingcompass.com)"},
        )
        with urllib.request.urlopen(request, timeout=120) as response, partial.open(
            "wb"
        ) as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if (
            (expected_bytes is not None and partial.stat().st_size != expected_bytes)
            or sha256_file(partial) != expected_sha256
        ):
            raise ValueError(f"download checksum mismatch: {url}")
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination


def _materialize_reference_raster(
    specification: dict[str, object],
    raw_dir: Path,
) -> Path:
    archive = _materialize(
        str(specification["url"]),
        str(specification["archive_sha256"]),
        None,
        raw_dir / _safe_url_name(str(specification["url"])),
    )
    member = str(specification["geotiff_member"])
    if Path(member).name != member:
        raise ValueError("reference GeoTIFF member name is unsafe")
    destination = raw_dir / "reference" / member
    if destination.exists():
        if sha256_file(destination) != specification["geotiff_sha256"]:
            raise ValueError("cached reference GeoTIFF checksum mismatch")
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    try:
        try:
            with ZipFile(archive) as source:
                if source.namelist().count(member) != 1:
                    raise ValueError("reference archive lacks one exact GeoTIFF member")
                with source.open(member) as input_handle, partial.open("wb") as output:
                    shutil.copyfileobj(input_handle, output, length=1024 * 1024)
        except BadZipFile as error:
            raise ValueError("reference archive is not a valid ZIP file") from error
        if sha256_file(partial) != specification["geotiff_sha256"]:
            raise ValueError("reference GeoTIFF checksum mismatch")
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination


def run(source_root: Path, output_dir: Path) -> dict[str, str]:
    manifest = get_source_manifest(DS182_SOURCE_ID)
    access = manifest["access"]
    outcome = access["outcome_asset"]
    source_table = access["source_table"]
    reference = access["reference_raster"]
    raw_dir = source_root / "raw"
    archive_path = _materialize(
        outcome["url"],
        outcome["archive_sha256"],
        outcome["archive_bytes"],
        raw_dir / _safe_url_name(outcome["url"]),
    )
    source_table_path = _materialize(
        source_table["url"],
        source_table["sha256"],
        source_table["bytes"],
        raw_dir / _safe_url_name(source_table["url"]),
    )
    reference_path = _materialize_reference_raster(reference, raw_dir)
    result = audit_usgs_ds182_sediment_endpoint_support(
        archive_path,
        source_table_path,
        reference_path,
        output_dir,
    )
    return {key: str(path.resolve()) for key, path in result.items()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Download exact official DS182 EXT and source-table bytes and screen the frozen "
            "whole-source sediment endpoint support. This command reads only reference-raster "
            "metadata and never builds patches, trains, promotes, scores, or deploys a model."
        )
    )
    default_root = ROOT / "work" / "usgs-ds182-sediment-endpoint-support-v1"
    parser.add_argument("--source-root", type=Path, default=default_root / "sources")
    parser.add_argument("--output-dir", type=Path, default=default_root / "results")
    args = parser.parse_args()
    print(json.dumps(run(args.source_root, args.output_dir), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
