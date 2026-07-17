"""Canonical Python access to CastingCompass species-contract identity.

The JSON files under ``contracts/`` remain the language-neutral source of
truth. This module centralizes Python consumers and verifies that its stable
constants have not drifted from those assets.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping


TAXON_CATALOG_VERSION = "castingcompass.taxa/1.0.0"
OBSERVATION_CONTRACT_VERSION = "castingcompass.observation/2.0.0"
MODEL_RUN_CONTRACT_VERSION = "castingcompass.model-run/2.0.0"
OPPORTUNITY_CONTRACT_VERSION = "castingcompass.opportunity/2.0.0"

PRODUCTION_TARGET_TAXON_ID = "california-halibut"
UNRESOLVED_TAXON_ID = "unresolved-fish"
SYNTHETIC_TARGET_TAXON_ID = "synthetic-target"

# These exact identifiers are shared with ``MODEL_PROJECTED_CRS_IDS`` in the
# TypeScript contract. Model-bound point observations fail closed on this
# allowlist even when optional CRS inspection libraries are unavailable.
MODEL_PROJECTED_CRS_IDS = ("EPSG:26910", "EPSG:32610")
JSON_SAFE_INTEGER_MAX = 2**53 - 1
OFFSET_DATE_TIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_ROOT = REPOSITORY_ROOT / "contracts"


def is_strict_offset_datetime(value: Any) -> bool:
    """Return whether ``value`` is a real strict ISO timestamp with an offset."""

    if not isinstance(value, str) or OFFSET_DATE_TIME_PATTERN.fullmatch(value) is None:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


@lru_cache(maxsize=1)
def load_taxon_catalog() -> Mapping[str, Any]:
    path = CONTRACT_ROOT / "taxa.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Canonical taxon catalog is unavailable or invalid: {path}") from exc
    if not isinstance(document, dict):
        raise RuntimeError("Canonical taxon catalog must be a JSON object")
    return document


def _catalog_version(catalog: Mapping[str, Any]) -> Any:
    return catalog.get("contract_version", catalog.get("version"))


def _catalog_taxa(catalog: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw = catalog.get("taxa")
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise RuntimeError("Canonical taxon catalog must contain a taxa array")
    return raw


@lru_cache(maxsize=1)
def validate_contract_assets() -> None:
    """Fail if machine-readable contracts and Python consumers disagree."""

    catalog = load_taxon_catalog()
    if _catalog_version(catalog) != TAXON_CATALOG_VERSION:
        raise RuntimeError("Taxon catalog version disagrees with Python contract identity")
    taxa = {str(item.get("taxon_id")): item for item in _catalog_taxa(catalog)}
    if set(taxa) != {
        PRODUCTION_TARGET_TAXON_ID,
        UNRESOLVED_TAXON_ID,
        SYNTHETIC_TARGET_TAXON_ID,
    }:
        raise RuntimeError("Taxon catalog IDs disagree with the locked launch taxonomy")
    if not bool(taxa[PRODUCTION_TARGET_TAXON_ID].get("model_eligible")):
        raise RuntimeError("California halibut must be model eligible")
    if bool(taxa[UNRESOLVED_TAXON_ID].get("model_eligible")):
        raise RuntimeError("Unresolved fish cannot be model eligible")
    if bool(taxa[SYNTHETIC_TARGET_TAXON_ID].get("production_observation_eligible")):
        raise RuntimeError("Synthetic target cannot be production eligible")

    expected_schema_versions = {
        "observation.schema.json": OBSERVATION_CONTRACT_VERSION,
        "model-run.schema.json": MODEL_RUN_CONTRACT_VERSION,
        "opportunity.schema.json": OPPORTUNITY_CONTRACT_VERSION,
    }
    for filename, version in expected_schema_versions.items():
        path = CONTRACT_ROOT / filename
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Canonical schema is unavailable or invalid: {path}") from exc
        actual = schema.get("$id", schema.get("contract_version", schema.get("version")))
        if actual != version:
            raise RuntimeError(f"{filename} does not declare {version}")


def is_known_taxon(taxon_id: str) -> bool:
    validate_contract_assets()
    return any(item.get("taxon_id") == taxon_id for item in _catalog_taxa(load_taxon_catalog()))


def is_model_eligible_target(taxon_id: str, *, environment: str) -> bool:
    """Return catalog eligibility without treating test taxa as production taxa."""

    validate_contract_assets()
    item = next(
        (entry for entry in _catalog_taxa(load_taxon_catalog()) if entry.get("taxon_id") == taxon_id),
        None,
    )
    if item is None or not bool(item.get("model_eligible")):
        return False
    environments = item.get("environments")
    if not isinstance(environments, list) or environment not in environments:
        return False
    if environment == "production":
        return taxon_id == PRODUCTION_TARGET_TAXON_ID
    return environment == "test"


def is_observation_eligible(taxon_id: str, *, environment: str) -> bool:
    """Check observation eligibility, including production/test separation."""

    validate_contract_assets()
    item = next(
        (entry for entry in _catalog_taxa(load_taxon_catalog()) if entry.get("taxon_id") == taxon_id),
        None,
    )
    if item is None or not bool(item.get("observation_eligible")):
        return False
    environments = item.get("environments")
    if not isinstance(environments, list) or environment not in environments:
        return False
    if environment == "production":
        return bool(item.get("production_observation_eligible"))
    return environment == "test"


def target_scope(target_taxon_id: str | None) -> dict[str, str | None]:
    if target_taxon_id is None:
        return {"kind": "target-agnostic", "taxon_id": None}
    return {"kind": "taxon", "taxon_id": target_taxon_id}


def target_version_slug(target_taxon_id: str | None) -> str:
    return target_taxon_id or "target-agnostic"
