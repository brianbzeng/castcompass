#!/usr/bin/env python3
"""Build the compact opportunity-attestation index from exact published asset bytes.

This emitter intentionally lives outside ``generate_snapshot.py`` because that
file's bytes are part of the heuristic scoring-system identity. A forecast
refresh must finish first, then this script binds the resulting snapshot and
public site catalog without changing the score identity it records.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    validate_contract_assets,
)


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DATA = ROOT / "public" / "data"
DEFAULT_SNAPSHOT_PATH = PUBLIC_DATA / "opportunities.json"
DEFAULT_SITE_CATALOG_PATH = PUBLIC_DATA / "sites.json"
DEFAULT_OUTPUT_PATH = PUBLIC_DATA / "opportunity-attestations.json"
ATTESTATION_VERSION = "castingcompass.opportunity-attestation-index/1.0.0"
SCORING_SYSTEM_KIND = "heuristic-configuration"
UTC_TIMESTAMP_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z"
)


def parse_utc(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not UTC_TIMESTAMP_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must be a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} must be a real Gregorian UTC timestamp") from exc
    if parsed.tzinfo != timezone.utc:
        raise ValueError(f"{field} must use UTC")
    expected = parsed.isoformat(timespec="milliseconds" if "." in value else "seconds")
    if expected.replace("+00:00", "Z") != value:
        raise ValueError(f"{field} must be canonical UTC")
    return parsed


def require_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{64}", value) is None:
        raise ValueError(f"{field} must be a lowercase SHA-256 digest")
    return value


def require_score(value: Any, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be numeric")
    if not math.isfinite(value) or value < 0 or value > 100:
        raise ValueError(f"{field} must be finite and between 0 and 100")
    return value


def build_attestation_index(snapshot_bytes: bytes, site_catalog_bytes: bytes) -> dict[str, Any]:
    try:
        snapshot = json.loads(snapshot_bytes)
        sites = json.loads(site_catalog_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("published snapshot and site catalog must be valid UTF-8 JSON") from exc
    if not isinstance(snapshot, dict) or not isinstance(sites, list):
        raise ValueError("published snapshot and site catalog have invalid root types")

    required_identity = {
        "generatedAt",
        "target_taxon_id",
        "taxon_catalog_version",
        "observation_contract_version",
        "model_run_contract_version",
        "opportunity_contract_version",
        "scoring_system_kind",
        "scoring_system_version",
        "scoring_system_sha256",
        "windows",
    }
    missing = sorted(required_identity - set(snapshot))
    if missing:
        raise ValueError(f"opportunity snapshot is missing attestation identity: {missing}")
    parse_utc(snapshot["generatedAt"], "generatedAt")
    if snapshot["target_taxon_id"] != PRODUCTION_TARGET_TAXON_ID:
        raise ValueError("opportunity snapshot target is not the production target")
    if snapshot["taxon_catalog_version"] != TAXON_CATALOG_VERSION:
        raise ValueError("opportunity snapshot taxon catalog version is unsupported")
    if snapshot["observation_contract_version"] != OBSERVATION_CONTRACT_VERSION:
        raise ValueError("opportunity snapshot observation contract version is unsupported")
    if snapshot["model_run_contract_version"] != MODEL_RUN_CONTRACT_VERSION:
        raise ValueError("opportunity snapshot model-run contract version is unsupported")
    if snapshot["opportunity_contract_version"] != OPPORTUNITY_CONTRACT_VERSION:
        raise ValueError("opportunity snapshot opportunity contract version is unsupported")
    scoring_sha256 = require_sha256(snapshot["scoring_system_sha256"], "scoring_system_sha256")
    if snapshot["scoring_system_kind"] != SCORING_SYSTEM_KIND:
        raise ValueError("opportunity snapshot scoring kind is unsupported")
    if snapshot["scoring_system_version"] != (
        f"heuristic-{PRODUCTION_TARGET_TAXON_ID}-{scoring_sha256}"
    ):
        raise ValueError("opportunity snapshot scoring version is not bound to its SHA")
    if not isinstance(snapshot["windows"], list):
        raise ValueError("opportunity snapshot windows must be an array")

    site_ids: set[str] = set()
    for site in sites:
        if not isinstance(site, dict) or not isinstance(site.get("id"), str) or not site["id"]:
            raise ValueError("public site catalog entries require non-empty string IDs")
        if site["id"] in site_ids:
            raise ValueError(f"public site catalog contains duplicate ID {site['id']!r}")
        site_ids.add(site["id"])

    windows: list[list[Any]] = []
    seen_ids: set[str] = set()
    for index, window in enumerate(snapshot["windows"]):
        if not isinstance(window, dict):
            raise ValueError(f"opportunity snapshot window {index} must be an object")
        window_id = window.get("id")
        site_id = window.get("siteId")
        if not isinstance(window_id, str) or not window_id or window_id in seen_ids:
            raise ValueError("opportunity snapshot window IDs must be unique non-empty strings")
        if not isinstance(site_id, str) or site_id not in site_ids:
            raise ValueError(f"opportunity snapshot window {window_id!r} has an unknown site ID")
        expected_window_identity = {
            "species": snapshot["target_taxon_id"],
            "target_taxon_id": snapshot["target_taxon_id"],
            "taxon_catalog_version": snapshot["taxon_catalog_version"],
            "observation_contract_version": snapshot["observation_contract_version"],
            "model_run_contract_version": snapshot["model_run_contract_version"],
            "opportunity_contract_version": snapshot["opportunity_contract_version"],
            "scoring_system_kind": snapshot["scoring_system_kind"],
            "scoring_system_sha256": scoring_sha256,
            "modelVersion": snapshot["scoring_system_version"],
        }
        for field, expected in expected_window_identity.items():
            if window.get(field) != expected:
                raise ValueError(
                    f"opportunity snapshot window {window_id!r} {field} disagrees with root identity"
                )
        start_at = parse_utc(window.get("start"), f"window {window_id!r} start")
        end_at = parse_utc(window.get("end"), f"window {window_id!r} end")
        if end_at - start_at != timedelta(hours=2):
            raise ValueError(f"opportunity snapshot window {window_id!r} is not exactly two hours")
        scores = [
            require_score(window.get("score"), f"window {window_id!r} score"),
            require_score(window.get("habitatScore"), f"window {window_id!r} habitatScore"),
            require_score(window.get("seasonalityScore"), f"window {window_id!r} seasonalityScore"),
            require_score(window.get("dynamicScore"), f"window {window_id!r} dynamicScore"),
            require_score(window.get("fishabilityScore"), f"window {window_id!r} fishabilityScore"),
        ]
        seen_ids.add(window_id)
        windows.append([window_id, site_id, window["start"], window["end"], *scores])

    return {
        "schema_version": ATTESTATION_VERSION,
        "generated_at": snapshot["generatedAt"],
        "snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
        "site_catalog_sha256": hashlib.sha256(site_catalog_bytes).hexdigest(),
        "target_taxon_id": snapshot["target_taxon_id"],
        "taxon_catalog_version": snapshot["taxon_catalog_version"],
        "observation_contract_version": snapshot["observation_contract_version"],
        "model_run_contract_version": snapshot["model_run_contract_version"],
        "opportunity_contract_version": snapshot["opportunity_contract_version"],
        "scoring_system_kind": snapshot["scoring_system_kind"],
        "scoring_system_version": snapshot["scoring_system_version"],
        "scoring_system_sha256": scoring_sha256,
        "windows": windows,
    }


def write_attestation_index(snapshot_path: Path, site_catalog_path: Path, output_path: Path) -> dict[str, Any]:
    attestation = build_attestation_index(snapshot_path.read_bytes(), site_catalog_path.read_bytes())
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    temporary_path.write_text(json.dumps(attestation, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary_path.replace(output_path)
    return attestation


def main() -> None:
    validate_contract_assets()
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT_PATH)
    parser.add_argument("--sites", type=Path, default=DEFAULT_SITE_CATALOG_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    args = parser.parse_args()
    attestation = write_attestation_index(args.snapshot, args.sites, args.output)
    print(json.dumps({
        "attestationWindowCount": len(attestation["windows"]),
        "snapshotSha256": attestation["snapshot_sha256"],
        "siteCatalogSha256": attestation["site_catalog_sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
