"""Content-addressed provenance and experiment/model version records."""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(value: Mapping[str, Any], length: int = 12) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def git_revision(cwd: Path | None = None) -> str:
    try:
        revision = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=cwd, stderr=subprocess.DEVNULL, text=True
        ).strip()
        dirty = subprocess.check_output(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return f"{revision}-dirty" if dirty else revision
    except (OSError, subprocess.CalledProcessError):
        return "uncommitted"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_run_record(
    *,
    command: str,
    config: Mapping[str, Any],
    input_paths: Iterable[Path] = (),
    dataset_kind: str,
    status: str = "unrun",
    metrics: Mapping[str, Any] | None = None,
    notes: str = "",
) -> Dict[str, Any]:
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
    version_seed = {
        "git_revision": git_revision(),
        "config": dict(config),
        "inputs": [{"sha256": item["sha256"]} for item in inputs],
    }
    return {
        "schema_version": "1.0",
        "run_id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "status": status,
        "dataset_kind": dataset_kind,
        "command": command,
        "experiment_version": f"exp-{stable_hash(version_seed)}",
        "model_version": f"model-{stable_hash({**version_seed, 'stage': 'model'})}",
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


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
    temporary.replace(path)
