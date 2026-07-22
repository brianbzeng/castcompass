"""Load official-source manifests through a fail-closed admissibility policy."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping

from shared.species_contract import SOURCE_ADMISSIBILITY_CONTRACT_VERSION


PIPELINE_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = PIPELINE_ROOT / "sources"
SOURCE_ADMISSIBILITY_POLICY_PATH = PIPELINE_ROOT / "source-admissibility-policy.json"
SOURCE_ADMISSIBILITY_POLICY_ID = "castingcompass-source-admissibility-v1"
SOURCE_ADMISSIBILITY_POLICY_VERSION = "1.0.0"
REQUIRED_FIELDS = {
    "manifest_version",
    "source_id",
    "title",
    "steward",
    "official_landing_page",
    "access",
    "limitations",
}
SOURCE_POLICY_KEYS = {
    "schema_version",
    "policy_id",
    "policy_version",
    "default_decision",
    "current_model_roles",
    "manifest_sources",
    "synthetic_sources",
    "blocked_platforms",
}
SOURCE_ENTRY_KEYS = {
    "source_id",
    "source_class",
    "allowed_operations",
    "supervised_model_training_authorized",
    "model_validation_authorized",
    "production_scoring_authorized",
    "conditions",
}
PLATFORM_ENTRY_KEYS = {
    "platform_id",
    "manifest_source_allowed",
    "automated_collection_allowed",
    "credential_collection_allowed",
    "retrospective_content_import_allowed",
    "social_identity_collection_allowed",
    "model_use_allowed",
    "allowed_interactions",
    "required_before_policy_change",
    "terms_urls",
    "terms_reviewed_at",
}
MODEL_AUTHORIZATION_FIELDS = (
    "supervised_model_training_authorized",
    "model_validation_authorized",
    "production_scoring_authorized",
)
PLATFORM_DENY_FIELDS = (
    "manifest_source_allowed",
    "automated_collection_allowed",
    "credential_collection_allowed",
    "retrospective_content_import_allowed",
    "social_identity_collection_allowed",
    "model_use_allowed",
)
EXPECTED_MANIFEST_SOURCES = {
    "castingcompass-trip-log": ("first-party-private", ("observation-normalization",)),
    "cdfw_crfs": ("official-survey-export", ("observation-normalization",)),
    "cdfw_crfs_ds3185": ("official-aggregate-context", ("descriptive-context",)),
    "cdfw_crfs_ds3186": ("official-aggregate-context", ("descriptive-context",)),
    "noaa_bluetopo": ("official-bathymetry", ("bathymetry-ingest", "terrain-pretraining")),
    "noaa_ncei_cudem": ("official-bathymetry", ("bathymetry-ingest", "terrain-pretraining")),
    "psmfc_recfin": ("official-survey-export", ("observation-normalization",)),
    "usgs_central_bay_multibeam": (
        "official-bathymetry",
        ("bathymetry-ingest", "terrain-pretraining"),
    ),
    "usgs_ds182_pacific_ext_sediment": (
        "official-sediment-measurement",
        ("endpoint-support-audit",),
    ),
    "usgs_ds781_residual_video_observations": (
        "official-video-observation",
        ("endpoint-support-audit",),
    ),
    "usgs_sf_state_waters_2m": (
        "official-bathymetry",
        ("bathymetry-ingest", "terrain-pretraining"),
    ),
    "usgs_santa_barbara_south_coast_2m": (
        "official-bathymetry",
        (
            "bathymetry-ingest",
            "terrain-pretraining",
            "endpoint-support-footprint",
        ),
    ),
}
EXPECTED_SYNTHETIC_SOURCES = {
    "synthetic_fixture": (
        "synthetic-test",
        ("observation-normalization", "terrain-pretraining"),
    )
}
EXPECTED_BLOCKED_PLATFORMS = {
    "facebook-groups": {
        "allowed_interactions": ("outbound-link", "admin-approved-prospective-recruitment"),
        "required_before_policy_change": (
            "Meta express written permission for any automated collection and use",
            "group-administrator written approval for prospective recruitment",
            "participant opt-in submitted directly to CastingCompass",
            "documented license, privacy, deletion, security, sampling, and permitted-use review",
            "a separately protected source-policy update before any manifest or ingestion code",
        ),
        "terms_urls": (
            "https://www.facebook.com/legal/terms",
            "https://www.facebook.com/legal/automated_data_collection_terms",
        ),
        "terms_reviewed_at": "2026-07-18",
    },
    "fishbrain": {
        "allowed_interactions": (
            "outbound-link",
            "user-supplied-plain-url-without-fetch",
            "written-license-partnership-review",
        ),
        "required_before_policy_change": (
            "Fishbrain written commercial license and data-use terms",
            "an approved supported feed or API with exact scopes",
            "documented content rights, attribution, privacy, retention, deletion, and security review",
            "documented attempt completeness, coverage, sampling propensity, and intended model role",
            "a separately protected source-policy update before any manifest or ingestion code",
        ),
        "terms_urls": ("https://fishbrain.com/policies/terms-of-service/latest",),
        "terms_reviewed_at": "2026-07-18",
    },
}


def _require_exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise ValueError(
            f"{label} fields disagree with the locked policy: "
            f"missing={sorted(expected - actual)}, extra={sorted(actual - expected)}"
        )


def _require_exact_list(value: Any, expected: tuple[str, ...], label: str) -> None:
    if not isinstance(value, list) or value != list(expected):
        raise ValueError(f"{label} disagrees with the locked policy")


def _validate_source_entries(
    raw_entries: Any,
    expected: Mapping[str, tuple[str, tuple[str, ...]]],
    label: str,
) -> None:
    if not isinstance(raw_entries, list):
        raise ValueError(f"{label} must be an array")
    expected_ids = list(expected)
    actual_ids = [entry.get("source_id") if isinstance(entry, dict) else None for entry in raw_entries]
    if actual_ids != expected_ids:
        raise ValueError(f"{label} source IDs or order disagree with the locked policy")
    for entry in raw_entries:
        if not isinstance(entry, dict):
            raise ValueError(f"{label} entries must be objects")
        source_id = str(entry["source_id"])
        _require_exact_keys(entry, SOURCE_ENTRY_KEYS, f"source {source_id!r}")
        expected_class, expected_operations = expected[source_id]
        if entry["source_class"] != expected_class:
            raise ValueError(f"source {source_id!r} class disagrees with the locked policy")
        _require_exact_list(
            entry["allowed_operations"],
            expected_operations,
            f"source {source_id!r} operations",
        )
        for field in MODEL_AUTHORIZATION_FIELDS:
            if entry[field] is not False:
                raise ValueError(f"source {source_id!r} cannot authorize {field}")
        conditions = entry["conditions"]
        if (
            not isinstance(conditions, list)
            or not conditions
            or any(not isinstance(condition, str) or not condition.strip() for condition in conditions)
            or len(set(conditions)) != len(conditions)
        ):
            raise ValueError(f"source {source_id!r} conditions must be unique non-empty strings")


def validate_source_admissibility_policy(policy: Mapping[str, Any]) -> None:
    """Validate the exact launch source inventory and its fail-closed decisions."""

    _require_exact_keys(policy, SOURCE_POLICY_KEYS, "source admissibility policy")
    if policy["schema_version"] != SOURCE_ADMISSIBILITY_CONTRACT_VERSION:
        raise ValueError("source admissibility schema version disagrees with the Python contract")
    if policy["policy_id"] != SOURCE_ADMISSIBILITY_POLICY_ID:
        raise ValueError("source admissibility policy ID is not recognized")
    if policy["policy_version"] != SOURCE_ADMISSIBILITY_POLICY_VERSION:
        raise ValueError("source admissibility policy version is not recognized")
    if policy["default_decision"] != "deny":
        raise ValueError("source admissibility must default to deny")

    current_roles = policy["current_model_roles"]
    if not isinstance(current_roles, dict):
        raise ValueError("current_model_roles must be an object")
    _require_exact_keys(
        current_roles,
        {*MODEL_AUTHORIZATION_FIELDS, "reason"},
        "current_model_roles",
    )
    for field in MODEL_AUTHORIZATION_FIELDS:
        if current_roles[field] is not False:
            raise ValueError(f"current source policy cannot authorize {field}")
    if current_roles["reason"] != "no-current-source-has-separately-approved-confirmatory-model-evidence":
        raise ValueError("current source-policy denial reason is not recognized")

    _validate_source_entries(
        policy["manifest_sources"],
        EXPECTED_MANIFEST_SOURCES,
        "manifest_sources",
    )
    _validate_source_entries(
        policy["synthetic_sources"],
        EXPECTED_SYNTHETIC_SOURCES,
        "synthetic_sources",
    )

    blocked = policy["blocked_platforms"]
    if not isinstance(blocked, list):
        raise ValueError("blocked_platforms must be an array")
    expected_platform_ids = list(EXPECTED_BLOCKED_PLATFORMS)
    actual_platform_ids = [entry.get("platform_id") if isinstance(entry, dict) else None for entry in blocked]
    if actual_platform_ids != expected_platform_ids:
        raise ValueError("blocked platform IDs or order disagree with the locked policy")
    for entry in blocked:
        if not isinstance(entry, dict):
            raise ValueError("blocked platform entries must be objects")
        platform_id = str(entry["platform_id"])
        _require_exact_keys(entry, PLATFORM_ENTRY_KEYS, f"platform {platform_id!r}")
        for field in PLATFORM_DENY_FIELDS:
            if entry[field] is not False:
                raise ValueError(f"platform {platform_id!r} cannot authorize {field}")
        expected_platform = EXPECTED_BLOCKED_PLATFORMS[platform_id]
        for field in ("allowed_interactions", "required_before_policy_change", "terms_urls"):
            _require_exact_list(
                entry[field],
                expected_platform[field],  # type: ignore[arg-type]
                f"platform {platform_id!r} {field}",
            )
        if entry["terms_reviewed_at"] != expected_platform["terms_reviewed_at"]:
            raise ValueError(f"platform {platform_id!r} terms review date is not recognized")


def source_policy_sha256(policy: Mapping[str, Any]) -> str:
    """Return a deterministic digest after the policy passes semantic validation."""

    validate_source_admissibility_policy(policy)
    canonical = json.dumps(policy, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_source_admissibility_policy(
    policy_path: Path | None = None,
) -> Mapping[str, Any]:
    path = policy_path or SOURCE_ADMISSIBILITY_POLICY_PATH
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"source admissibility policy is unavailable or invalid: {path}") from error
    if not isinstance(policy, dict):
        raise ValueError("source admissibility policy must be a JSON object")
    validate_source_admissibility_policy(policy)
    return policy


def assert_source_operation(
    source_id: str,
    operation: str,
    *,
    policy_path: Path | None = None,
) -> None:
    """Deny an operation unless the exact source and operation are allowlisted."""

    policy = load_source_admissibility_policy(policy_path)
    entries = [*policy["manifest_sources"], *policy["synthetic_sources"]]
    entry = next((candidate for candidate in entries if candidate["source_id"] == source_id), None)
    if entry is None:
        raise ValueError(f"source {source_id!r} is not admitted by the locked source policy")
    if operation not in entry["allowed_operations"]:
        raise ValueError(f"source {source_id!r} is not admitted for operation {operation!r}")


def load_source_manifests(
    source_dir: Path | None = None,
    *,
    policy_path: Path | None = None,
) -> Dict[str, Mapping[str, object]]:
    policy = load_source_admissibility_policy(policy_path)
    root = source_dir or SOURCE_DIR
    manifests: Dict[str, Mapping[str, object]] = {}
    for path in sorted(root.glob("*.json")):
        with path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        missing = REQUIRED_FIELDS - set(manifest)
        if missing:
            raise ValueError(f"{path} is missing manifest fields: {sorted(missing)}")
        source_id = str(manifest["source_id"])
        if source_id in manifests:
            raise ValueError(f"duplicate source_id {source_id!r}")
        manifests[source_id] = manifest
    if not manifests:
        raise ValueError(f"no source manifests found under {root}")
    admitted_ids = {entry["source_id"] for entry in policy["manifest_sources"]}
    if set(manifests) != admitted_ids:
        raise ValueError(
            "manifest inventory disagrees with the locked source policy: "
            f"missing={sorted(admitted_ids - set(manifests))}, "
            f"unreviewed={sorted(set(manifests) - admitted_ids)}"
        )
    return manifests


def get_source_manifest(source_id: str) -> Mapping[str, object]:
    manifests = load_source_manifests()
    try:
        return manifests[source_id]
    except KeyError as error:
        raise ValueError(
            f"unknown source_id {source_id!r}; choose from {sorted(manifests)}"
        ) from error


def summarize_sources() -> Iterable[Mapping[str, object]]:
    policy = load_source_admissibility_policy()
    operations = {
        entry["source_id"]: tuple(entry["allowed_operations"])
        for entry in policy["manifest_sources"]
    }
    for manifest in load_source_manifests().values():
        yield {
            "source_id": manifest["source_id"],
            "title": manifest["title"],
            "steward": manifest["steward"],
            "official_landing_page": manifest["official_landing_page"],
            "access_mode": manifest["access"]["mode"],  # type: ignore[index]
            "allowed_operations": operations[manifest["source_id"]],  # type: ignore[index]
        }
