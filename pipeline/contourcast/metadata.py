"""Content-addressed provenance and experiment/model version records."""

from __future__ import annotations

import hashlib
import json
import platform
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    SYNTHETIC_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    is_model_eligible_target,
    target_scope,
    target_version_slug,
    validate_contract_assets,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(value: Mapping[str, Any], length: int = 12) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def _fallback_source_digest(root: Path) -> str:
    """Identify source state even when a Git checkout is unavailable."""

    digest = hashlib.sha256()
    candidates: list[Path] = []
    excluded_parts = {"__pycache__", "node_modules", ".venv", "artifacts", "dist", ".next"}
    source_suffixes = {".py", ".json", ".toml", ".txt", ".md", ".sh", ".yaml", ".yml", ".lock"}
    for directory in ("pipeline", "services/api", "shared", "scripts"):
        base = root / directory
        if base.exists():
            candidates.extend(
                path
                for path in base.rglob("*")
                if path.is_file()
                and not excluded_parts.intersection(path.relative_to(root).parts)
                and (path.suffix in source_suffixes or path.name == "Dockerfile")
            )
    for filename in ("pyproject.toml", "package.json", "package-lock.json"):
        path = root / filename
        if path.is_file():
            candidates.append(path)
    for path in sorted(set(candidates)):
        relative = str(path.relative_to(root)).encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def git_revision(cwd: Path | None = None) -> str:
    root = (cwd or Path(__file__).resolve().parents[2]).resolve()
    try:
        revision = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, stderr=subprocess.DEVNULL, text=True
        ).strip()
        tracked_diff = subprocess.check_output(
            ["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
            cwd=root,
            stderr=subprocess.DEVNULL,
        )
        untracked_output = subprocess.check_output(
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
            cwd=root,
            stderr=subprocess.DEVNULL,
        )
        untracked = [item.decode("utf-8") for item in untracked_output.split(b"\0") if item]
        if not tracked_diff and not untracked:
            return revision
        digest = hashlib.sha256()
        digest.update(b"tracked-diff\0")
        digest.update(tracked_diff)
        for relative in sorted(untracked):
            encoded = relative.encode("utf-8")
            digest.update(b"untracked\0")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
            path = root / relative
            digest.update(bytes.fromhex(sha256_file(path)))
        return f"{revision}-dirty-{digest.hexdigest()}"
    except (OSError, subprocess.CalledProcessError):
        return f"uncommitted-{_fallback_source_digest(root)}"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _version_material(record: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "git_revision": record["git_revision"],
        "command": record["command"],
        "dataset_kind": record["dataset_kind"],
        "model_run_contract_version": record["model_run_contract_version"],
        "observation_contract_version": record["observation_contract_version"],
        "taxon_catalog_version": record["taxon_catalog_version"],
        "target_scope": record["target_scope"],
        "config": record["config"],
        "inputs": [{"sha256": item["sha256"]} for item in record["inputs"]],
    }


def verify_run_record_integrity(
    record: Mapping[str, Any],
    *,
    rehash_inputs: bool = False,
    artifact_paths: Mapping[str, Path] | None = None,
) -> None:
    """Verify self-consistent run identity and optionally rehash promotion inputs.

    ``model_version`` identifies the declared run/configuration/input/code
    material. Artifact byte hashes remain separate values under ``metrics``.
    """

    validate_contract_assets()
    for field, expected in (
        ("schema_version", MODEL_RUN_CONTRACT_VERSION),
        ("model_run_contract_version", MODEL_RUN_CONTRACT_VERSION),
        ("taxon_catalog_version", TAXON_CATALOG_VERSION),
    ):
        if record.get(field) != expected:
            raise ValueError(f"run record {field} is unsupported")
    status = record.get("status")
    if status not in {"unrun", "running", "completed", "failed"}:
        raise ValueError("run record status is invalid")
    command = record.get("command")
    dataset_kind = record.get("dataset_kind")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("run record command must be nonempty")
    if not isinstance(dataset_kind, str) or not dataset_kind.strip():
        raise ValueError("run record dataset_kind must be nonempty")
    target_taxon_id = record.get("target_taxon_id")
    expected_scope = target_scope(target_taxon_id if isinstance(target_taxon_id, str) else None)
    if record.get("target_scope") != expected_scope:
        raise ValueError("run record target scope is inconsistent")
    target_agnostic_kinds = {
        "official_unlabeled_bathymetry",
        "official_seafloor_character_probe",
    }
    if target_taxon_id is None:
        if dataset_kind not in target_agnostic_kinds:
            raise ValueError("target-agnostic scope is not valid for this dataset kind")
        if record.get("observation_contract_version") is not None:
            raise ValueError("target-agnostic runs must disclaim an observation contract")
        environment = None
    elif dataset_kind == "synthetic_fixture":
        environment = "test"
        if target_taxon_id != SYNTHETIC_TARGET_TAXON_ID:
            raise ValueError("synthetic_fixture run target is invalid")
    else:
        environment = "production"
        if dataset_kind in target_agnostic_kinds or target_taxon_id != PRODUCTION_TARGET_TAXON_ID:
            raise ValueError("production run target is invalid")
    if environment is not None:
        if record.get("observation_contract_version") != OBSERVATION_CONTRACT_VERSION:
            raise ValueError("target-specific run observation contract is invalid")
        if not is_model_eligible_target(target_taxon_id, environment=environment):
            raise ValueError("run target is not model eligible")

    config = record.get("config")
    inputs = record.get("inputs")
    metrics = record.get("metrics")
    notes = record.get("notes")
    if not isinstance(config, Mapping):
        raise ValueError("run config must be an object")
    if not isinstance(inputs, list):
        raise ValueError("run inputs must be an array")
    digest_pattern = re.compile(r"^[a-f0-9]{64}$")
    for index, item in enumerate(inputs):
        if not isinstance(item, Mapping):
            raise ValueError(f"run input {index} must be an object")
        path_value = item.get("path")
        digest_value = item.get("sha256")
        bytes_value = item.get("bytes")
        if not isinstance(path_value, str) or not path_value:
            raise ValueError(f"run input {index} has no path")
        if not isinstance(digest_value, str) or digest_pattern.fullmatch(digest_value) is None:
            raise ValueError(f"run input {index} has an invalid digest")
        if isinstance(bytes_value, bool) or not isinstance(bytes_value, int) or bytes_value < 0:
            raise ValueError(f"run input {index} has an invalid byte count")
        if rehash_inputs:
            path = Path(path_value)
            if not path.is_file() or path.stat().st_size != bytes_value or sha256_file(path) != digest_value:
                raise ValueError(f"run input {index} no longer matches recorded provenance")
    if not isinstance(metrics, Mapping):
        raise ValueError("run metrics must be an object")
    if not isinstance(notes, str):
        raise ValueError("run notes must be a string")
    if status == "completed" and (not inputs or not metrics or not notes.strip()):
        raise ValueError("completed runs require nonempty inputs, metrics, and notes")

    material = _version_material(record)
    target_slug = target_version_slug(target_taxon_id if isinstance(target_taxon_id, str) else None)
    expected_experiment = f"exp-{target_slug}-{stable_hash(material, length=64)}"
    expected_model = f"model-{target_slug}-{stable_hash({**material, 'stage': 'model'}, length=64)}"
    if record.get("experiment_version") != expected_experiment:
        raise ValueError("experiment_version does not match recorded run material")
    if record.get("model_version") != expected_model:
        raise ValueError("model_version does not match recorded run material")

    for metric_key, path in (artifact_paths or {}).items():
        expected_digest = metrics.get(metric_key)
        if not isinstance(expected_digest, str) or digest_pattern.fullmatch(expected_digest) is None:
            raise ValueError(f"artifact metric {metric_key!r} is not a SHA-256 digest")
        if not path.is_file() or sha256_file(path) != expected_digest:
            raise ValueError(f"artifact {metric_key!r} does not match recorded SHA-256")


def build_run_record(
    *,
    command: str,
    target_taxon_id: str | None,
    config: Mapping[str, Any],
    input_paths: Iterable[Path] = (),
    dataset_kind: str,
    status: str = "unrun",
    metrics: Mapping[str, Any] | None = None,
    notes: str = "",
) -> Dict[str, Any]:
    validate_contract_assets()
    target_agnostic_kinds = {
        "official_unlabeled_bathymetry",
        "official_seafloor_character_probe",
    }
    if dataset_kind in target_agnostic_kinds:
        if target_taxon_id is not None:
            raise ValueError(f"{dataset_kind} must declare target-agnostic scope")
    elif dataset_kind == "synthetic_fixture":
        if target_taxon_id != SYNTHETIC_TARGET_TAXON_ID or not is_model_eligible_target(
            target_taxon_id, environment="test"
        ):
            raise ValueError("synthetic_fixture runs must target synthetic-target")
    elif target_taxon_id != PRODUCTION_TARGET_TAXON_ID or not is_model_eligible_target(
        str(target_taxon_id), environment="production"
    ):
        raise ValueError("labeled production runs must target California halibut")
    if status not in {"unrun", "running", "completed", "failed"}:
        raise ValueError(f"unsupported run status {status!r}")
    inputs = []
    for path in input_paths:
        resolved = path.resolve()
        inputs.append(
            {
                "path": str(resolved),
                "sha256": sha256_file(resolved),
                "bytes": resolved.stat().st_size,
            }
        )
    code_revision = git_revision()
    version_seed = {
        "git_revision": code_revision,
        "command": command,
        "dataset_kind": dataset_kind,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": (
            OBSERVATION_CONTRACT_VERSION if target_taxon_id is not None else None
        ),
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_scope": target_scope(target_taxon_id),
        "config": dict(config),
        "inputs": [{"sha256": item["sha256"]} for item in inputs],
    }
    target_slug = target_version_slug(target_taxon_id)
    version_digest = stable_hash(version_seed, length=64)
    model_digest = stable_hash({**version_seed, "stage": "model"}, length=64)
    record = {
        "schema_version": MODEL_RUN_CONTRACT_VERSION,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": (
            OBSERVATION_CONTRACT_VERSION if target_taxon_id is not None else None
        ),
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": target_taxon_id,
        "target_scope": target_scope(target_taxon_id),
        "run_id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "status": status,
        "dataset_kind": dataset_kind,
        "command": command,
        "experiment_version": f"exp-{target_slug}-{version_digest}",
        "model_version": f"model-{target_slug}-{model_digest}",
        "git_revision": version_seed["git_revision"],
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
        },
        "config": dict(config),
        "inputs": inputs,
        "metrics": dict(metrics or {}),
        "notes": notes,
    }
    verify_run_record_integrity(record)
    return record


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
    temporary.replace(path)
