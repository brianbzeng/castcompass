"""Frozen first-party site-by-window validation evaluator.

The candidate is an ordinal heuristic score, not a calibrated probability.
Accordingly the primary analysis is AUROC concordance and intentionally omits
probability metrics such as Brier score, log loss, and calibration error.
"""

from __future__ import annotations

import hashlib
import math
import secrets
from collections import Counter, defaultdict
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

from .validation_protocol import (
    DEFAULT_PROTOCOL_PATH,
    PUBLICATION_REQUEST_FIELDS,
    _assignment_projection,
    _parse_datetime,
    canonical_sha256,
    label_free_snapshot_sha256,
    load_deletion_reconciliation_chain,
    load_publication_reconciliation_audit,
    load_signed_labeled_export,
    load_trusted_census_export,
    load_manifest_chain,
    load_split_manifest,
    load_validation_evidence,
    load_validation_protocol,
    read_private_bytes_once,
    sha256_file,
    require_private_file,
    strict_json_loads,
    utc_now,
    validate_label_free_prediction_artifacts,
    verify_release_commit_contains_protocol,
    verify_frozen_evaluator_identity,
    write_private_json_new,
    trusted_utc_now,
    validate_label_lock_extension,
)


OUTCOME_FIELDS = {"outcome_class", "target_encounter_count", "target_encountered"}


def _without_outcomes(item: Mapping[str, Any]) -> dict[str, Any]:
    return {key: deepcopy(value) for key, value in item.items() if key not in OUTCOME_FIELDS}


def _sorted_rows(rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(rows, key=lambda item: str(item["assignment_id"]))


def _write_new_json(path: Path, value: Mapping[str, Any]) -> None:
    write_private_json_new(path, value)


def _write_or_verify_json(path: Path, value: Mapping[str, Any], *, artifact: str) -> None:
    if not path.exists():
        _write_new_json(path, value)
        return
    require_private_file(path, artifact=artifact)
    try:
        existing = strict_json_loads(
            read_private_bytes_once(path, artifact=artifact), artifact=artifact
        )
    except (OSError, ValueError) as exc:
        raise ValueError(f"existing {artifact} is invalid") from exc
    if existing != value:
        raise ValueError(f"existing {artifact} binds a different evaluation")


def _assert_same_assignment_projection(
    evidence: Sequence[Mapping[str, Any]],
    assignments: Sequence[Mapping[str, Any]],
    protocol: Mapping[str, Any],
) -> None:
    projection = sorted(
        (_assignment_projection(item, protocol) for item in evidence),
        key=lambda item: str(item["assignment_id"]),
    )
    if projection != list(assignments):
        raise ValueError("evidence identity does not exactly match the sealed split assignments")


def _assert_root_identity(
    evidence: Sequence[Mapping[str, Any]], activation: Mapping[str, Any]
) -> None:
    for item in evidence:
        if item["cohort_role"] not in {"primary", "secondary"}:
            continue
        identity = item["evidence"]
        if (
            identity["scoring_system_kind"] != activation["scoring_system_kind"]
            or identity["scoring_system_version"] != activation["scoring_system_version"]
            or identity["scoring_system_sha256"] != activation["scoring_system_sha256"]
            or identity["opportunity_contract_version"]
            != activation["opportunity_contract_version"]
        ):
            raise ValueError("primary evidence scoring identity differs from root activation")


def _load_or_create_label_lock(
    *,
    split: Mapping[str, Any],
    path: Path,
    protocol: Mapping[str, Any],
    protocol_sha256: str,
) -> dict[str, Any]:
    if not path.exists():
        raise ValueError(
            "a durable label lock must be sealed before requesting the signed labeled export"
        )
    locked = load_split_manifest(path, protocol, protocol_sha256)
    if locked["manifest_role"] != "label-lock":
        raise ValueError("existing label-lock path is not a label-lock manifest")
    return validate_label_lock_extension(locked, split)


def _load_or_create_label_access_receipt(
    *,
    path: Path,
    label_lock: Mapping[str, Any],
    finalization: Mapping[str, Any],
    deletion: Mapping[str, Any],
    labeled_evidence_file_sha256: str,
) -> dict[str, Any]:
    """Bind the exact raw labeled bytes before any label payload is parsed."""

    expected = {
        "schema_version": "castingcompass.validation-label-access-receipt/1.0.0",
        "label_lock_manifest_sha256": canonical_sha256(label_lock),
        "finalization_manifest_sha256": canonical_sha256(finalization),
        "deletion_reconciliation_sha256": deletion["ledger_sha256"],
        "deletion_reconciliation_chain_sha256": deletion["chain_sha256"],
        "labeled_evidence_file_sha256": labeled_evidence_file_sha256,
        "labels_opened_at": label_lock["labels_opened_at"],
    }
    if path.exists():
        require_private_file(path, artifact="label-access receipt")
        try:
            receipt = strict_json_loads(
                read_private_bytes_once(path, artifact="label-access receipt"),
                artifact="label-access receipt",
            )
        except (OSError, ValueError) as exc:
            raise ValueError("existing label-access receipt is invalid") from exc
        if receipt != expected:
            raise ValueError("label-access receipt already binds different labeled bytes or reconciliation")
        return receipt
    _write_new_json(path, expected)
    return expected


def _load_or_create_publication_request(
    *, path: Path, expected_bindings: Mapping[str, Any]
) -> dict[str, Any]:
    """Create one immutable, nonce-bearing request or verify the exact prior one."""

    if path.exists():
        require_private_file(path, artifact="publication audit request")
        request = strict_json_loads(
            read_private_bytes_once(path, artifact="publication audit request"),
            artifact="publication audit request",
            reject_floats=True,
        )
    else:
        request = {
            "schema_version": "castingcompass.validation-publication-audit-request/1.0.0",
            "publication_request_nonce": secrets.token_hex(32),
            "requested_at": utc_now(),
            **deepcopy(dict(expected_bindings)),
        }
        _write_new_json(path, request)
    if not isinstance(request, dict) or set(request) != PUBLICATION_REQUEST_FIELDS:
        raise ValueError("publication audit request shape is invalid")
    if request.get("schema_version") != (
        "castingcompass.validation-publication-audit-request/1.0.0"
    ):
        raise ValueError("publication audit request schema is invalid")
    reconciliation_counts = request.get("reconciliation_counts")
    if (
        request.get("append_only_log_proof_included") is not True
        or not isinstance(reconciliation_counts, dict)
        or set(reconciliation_counts)
        != {"active", "withdrawn", "deleted", "excluded"}
        or any(
            type(count) is not int or count < 0
            for count in reconciliation_counts.values()
        )
    ):
        raise ValueError("publication audit request proof/count types are invalid")
    if any(request.get(key) != value for key, value in expected_bindings.items()):
        raise ValueError("publication audit request already binds a different analysis state")
    nonce = request.get("publication_request_nonce")
    if (
        not isinstance(nonce, str)
        or len(nonce) != 64
        or any(character not in "0123456789abcdef" for character in nonce)
    ):
        raise ValueError("publication audit request nonce is invalid")
    requested = _parse_datetime(
        request.get("requested_at"), location="publication_request.requested_at"
    )
    minimum = _parse_datetime(
        request.get("minimum_checked_at"),
        location="publication_request.minimum_checked_at",
    )
    if requested < minimum or requested > trusted_utc_now():
        raise ValueError("publication audit request chronology is invalid")
    return request


def _binary_metric(y: Sequence[int], score: Sequence[float], metric: str) -> float | None:
    labels = np.asarray(y, dtype=np.int8)
    values = np.asarray(score, dtype=np.float64)
    if labels.size == 0 or np.unique(labels).size < 2:
        return None
    if metric == "auroc":
        return float(roc_auc_score(labels, values))
    if metric == "average-precision":
        return float(average_precision_score(labels, values))
    raise AssertionError(metric)


def _calendar_numeric(row: Mapping[str, Any]) -> list[float]:
    start = _parse_datetime(
        row["evidence"]["window_start_at"], location="evidence.window_start_at"
    )
    seconds = start.hour * 3600 + start.minute * 60 + start.second + start.microsecond / 1e6
    day = start.timetuple().tm_yday - 1 + seconds / 86400.0
    day_angle = 2.0 * math.pi * day / 365.2425
    hour_angle = 2.0 * math.pi * seconds / 86400.0
    return [
        math.sin(day_angle),
        math.cos(day_angle),
        math.sin(hour_angle),
        math.cos(hour_angle),
        math.log1p(float(row["angler_hours"])),
    ]


def _design_matrix(
    rows: Sequence[Mapping[str, Any]],
    *,
    numeric_mean: np.ndarray,
    numeric_scale: np.ndarray,
    modes: Sequence[str],
    sites: Sequence[str],
) -> np.ndarray:
    if not rows:
        return np.empty((0, 5 + len(modes) + len(sites)), dtype=np.float64)
    numeric = np.asarray([_calendar_numeric(row) for row in rows], dtype=np.float64)
    numeric = (numeric - numeric_mean) / numeric_scale
    mode_index = {value: index for index, value in enumerate(modes)}
    site_index = {value: index for index, value in enumerate(sites)}
    one_hot = np.zeros((len(rows), len(modes) + len(sites)), dtype=np.float64)
    for row_index, row in enumerate(rows):
        mode = str(row["evidence"]["mode"])
        if mode in mode_index:
            one_hot[row_index, mode_index[mode]] = 1.0
        site = str(row["site_id"])
        if site in site_index:
            one_hot[row_index, len(modes) + site_index[site]] = 1.0
    return np.concatenate([numeric, one_hot], axis=1)


def _beta_prevalence(rows: Sequence[Mapping[str, Any]], alpha: float, beta: float) -> float:
    positives = sum(int(item["target_encountered"]) for item in rows)
    return float((positives + alpha) / (len(rows) + alpha + beta))


def _fit_predict_baseline(
    baseline: Mapping[str, Any],
    train: Sequence[Mapping[str, Any]],
    predict: Sequence[Mapping[str, Any]],
    diagnostics: list[dict[str, Any]] | None = None,
) -> list[float]:
    hyperparameters = baseline["hyperparameters"]
    fallback = _beta_prevalence(train, 1.0, 1.0)
    if baseline["baseline_id"] == "prevalence-only":
        value = _beta_prevalence(
            train,
            float(hyperparameters["alpha"]),
            float(hyperparameters["beta"]),
        )
        return [value] * len(predict)
    train_y = np.asarray([int(item["target_encountered"]) for item in train], dtype=np.int8)
    if not train or np.unique(train_y).size < 2:
        return [fallback] * len(predict)
    train_numeric = np.asarray([_calendar_numeric(row) for row in train], dtype=np.float64)
    mean = train_numeric.mean(axis=0)
    scale = train_numeric.std(axis=0)
    scale[scale == 0.0] = 1.0
    modes = sorted({str(row["evidence"]["mode"]) for row in train})
    sites = (
        sorted({str(row["site_id"]) for row in train})
        if baseline["baseline_id"] == "site-calendar-mode-effort-logistic"
        else []
    )
    train_x = _design_matrix(
        train, numeric_mean=mean, numeric_scale=scale, modes=modes, sites=sites
    )
    predict_x = _design_matrix(
        predict, numeric_mean=mean, numeric_scale=scale, modes=modes, sites=sites
    )
    if hyperparameters["penalty"] != "l2":
        raise ValueError("frozen logistic baselines require the L2 penalty")
    model = LogisticRegression(
        C=float(hyperparameters["C"]),
        solver=hyperparameters["solver"],
        class_weight=hyperparameters["class_weight"],
        fit_intercept=bool(hyperparameters["fit_intercept"]),
        intercept_scaling=float(hyperparameters["intercept_scaling"]),
        tol=float(hyperparameters["tol"]),
        max_iter=int(hyperparameters["max_iter"]),
        random_state=int(hyperparameters["random_state"]),
    )
    model.fit(train_x, train_y)
    if diagnostics is not None:
        diagnostics.append(
            {
                "baseline_id": baseline["baseline_id"],
                "iterations": int(np.max(model.n_iter_)),
                "maximum_iterations": int(hyperparameters["max_iter"]),
                "converged": bool(np.max(model.n_iter_) < int(hyperparameters["max_iter"])),
            }
        )
    return [float(value) for value in model.predict_proba(predict_x)[:, 1]]


def _select_baseline(
    protocol: Mapping[str, Any],
    dev: Sequence[Mapping[str, Any]],
    diagnostics: list[dict[str, Any]] | None = None,
) -> tuple[Mapping[str, Any], dict[str, Any], bool]:
    panels = [str(panel["panel_id"]) for panel in protocol["geography"]["panels"]]
    summaries: dict[str, Any] = {}
    definitions = protocol["baselines"]["definitions"]
    for baseline in definitions:
        per_panel: dict[str, float | None] = {}
        for panel in panels:
            train = [item for item in dev if item["geographic_panel"] != panel]
            held = [item for item in dev if item["geographic_panel"] == panel]
            predictions = _fit_predict_baseline(baseline, train, held, diagnostics)
            per_panel[panel] = _binary_metric(
                [int(item["target_encountered"]) for item in held], predictions, "auroc"
            )
        estimable = [value for value in per_panel.values() if value is not None]
        summaries[str(baseline["baseline_id"])] = {
            "per_panel_auroc": per_panel,
            "mean_leave_one_panel_out_auroc": (
                float(np.mean(estimable)) if estimable else None
            ),
            "estimable_panels": len(estimable),
        }
    tie_order = list(protocol["baselines"]["tie_break_order"])
    definitions_by_id = {str(item["baseline_id"]): item for item in definitions}
    best_id = max(
        tie_order,
        key=lambda baseline_id: (
            summaries[baseline_id]["mean_leave_one_panel_out_auroc"]
            if summaries[baseline_id]["mean_leave_one_panel_out_auroc"] is not None
            else -math.inf,
            -tie_order.index(baseline_id),
        ),
    )
    all_estimable = all(
        summary["estimable_panels"] == len(panels) for summary in summaries.values()
    )
    return definitions_by_id[best_id], summaries, all_estimable


def _held_geography_predictions(
    protocol: Mapping[str, Any],
    baseline: Mapping[str, Any],
    dev: Sequence[Mapping[str, Any]],
    test: Sequence[Mapping[str, Any]],
    diagnostics: list[dict[str, Any]] | None = None,
) -> tuple[list[Mapping[str, Any]], list[float]]:
    rows: list[Mapping[str, Any]] = []
    predictions: list[float] = []
    for panel in [str(item["panel_id"]) for item in protocol["geography"]["panels"]]:
        train = [item for item in dev if item["geographic_panel"] != panel]
        held = _sorted_rows([item for item in test if item["geographic_panel"] == panel])
        rows.extend(held)
        predictions.extend(_fit_predict_baseline(baseline, train, held, diagnostics))
    return rows, predictions


def _participant_cluster_support(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    counts = Counter(str(row["participant_group_id"]) for row in rows)
    if any(row.get("participant_group_id") is None for row in rows):
        raise ValueError("primary support evidence lacks participant grouping")
    attempts = len(rows)
    squared_count_sum = sum(count * count for count in counts.values())
    maximum_count = max(counts.values(), default=0)
    return {
        "attempts": attempts,
        "unique_participant_groups": len(counts),
        "kish_effective_participant_groups_numerator": attempts * attempts,
        "kish_effective_participant_groups_denominator": squared_count_sum,
        "effective_participant_groups_kish": (
            float(attempts * attempts / squared_count_sum)
            if squared_count_sum
            else 0.0
        ),
        "maximum_single_participant_attempts": maximum_count,
        "maximum_single_participant_attempt_share": (
            float(maximum_count / attempts) if attempts else None
        ),
    }


def _participant_cluster_gate(
    support: Mapping[str, Any],
    *,
    minimum_unique: int,
    minimum_effective: int,
    maximum_share_numerator: int,
    maximum_share_denominator: int,
) -> bool:
    attempts = int(support["attempts"])
    maximum_count = int(support["maximum_single_participant_attempts"])
    effective_numerator = int(
        support["kish_effective_participant_groups_numerator"]
    )
    effective_denominator = int(
        support["kish_effective_participant_groups_denominator"]
    )
    return (
        attempts > 0
        and int(support["unique_participant_groups"]) >= minimum_unique
        and effective_numerator >= minimum_effective * effective_denominator
        and maximum_count * maximum_share_denominator
        <= attempts * maximum_share_numerator
    )


def _bootstrap(
    rows: Sequence[Mapping[str, Any]],
    candidate: Sequence[float],
    baseline: Sequence[float],
    *,
    resamples: int,
    random_state: int,
    maximum_draws: int,
    minimum_participant_groups: int = 100,
    minimum_effective_participant_groups: int = 75,
    minimum_target_encounter_participant_groups: int = 20,
    minimum_target_encounter_effective_participant_groups: int = 15,
    minimum_non_encounter_participant_groups: int = 40,
    minimum_non_encounter_effective_participant_groups: int = 30,
    maximum_single_participant_share_numerator: int = 1,
    maximum_single_participant_share_denominator: int = 10,
) -> dict[str, Any]:
    clusters: dict[str, list[int]] = defaultdict(list)
    participant_strata: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for index, row in enumerate(rows):
        participant = row["participant_group_id"]
        if participant is None:
            raise ValueError("primary bootstrap evidence lacks participant grouping")
        stratum = (str(row["geographic_panel"]), str(row["temporal_block"]))
        clusters[str(participant)].append(index)
        participant_strata[str(participant)].add(stratum)
    cross_stratum_participants = sum(
        len(participant_groups) > 1 for participant_groups in participant_strata.values()
    )
    support = _participant_cluster_support(rows)
    outcome_support = {
        "target_encountered": _participant_cluster_support(
            [row for row in rows if int(row["target_encountered"]) == 1]
        ),
        "non_encounter": _participant_cluster_support(
            [row for row in rows if int(row["target_encountered"]) == 0]
        ),
    }
    if not (
        _participant_cluster_gate(
            support,
            minimum_unique=minimum_participant_groups,
            minimum_effective=minimum_effective_participant_groups,
            maximum_share_numerator=maximum_single_participant_share_numerator,
            maximum_share_denominator=maximum_single_participant_share_denominator,
        )
        and _participant_cluster_gate(
            outcome_support["target_encountered"],
            minimum_unique=minimum_target_encounter_participant_groups,
            minimum_effective=minimum_target_encounter_effective_participant_groups,
            maximum_share_numerator=maximum_single_participant_share_numerator,
            maximum_share_denominator=maximum_single_participant_share_denominator,
        )
        and _participant_cluster_gate(
            outcome_support["non_encounter"],
            minimum_unique=minimum_non_encounter_participant_groups,
            minimum_effective=minimum_non_encounter_effective_participant_groups,
            maximum_share_numerator=maximum_single_participant_share_numerator,
            maximum_share_denominator=maximum_single_participant_share_denominator,
        )
    ):
        return {
            "status": "inconclusive",
            "reason": "insufficient-independent-participant-cluster-support",
            "valid_resamples": 0,
            "draws": 0,
            "required_resamples": resamples,
            "maximum_draws": maximum_draws,
            "resampling_unit": "global-participant-cluster-across-all-panels-and-blocks",
            "cross_stratum_participants": cross_stratum_participants,
            "participant_cluster_support": {
                "all": support,
                "by_outcome_class": outcome_support,
            },
            "bit_generator": "PCG64",
            "percentile_method": "linear",
        }
    y = np.asarray([int(row["target_encountered"]) for row in rows], dtype=np.int8)
    candidate_array = np.asarray(candidate, dtype=np.float64)
    baseline_array = np.asarray(baseline, dtype=np.float64)
    random = np.random.Generator(np.random.PCG64(random_state))
    candidate_draws: list[float] = []
    baseline_draws: list[float] = []
    delta_draws: list[float] = []
    draws = 0
    cluster_ids = sorted(clusters)
    while len(candidate_draws) < resamples and draws < maximum_draws:
        draws += 1
        indices: list[int] = []
        sampled = random.integers(0, len(cluster_ids), size=len(cluster_ids))
        for sampled_index in sampled:
            indices.extend(clusters[cluster_ids[int(sampled_index)]])
        sample = np.asarray(indices, dtype=np.int64)
        if sample.size == 0 or np.unique(y[sample]).size < 2:
            continue
        candidate_auc = float(roc_auc_score(y[sample], candidate_array[sample]))
        baseline_auc = float(roc_auc_score(y[sample], baseline_array[sample]))
        candidate_draws.append(candidate_auc)
        baseline_draws.append(baseline_auc)
        delta_draws.append(candidate_auc - baseline_auc)
    if len(candidate_draws) < resamples:
        return {
            "status": "inconclusive",
            "valid_resamples": len(candidate_draws),
            "draws": draws,
            "required_resamples": resamples,
            "maximum_draws": maximum_draws,
            "resampling_unit": "global-participant-cluster-across-all-panels-and-blocks",
            "cross_stratum_participants": cross_stratum_participants,
            "participant_cluster_support": {
                "all": support,
                "by_outcome_class": outcome_support,
            },
            "bit_generator": "PCG64",
            "percentile_method": "linear",
        }

    def interval(values: Sequence[float]) -> dict[str, float]:
        lower, upper = np.percentile(
            np.asarray(values), [2.5, 97.5], method="linear"
        )
        return {"lower_95": float(lower), "upper_95": float(upper)}

    return {
        "status": "complete",
        "method": "paired-global-participant-cluster-bootstrap",
        "valid_resamples": len(candidate_draws),
        "draws": draws,
        "random_state": random_state,
        "resampling_unit": "global-participant-cluster-across-all-panels-and-blocks",
        "cross_stratum_participants": cross_stratum_participants,
        "participant_cluster_support": {
            "all": support,
            "by_outcome_class": outcome_support,
        },
        "bit_generator": "PCG64",
        "percentile_method": "linear",
        "candidate_auroc": interval(candidate_draws),
        "baseline_auroc": interval(baseline_draws),
        "paired_delta": interval(delta_draws),
    }


def _count_summary(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {
        "attempts": len(rows),
        "target_encounter_attempts": sum(int(row["target_encountered"]) for row in rows),
        "non_encounter_attempts": sum(1 - int(row["target_encountered"]) for row in rows),
        "angler_hours": float(sum(float(row["angler_hours"]) for row in rows)),
    }


def _support_breakdown(
    rows: Sequence[Mapping[str, Any]], field: str, values: Sequence[str]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for value in values:
        selected = [
            row
            for row in rows
            if str(
                row["evidence"][field]
                if field in row["evidence"]
                else row[field]
            )
            == value
        ]
        result[value] = _count_summary(selected)
    return result


def _descriptive_discrimination_summary(
    rows: Sequence[Mapping[str, Any]],
    baseline_prediction_by_assignment: Mapping[str, float],
) -> dict[str, Any]:
    labels = [int(row["target_encountered"]) for row in rows]
    candidate = [float(row["opportunity_score"]) for row in rows]
    baseline = [
        float(baseline_prediction_by_assignment[str(row["assignment_id"])])
        for row in rows
    ]
    candidate_auc = _binary_metric(labels, candidate, "auroc")
    baseline_auc = _binary_metric(labels, baseline, "auroc")
    return {
        "attempts": len(rows),
        "target_encounter_attempts": sum(labels),
        "non_encounter_attempts": len(rows) - sum(labels),
        "candidate_auroc": candidate_auc,
        "selected_baseline_auroc": baseline_auc,
        "paired_delta": (
            candidate_auc - baseline_auc
            if candidate_auc is not None and baseline_auc is not None
            else None
        ),
        "inferential": False,
    }


def _score_strata(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    bins = [(0, 20), (20, 40), (40, 60), (60, 80), (80, 101)]
    result: list[dict[str, Any]] = []
    for lower, upper in bins:
        selected = [
            row for row in rows if lower <= float(row["opportunity_score"]) < upper
        ]
        summary = _count_summary(selected)
        positives = int(summary["target_encounter_attempts"])
        attempts = int(summary["attempts"])
        hours = float(summary["angler_hours"])
        result.append(
            {
                "score_range": f"{lower}-{100 if upper == 101 else upper - 1}",
                **summary,
                "target_encounter_rate": positives / attempts if attempts else None,
                "target_encounter_attempts_per_100_angler_hours": (
                    100.0 * positives / hours if hours > 0 else None
                ),
                "mean_ordinal_score": (
                    float(np.mean([float(row["opportunity_score"]) for row in selected]))
                    if selected
                    else None
                ),
            }
        )
    return result


def _runtime_identity(
    solver_diagnostics: Sequence[Mapping[str, Any]],
    frozen_identity: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "frozen_evaluator_identity": deepcopy(dict(frozen_identity)),
        "liblinear_identity": f"scikit-learn-bundled-liblinear/{sklearn.__version__}",
        "numeric_standardization_ddof": 0,
        "utc_day_of_year_cycle_denominator_days": 365.2425,
        "bootstrap_bit_generator": "PCG64",
        "percentile_method": "linear",
        "solver_diagnostics": [deepcopy(dict(item)) for item in solver_diagnostics],
    }


def evaluate_site_window(
    *,
    label_free_evidence_path: Path,
    labeled_evidence_path: Path,
    split_manifest_path: Path,
    activation_manifest_path: Path,
    opportunity_ledger_path: Path,
    candidate_predictions_path: Path,
    census_export_path: Path,
    deletion_reconciliation_paths: Sequence[Path],
    output_path: Path,
    protocol_path: Path = DEFAULT_PROTOCOL_PATH,
    label_lock_path: Path | None = None,
    label_access_receipt_path: Path | None = None,
    publication_audit_path: Path | None = None,
    audit_receipt_path: Path | None = None,
    manifest_chain_paths: Sequence[Path] | None = None,
) -> dict[str, Any]:
    """Evaluate the frozen protocol, opening labels only after a durable lock."""

    protocol, protocol_digest = load_validation_protocol(protocol_path)
    activation_manifest = load_split_manifest(
        activation_manifest_path, protocol, protocol_digest
    )
    split = load_split_manifest(split_manifest_path, protocol, protocol_digest)
    if activation_manifest["manifest_role"] != "activation":
        raise ValueError("activation_manifest_path must be the root activation")
    if split["manifest_role"] != "finalization":
        raise ValueError("evaluation requires the unique terminal finalization manifest")
    if split["activated_at"] != activation_manifest["activated_at"]:
        raise ValueError("assignment manifest activation time differs from root activation")
    if manifest_chain_paths is None:
        raise ValueError("evaluation requires the complete activation-to-finalization manifest chain")
    else:
        chain_paths = list(manifest_chain_paths)
    chain = load_manifest_chain(chain_paths, protocol, protocol_digest)
    if canonical_sha256(chain[0]) != canonical_sha256(activation_manifest):
        raise ValueError("manifest chain root differs from activation_manifest_path")
    if canonical_sha256(chain[-1]) != canonical_sha256(split):
        raise ValueError("manifest chain tip differs from split_manifest_path")
    verify_release_commit_contains_protocol(
        str(activation_manifest["activation"]["release_commit"]),
        protocol_path,
        protocol_digest,
    )
    frozen_evaluator_identity = verify_frozen_evaluator_identity(
        split["finalization"]["evaluator_identity"], protocol
    )

    label_free = load_validation_evidence(
        label_free_evidence_path,
        protocol,
        include_outcomes=False,
        activated_at=str(activation_manifest["activated_at"]),
        activation_manifest_sha256=canonical_sha256(activation_manifest),
        activation=activation_manifest["activation"],
    )
    _assert_same_assignment_projection(label_free, split["assignments"], protocol)
    if label_free_snapshot_sha256(label_free) != split["data_snapshot_sha256"]:
        raise ValueError("label-free evidence digest differs from the sealed data snapshot")
    artifact_digests = validate_label_free_prediction_artifacts(
        opportunity_ledger_path=opportunity_ledger_path,
        candidate_predictions_path=candidate_predictions_path,
        evidence=label_free,
        protocol=protocol,
        activation=activation_manifest["activation"],
    )
    if artifact_digests["prediction_snapshot_sha256"] != split["prediction_snapshot_sha256"]:
        raise ValueError("ledger or candidate-prediction digest differs from the sealed snapshot")
    _assert_root_identity(label_free, activation_manifest["activation"])

    census = load_trusted_census_export(
        census_export_path,
        protocol,
        activation_manifest,
        evidence=label_free,
    )
    finalization_identity = split["finalization"]
    if (
        census["canonical_sha256"]
        != finalization_identity["census_export_canonical_sha256"]
        or census["file_sha256"] != finalization_identity["census_export_file_sha256"]
        or census["completion_event_set_sha256"]
        != finalization_identity["completion_event_set_sha256"]
        or census["issuance_reconciliation"]
        != finalization_identity["issuance_reconciliation"]
    ):
        raise ValueError("trusted census export differs from the terminal finalization binding")
    deletion = load_deletion_reconciliation_chain(
        deletion_reconciliation_paths,
        protocol,
        activation_manifest,
        split,
        manifest_chain=chain,
    )

    if label_lock_path is None:
        raise ValueError(
            "evaluation requires a separately sealed label lock before label export"
        )
    lock_path = label_lock_path
    label_lock = _load_or_create_label_lock(
        split=split,
        path=lock_path,
        protocol=protocol,
        protocol_sha256=protocol_digest,
    )

    # The exact signed labeled bytes are opened once after the durable lock and
    # held in memory. Their receipt is written before any JSON or label parse.
    raw_labeled_bytes = read_private_bytes_once(
        labeled_evidence_path, artifact="labeled validation evidence"
    )
    labeled_evidence_file_sha256 = hashlib.sha256(raw_labeled_bytes).hexdigest()

    receipt_path = label_access_receipt_path or output_path.with_name(
        f"{output_path.stem}.label-access-receipt.json"
    )
    label_access_receipt = _load_or_create_label_access_receipt(
        path=receipt_path,
        label_lock=label_lock,
        finalization=split,
        deletion=deletion,
        labeled_evidence_file_sha256=labeled_evidence_file_sha256,
    )

    # This is intentionally the first parse of the signed labeled export.
    labeled, signed_labeled = load_signed_labeled_export(
        labeled_evidence_path,
        protocol,
        activation_manifest,
        split,
        deletion,
        label_lock,
        raw_envelope_bytes=raw_labeled_bytes,
    )
    if signed_labeled["file_sha256"] != labeled_evidence_file_sha256:
        raise ValueError("signed labeled export bytes differ from the pre-parse receipt")
    labeled_without_outcomes = [_without_outcomes(item) for item in labeled]
    active_ids = set(deletion["active_assignment_ids"])
    active_label_free = [item for item in label_free if item["assignment_id"] in active_ids]
    if canonical_sha256(_sorted_rows(labeled_without_outcomes)) != canonical_sha256(
        _sorted_rows(active_label_free)
    ):
        raise ValueError("labeled export must omit exactly reconciled rows and change only outcomes")
    active_assignments = [
        item for item in split["assignments"] if item["assignment_id"] in active_ids
    ]
    _assert_same_assignment_projection(labeled, active_assignments, protocol)
    _assert_root_identity(labeled, activation_manifest["activation"])

    primary = _sorted_rows([item for item in labeled if item["cohort_role"] == "primary"])
    dev_blocks = set(protocol["temporal_design"]["development_blocks"])
    test_blocks = set(protocol["temporal_design"]["locked_test_blocks"])
    dev = [item for item in primary if item["temporal_block"] in dev_blocks]
    test = [item for item in primary if item["temporal_block"] in test_blocks]
    solver_diagnostics: list[dict[str, Any]] = []
    selected_baseline, baseline_selection, baseline_estimable = _select_baseline(
        protocol, dev, solver_diagnostics
    )
    held_rows, held_predictions = _held_geography_predictions(
        protocol, selected_baseline, dev, test, solver_diagnostics
    )
    candidate_scores = [float(item["opportunity_score"]) for item in held_rows]
    labels = [int(item["target_encountered"]) for item in held_rows]
    candidate_auc = _binary_metric(labels, candidate_scores, "auroc")
    baseline_auc = _binary_metric(labels, held_predictions, "auroc")
    candidate_ap = _binary_metric(labels, candidate_scores, "average-precision")
    baseline_ap = _binary_metric(labels, held_predictions, "average-precision")

    panels = [str(item["panel_id"]) for item in protocol["geography"]["panels"]]
    per_panel_auroc: dict[str, float | None] = {}
    for panel in panels:
        indices = [
            index for index, item in enumerate(held_rows) if item["geographic_panel"] == panel
        ]
        per_panel_auroc[panel] = _binary_metric(
            [labels[index] for index in indices],
            [candidate_scores[index] for index in indices],
            "auroc",
        )

    sample = protocol["sample_plan"]
    panel_counts = {
        panel: sum(item["geographic_panel"] == panel for item in test) for panel in panels
    }
    development_by_panel = {
        panel: [item for item in dev if item["geographic_panel"] == panel]
        for panel in panels
    }
    test_by_panel = {
        panel: [item for item in test if item["geographic_panel"] == panel]
        for panel in panels
    }
    development_by_block = {
        block: [item for item in dev if item["temporal_block"] == block]
        for block in protocol["temporal_design"]["development_blocks"]
    }
    test_by_block = {
        block: [item for item in test if item["temporal_block"] == block]
        for block in protocol["temporal_design"]["locked_test_blocks"]
    }
    block_counts = {
        block: sum(item["temporal_block"] == block for item in test)
        for block in protocol["temporal_design"]["locked_test_blocks"]
    }
    participant_cluster_support = {
        "all_primary": _participant_cluster_support(primary),
        "development_primary": _participant_cluster_support(dev),
        "locked_test_primary": _participant_cluster_support(test),
        "development_primary_by_outcome_class": {
            "target_encountered": _participant_cluster_support(
                [item for item in dev if int(item["target_encountered"]) == 1]
            ),
            "non_encounter": _participant_cluster_support(
                [item for item in dev if int(item["target_encountered"]) == 0]
            ),
        },
        "locked_test_primary_by_outcome_class": {
            "target_encountered": _participant_cluster_support(
                [item for item in test if int(item["target_encountered"]) == 1]
            ),
            "non_encounter": _participant_cluster_support(
                [item for item in test if int(item["target_encountered"]) == 0]
            ),
        },
        "development_primary_by_geography": {
            panel: _participant_cluster_support(rows)
            for panel, rows in development_by_panel.items()
        },
        "locked_test_primary_by_geography": {
            panel: _participant_cluster_support(rows)
            for panel, rows in test_by_panel.items()
        },
        "development_primary_by_geography_and_outcome_class": {
            panel: {
                "target_encountered": _participant_cluster_support(
                    [item for item in rows if int(item["target_encountered"]) == 1]
                ),
                "non_encounter": _participant_cluster_support(
                    [item for item in rows if int(item["target_encountered"]) == 0]
                ),
            }
            for panel, rows in development_by_panel.items()
        },
        "locked_test_primary_by_geography_and_outcome_class": {
            panel: {
                "target_encountered": _participant_cluster_support(
                    [item for item in rows if int(item["target_encountered"]) == 1]
                ),
                "non_encounter": _participant_cluster_support(
                    [item for item in rows if int(item["target_encountered"]) == 0]
                ),
            }
            for panel, rows in test_by_panel.items()
        },
        "development_primary_by_temporal_block": {
            block: _participant_cluster_support(rows)
            for block, rows in development_by_block.items()
        },
        "locked_test_primary_by_temporal_block": {
            block: _participant_cluster_support(rows)
            for block, rows in test_by_block.items()
        },
    }
    maximum_share_numerator = int(
        sample["maximum_single_participant_attempt_share_numerator"]
    )
    maximum_share_denominator = int(
        sample["maximum_single_participant_attempt_share_denominator"]
    )

    def cluster_gate(
        support: Mapping[str, Any], minimum_unique: str, minimum_effective: str
    ) -> bool:
        return _participant_cluster_gate(
            support,
            minimum_unique=int(sample[minimum_unique]),
            minimum_effective=int(sample[minimum_effective]),
            maximum_share_numerator=maximum_share_numerator,
            maximum_share_denominator=maximum_share_denominator,
        )

    def outcome_cell_gate(
        support: Mapping[str, Any], minimum_unique: str, minimum_effective: str
    ) -> bool:
        return _participant_cluster_gate(
            support,
            minimum_unique=int(sample[minimum_unique]),
            minimum_effective=int(sample[minimum_effective]),
            maximum_share_numerator=1,
            maximum_share_denominator=1,
        )

    positives = sum(labels)
    adequacy_checks = {
        "minimum_total_accepted_attempts": len(primary)
        >= int(sample["minimum_total_accepted_attempts"]),
        "minimum_development_attempts_per_geography": all(
            len(rows) >= int(sample["minimum_development_attempts_per_geography"])
            for rows in development_by_panel.values()
        ),
        "minimum_development_target_encounters_per_geography": all(
            sum(int(item["target_encountered"]) for item in rows)
            >= int(sample["minimum_development_target_encounters_per_geography"])
            for rows in development_by_panel.values()
        ),
        "minimum_development_non_encounters_per_geography": all(
            sum(1 - int(item["target_encountered"]) for item in rows)
            >= int(sample["minimum_development_non_encounters_per_geography"])
            for rows in development_by_panel.values()
        ),
        "all_development_lopo_aurocs_estimable": baseline_estimable,
        "all_locked_geography_aurocs_estimable": all(
            value is not None for value in per_panel_auroc.values()
        ),
        "all_logistic_fits_converged": all(
            item["converged"] for item in solver_diagnostics
        ),
        "minimum_locked_test_attempts": len(test)
        >= int(sample["minimum_locked_test_attempts"]),
        "minimum_locked_test_target_encounters": positives
        >= int(sample["minimum_locked_test_target_encounters"]),
        "minimum_locked_test_non_encounters": len(test) - positives
        >= int(sample["minimum_locked_test_non_encounters"]),
        "minimum_test_attempts_per_geography": all(
            count >= int(sample["minimum_test_attempts_per_geography"])
            for count in panel_counts.values()
        ),
        "minimum_locked_test_target_encounters_per_geography": all(
            sum(int(item["target_encountered"]) for item in rows)
            >= int(sample["minimum_locked_test_target_encounters_per_geography"])
            for rows in test_by_panel.values()
        ),
        "minimum_locked_test_non_encounters_per_geography": all(
            sum(1 - int(item["target_encountered"]) for item in rows)
            >= int(sample["minimum_locked_test_non_encounters_per_geography"])
            for rows in test_by_panel.values()
        ),
        "minimum_attempts_per_locked_temporal_block": all(
            count >= int(sample["minimum_attempts_per_locked_temporal_block"])
            for count in block_counts.values()
        ),
        "all_primary_participant_cluster_support": cluster_gate(
            participant_cluster_support["all_primary"],
            "minimum_total_unique_participant_groups",
            "minimum_total_effective_participant_groups",
        ),
        "development_participant_cluster_support": cluster_gate(
            participant_cluster_support["development_primary"],
            "minimum_development_unique_participant_groups",
            "minimum_development_effective_participant_groups",
        ),
        "locked_test_participant_cluster_support": cluster_gate(
            participant_cluster_support["locked_test_primary"],
            "minimum_locked_test_unique_participant_groups",
            "minimum_locked_test_effective_participant_groups",
        ),
        "development_target_encounter_participant_cluster_support": cluster_gate(
            participant_cluster_support["development_primary_by_outcome_class"][
                "target_encountered"
            ],
            "minimum_development_target_encounter_participant_groups",
            "minimum_development_target_encounter_effective_participant_groups",
        ),
        "development_non_encounter_participant_cluster_support": cluster_gate(
            participant_cluster_support["development_primary_by_outcome_class"][
                "non_encounter"
            ],
            "minimum_development_non_encounter_participant_groups",
            "minimum_development_non_encounter_effective_participant_groups",
        ),
        "locked_test_target_encounter_participant_cluster_support": cluster_gate(
            participant_cluster_support["locked_test_primary_by_outcome_class"][
                "target_encountered"
            ],
            "minimum_locked_test_target_encounter_participant_groups",
            "minimum_locked_test_target_encounter_effective_participant_groups",
        ),
        "locked_test_non_encounter_participant_cluster_support": cluster_gate(
            participant_cluster_support["locked_test_primary_by_outcome_class"][
                "non_encounter"
            ],
            "minimum_locked_test_non_encounter_participant_groups",
            "minimum_locked_test_non_encounter_effective_participant_groups",
        ),
        "development_geography_participant_cluster_support": all(
            cluster_gate(
                support,
                "minimum_development_unique_participant_groups_per_geography",
                "minimum_development_effective_participant_groups_per_geography",
            )
            for support in participant_cluster_support[
                "development_primary_by_geography"
            ].values()
        ),
        "locked_test_geography_participant_cluster_support": all(
            cluster_gate(
                support,
                "minimum_locked_test_unique_participant_groups_per_geography",
                "minimum_locked_test_effective_participant_groups_per_geography",
            )
            for support in participant_cluster_support[
                "locked_test_primary_by_geography"
            ].values()
        ),
        "development_geography_outcome_participant_cluster_support": all(
            outcome_cell_gate(
                outcome_support["target_encountered"],
                "minimum_development_target_encounter_participant_groups_per_geography",
                "minimum_development_target_encounter_effective_participant_groups_per_geography",
            )
            and outcome_cell_gate(
                outcome_support["non_encounter"],
                "minimum_development_non_encounter_participant_groups_per_geography",
                "minimum_development_non_encounter_effective_participant_groups_per_geography",
            )
            for outcome_support in participant_cluster_support[
                "development_primary_by_geography_and_outcome_class"
            ].values()
        ),
        "locked_test_geography_outcome_participant_cluster_support": all(
            outcome_cell_gate(
                outcome_support["target_encountered"],
                "minimum_locked_test_target_encounter_participant_groups_per_geography",
                "minimum_locked_test_target_encounter_effective_participant_groups_per_geography",
            )
            and outcome_cell_gate(
                outcome_support["non_encounter"],
                "minimum_locked_test_non_encounter_participant_groups_per_geography",
                "minimum_locked_test_non_encounter_effective_participant_groups_per_geography",
            )
            for outcome_support in participant_cluster_support[
                "locked_test_primary_by_geography_and_outcome_class"
            ].values()
        ),
        "development_block_participant_cluster_support": all(
            cluster_gate(
                support,
                "minimum_unique_participant_groups_per_development_temporal_block",
                "minimum_effective_participant_groups_per_development_temporal_block",
            )
            for support in participant_cluster_support[
                "development_primary_by_temporal_block"
            ].values()
        ),
        "locked_test_block_participant_cluster_support": all(
            cluster_gate(
                support,
                "minimum_unique_participant_groups_per_locked_temporal_block",
                "minimum_effective_participant_groups_per_locked_temporal_block",
            )
            for support in participant_cluster_support[
                "locked_test_primary_by_temporal_block"
            ].values()
        ),
    }
    adequate = all(adequacy_checks.values())
    globally_estimable = (
        bool(test)
        and len(set(labels)) == 2
        and candidate_auc is not None
        and baseline_auc is not None
        and baseline_estimable
        and all(value is not None for value in per_panel_auroc.values())
    )
    bootstrap_spec = protocol["analysis"]["bootstrap"]
    if adequate and globally_estimable:
        bootstrap = _bootstrap(
            held_rows,
            candidate_scores,
            held_predictions,
            resamples=int(bootstrap_spec["resamples"]),
            random_state=int(bootstrap_spec["random_state"]),
            maximum_draws=int(bootstrap_spec["maximum_draws"]),
            minimum_participant_groups=int(
                sample["minimum_locked_test_unique_participant_groups"]
            ),
            minimum_effective_participant_groups=int(
                sample["minimum_locked_test_effective_participant_groups"]
            ),
            minimum_target_encounter_participant_groups=int(
                sample["minimum_locked_test_target_encounter_participant_groups"]
            ),
            minimum_target_encounter_effective_participant_groups=int(
                sample[
                    "minimum_locked_test_target_encounter_effective_participant_groups"
                ]
            ),
            minimum_non_encounter_participant_groups=int(
                sample["minimum_locked_test_non_encounter_participant_groups"]
            ),
            minimum_non_encounter_effective_participant_groups=int(
                sample[
                    "minimum_locked_test_non_encounter_effective_participant_groups"
                ]
            ),
            maximum_single_participant_share_numerator=maximum_share_numerator,
            maximum_single_participant_share_denominator=maximum_share_denominator,
        )
    else:
        bootstrap = {
            "status": "not-run",
            "reason": (
                "insufficient-support" if not adequate else "primary-metric-not-estimable"
            ),
        }

    estimable_panel_values = [value for value in per_panel_auroc.values() if value is not None]
    promotion = protocol["analysis"]["promotion_gate"]
    delta = (
        candidate_auc - baseline_auc
        if candidate_auc is not None and baseline_auc is not None
        else None
    )
    gates: dict[str, bool | None] = {
        "candidate_auroc_lower_95_gt": (
            bootstrap["candidate_auroc"]["lower_95"]
            > float(promotion["candidate_auroc_lower_95_gt"])
            if bootstrap["status"] == "complete"
            else None
        ),
        "paired_delta_point_gte": (
            delta >= float(promotion["paired_delta_point_gte"])
            if delta is not None
            else None
        ),
        "paired_delta_lower_95_gt": (
            bootstrap["paired_delta"]["lower_95"]
            > float(promotion["paired_delta_lower_95_gt"])
            if bootstrap["status"] == "complete"
            else None
        ),
        "minimum_estimable_geography_auroc": (
            min(estimable_panel_values)
            >= float(promotion["minimum_estimable_geography_auroc"])
            if estimable_panel_values
            else None
        ),
    }
    reasons: list[str] = []
    if not adequate:
        reasons.append("one or more preregistered sample-adequacy gates were not met")
    if not globally_estimable:
        reasons.append("the primary comparison or development-only baseline selection is not estimable")
    if bootstrap["status"] not in {"complete", "not-run"}:
        reasons.append("the preregistered bootstrap did not produce 2,000 estimable replicates")
    if not adequate or not globally_estimable or bootstrap["status"] != "complete":
        verdict = "inconclusive"
    elif any(value is None for value in gates.values()):
        verdict = "inconclusive"
        reasons.append("one or more preregistered promotion gates were not estimable")
    elif all(value is True for value in gates.values()):
        verdict = "pass"
    else:
        verdict = "fail"
        reasons.extend(
            f"promotion gate failed: {name}"
            for name, value in gates.items()
            if value is False
        )

    modes = list(protocol["eligibility"]["supported_modes"])
    recruitment_sources = list(protocol["recruitment"]["allowed_source_ids"])
    selection_designs = list(protocol["cohorts"]["primary"]["allowed_selection_designs"])
    if len(held_rows) != len(held_predictions):
        raise AssertionError("held rows and baseline predictions are misaligned")
    baseline_prediction_by_assignment = {
        str(row["assignment_id"]): float(prediction)
        for row, prediction in zip(held_rows, held_predictions)
    }
    recruitment_by_design = {
        source: {
            design: _count_summary(
                [
                    row
                    for row in held_rows
                    if row["evidence"]["recruitment_source_id"] == source
                    and row["selection_design"] == design
                ]
            )
            for design in selection_designs
        }
        for source in recruitment_sources
    }
    descriptive_by_recruitment_source = {
        source: _descriptive_discrimination_summary(
            [
                row
                for row in held_rows
                if row["evidence"]["recruitment_source_id"] == source
            ],
            baseline_prediction_by_assignment,
        )
        for source in recruitment_sources
    }
    descriptive_by_selection_design = {
        design: _descriptive_discrimination_summary(
            [row for row in held_rows if row["selection_design"] == design],
            baseline_prediction_by_assignment,
        )
        for design in selection_designs
    }
    descriptive_by_recruitment_and_design = {
        source: {
            design: _descriptive_discrimination_summary(
                [
                    row
                    for row in held_rows
                    if row["evidence"]["recruitment_source_id"] == source
                    and row["selection_design"] == design
                ],
                baseline_prediction_by_assignment,
            )
            for design in selection_designs
        }
        for source in recruitment_sources
    }
    secondary = {
        "average_precision": {
            "candidate": candidate_ap,
            "selected_baseline": baseline_ap,
        },
        "score_stratum_target_encounter_rates_and_effort_normalized_summaries": _score_strata(
            held_rows
        ),
        "support": {
            "by_geography": _support_breakdown(held_rows, "geographic_panel", panels),
            "by_temporal_block": _support_breakdown(
                held_rows,
                "temporal_block",
                list(protocol["temporal_design"]["locked_test_blocks"]),
            ),
            "by_mode": _support_breakdown(held_rows, "mode", modes),
            "by_recruitment_source": _support_breakdown(
                held_rows, "recruitment_source_id", recruitment_sources
            ),
            "by_selection_design": _support_breakdown(
                held_rows, "selection_design", selection_designs
            ),
            "by_recruitment_source_and_selection_design": recruitment_by_design,
        },
        "descriptive_discrimination_results": {
            "by_recruitment_source": descriptive_by_recruitment_source,
            "by_selection_design": descriptive_by_selection_design,
            "by_recruitment_source_and_selection_design": (
                descriptive_by_recruitment_and_design
            ),
            "promotion_bearing": False,
            "uncertainty_intervals": "not-computed-descriptive-only",
        },
        "probability_metrics_reported": False,
        "inferential_secondary_adjustment": "not-applicable-no-secondary-hypothesis-tests",
    }

    report: dict[str, Any] = {
        "schema_version": "castingcompass.site-window-validation-result/1.0.0",
        "verdict": verdict,
        "reasons": reasons,
        "claim_scope": {
            "allowed_claim": protocol["target_and_claim"]["allowed_claim"],
            "score_semantics": protocol["target_and_claim"]["score_semantics"],
            "prohibited_claims": protocol["target_and_claim"]["prohibited_claims"],
            "local_artifact_is_production_evidence": False,
        },
        "bindings": {
            "protocol_id": protocol["protocol_id"],
            "protocol_version": protocol["protocol_version"],
            "protocol_sha256": protocol_digest,
            "site_catalog_sha256": protocol["geography"]["site_catalog_sha256"],
            "activation_manifest_sha256": canonical_sha256(activation_manifest),
            "assignment_manifest_sha256": (
                canonical_sha256(chain[-2])
                if chain[-2]["manifest_role"] == "assignment-batch"
                else None
            ),
            "label_lock_manifest_sha256": canonical_sha256(label_lock),
            "label_access_receipt_sha256": canonical_sha256(label_access_receipt),
            "finalization_manifest_sha256": canonical_sha256(split),
            "evaluator_identity_sha256": canonical_sha256(
                frozen_evaluator_identity
            ),
            "runtime_image_digest": frozen_evaluator_identity[
                "runtime_image_digest"
            ],
            "trusted_census_export_sha256": census["canonical_sha256"],
            "trusted_census_export_file_sha256": census["file_sha256"],
            "completion_event_set_sha256": census["completion_event_set_sha256"],
            "issuance_reconciliation_sha256": canonical_sha256(
                census["issuance_reconciliation"]
            ),
            "issuance_reconciliation_evidence_basis": census[
                "issuance_reconciliation"
            ]["evidence_basis"],
            "append_only_log_proof_included": census[
                "issuance_reconciliation"
            ]["append_only_log_proof_included"],
            "deletion_reconciliation_sha256": deletion["ledger_sha256"],
            "deletion_reconciliation_chain_sha256": deletion["chain_sha256"],
            "data_snapshot_sha256": split["data_snapshot_sha256"],
            "label_free_evidence_file_sha256": sha256_file(label_free_evidence_path),
            "labeled_evidence_file_sha256": signed_labeled["file_sha256"],
            "signed_labeled_export_sha256": signed_labeled["canonical_sha256"],
            "signed_labeled_payload_sha256": signed_labeled["payload_sha256"],
            "opportunity_ledger_sha256": sha256_file(opportunity_ledger_path),
            "candidate_predictions_sha256": sha256_file(candidate_predictions_path),
            "prediction_snapshot_sha256": split["prediction_snapshot_sha256"],
            "activation_scoring_identity": deepcopy(activation_manifest["activation"]),
            "labels_opened_at": label_lock["labels_opened_at"],
        },
        "runtime_identity": _runtime_identity(
            solver_diagnostics, frozen_evaluator_identity
        ),
        "sample_adequacy": {
            "checks": adequacy_checks,
            "participant_cluster_support": participant_cluster_support,
            "counts": {
                "total_primary": len(primary),
                "development": len(dev),
                "locked_test": len(test),
                "locked_test_target_encounters": positives,
                "locked_test_non_encounters": len(test) - positives,
                "development_by_geography": {
                    panel: _count_summary(rows)
                    for panel, rows in development_by_panel.items()
                },
                "locked_test_by_geography": panel_counts,
                "locked_test_by_temporal_block": block_counts,
                "development_by_temporal_block": {
                    block: len(rows) for block, rows in development_by_block.items()
                },
            },
        },
        "cohort_and_reconciliation_accounting": {
            "sealed_cohorts": deepcopy(split["aggregate_counts"]),
            "issuance_reconciliation": deepcopy(census["issuance_reconciliation"]),
            "post_seal_reconciliation": deepcopy(deletion["counts"]),
            "post_seal_count_semantics": "latest-monotone-privacy-state",
            "first_analytical_removal_counts": {
                status: sum(
                    first_status == status
                    for first_status in deletion["first_removal_status"].values()
                )
                for status in ("withdrawn", "deleted", "excluded")
            },
            "ever_excluded_count": len(deletion["ever_excluded_assignment_ids"]),
            "removed_by_status_and_geography": {
                status: {
                    panel: sum(
                        deletion["removed_status"].get(str(item["assignment_id"])) == status
                        and item["geographic_panel"] == panel
                        for item in split["assignments"]
                    )
                    for panel in panels
                }
                for status in ("withdrawn", "deleted", "excluded")
            },
            "removed_by_status_and_temporal_block": {
                status: {
                    block: sum(
                        deletion["removed_status"].get(str(item["assignment_id"])) == status
                        and item["temporal_block"] == block
                        for item in split["assignments"]
                    )
                    for block in [item["block_id"] for item in protocol["temporal_design"]["blocks"]]
                }
                for status in ("withdrawn", "deleted", "excluded")
            },
            "first_removal_by_status_and_geography": {
                status: {
                    panel: sum(
                        deletion["first_removal_status"].get(
                            str(item["assignment_id"])
                        )
                        == status
                        and item["geographic_panel"] == panel
                        for item in split["assignments"]
                    )
                    for panel in panels
                }
                for status in ("withdrawn", "deleted", "excluded")
            },
            "first_removal_by_status_and_temporal_block": {
                status: {
                    block: sum(
                        deletion["first_removal_status"].get(
                            str(item["assignment_id"])
                        )
                        == status
                        and item["temporal_block"] == block
                        for item in split["assignments"]
                    )
                    for block in [
                        item["block_id"] for item in protocol["temporal_design"]["blocks"]
                    ]
                }
                for status in ("withdrawn", "deleted", "excluded")
            },
            "ever_excluded_by_geography": {
                panel: sum(
                    str(item["assignment_id"])
                    in deletion["ever_excluded_assignment_ids"]
                    and item["geographic_panel"] == panel
                    for item in split["assignments"]
                )
                for panel in panels
            },
            "observational_secondary": _count_summary(
                [item for item in labeled if item["cohort_role"] == "secondary"]
            ),
            "exploratory_count": sum(item["cohort_role"] == "exploratory" for item in labeled),
            "quarantined_count": sum(item["cohort_role"] == "quarantined" for item in labeled),
            "promotion_bearing_cohort": "primary-solo-angler-only",
            "observational_secondary_is_descriptive_only": True,
        },
        "baseline_selection": {
            "data": "development-blocks-only",
            "selected_baseline_id": selected_baseline["baseline_id"],
            "definitions": baseline_selection,
        },
        "primary_analysis": {
            "metric": protocol["analysis"]["primary_metric"],
            "candidate_auroc": candidate_auc,
            "selected_baseline_auroc": baseline_auc,
            "paired_delta": delta,
            "candidate_auroc_by_geography": per_panel_auroc,
            "bootstrap": bootstrap,
            "promotion_gates": gates,
        },
        "secondary_analysis": secondary,
    }
    analysis_result_sha = canonical_sha256(report)
    minimum_checked_at = max(
        (
            label_lock["labels_opened_at"],
            deletion["payload"]["reconciled_through_at"],
        ),
        key=lambda value: _parse_datetime(
            value, location="publication minimum check timestamp"
        ),
    )
    if census["issuance_reconciliation"]["append_only_log_proof_included"] is not True:
        draft_path = output_path.with_name(f"{output_path.stem}.unpublished-draft.json")
        _write_or_verify_json(
            draft_path,
            {
                "schema_version": "castingcompass.validation-unpublished-draft/1.0.0",
                "publishable": False,
                "withheld_reason": (
                    "independently-verified-append-only-log-proof-not-implemented"
                ),
                "analysis_result_sha256": analysis_result_sha,
                "analysis_result": report,
            },
            artifact="unpublished validation draft",
        )
        return {
            "verdict": "withheld-pending-independent-append-only-log-proof",
            "analysis_verdict": verdict,
            "analysis_result_sha256": analysis_result_sha,
            "draft_path": str(draft_path),
            "label_lock_path": str(lock_path),
            "label_access_receipt_path": str(receipt_path),
        }
    publication_request_bindings = {
        "protocol_id": protocol["protocol_id"],
        "protocol_version": protocol["protocol_version"],
        "activation_manifest_sha256": canonical_sha256(activation_manifest),
        "finalization_manifest_sha256": canonical_sha256(split),
        "deletion_reconciliation_sha256": deletion["ledger_sha256"],
        "deletion_reconciliation_chain_sha256": deletion["chain_sha256"],
        "label_lock_manifest_sha256": canonical_sha256(label_lock),
        "label_access_receipt_sha256": canonical_sha256(label_access_receipt),
        "analysis_result_sha256": analysis_result_sha,
        "evaluator_identity_sha256": canonical_sha256(
            frozen_evaluator_identity
        ),
        "runtime_image_digest": frozen_evaluator_identity["runtime_image_digest"],
        "required_execution_mode": (
            "independent-pinned-runtime-and-atomic-publication-service"
        ),
        "active_assignment_ids_sha256": canonical_sha256(
            deletion["active_assignment_ids"]
        ),
        "reconciliation_counts": deepcopy(deletion["counts"]),
        "issuance_reconciliation_sha256": canonical_sha256(
            census["issuance_reconciliation"]
        ),
        "append_only_log_proof_included": census[
            "issuance_reconciliation"
        ]["append_only_log_proof_included"],
        "minimum_checked_at": minimum_checked_at,
        "required_signature": "activation-pinned-ed25519",
    }
    request_path = output_path.with_name(
        f"{output_path.stem}.publication-audit-request.json"
    )
    publication_request = _load_or_create_publication_request(
        path=request_path,
        expected_bindings=publication_request_bindings,
    )
    if publication_audit_path is None:
        draft_path = output_path.with_name(f"{output_path.stem}.unpublished-draft.json")
        _write_or_verify_json(
            draft_path,
            {
                "schema_version": "castingcompass.validation-unpublished-draft/1.0.0",
                "publishable": False,
                "analysis_result_sha256": analysis_result_sha,
                "analysis_result": report,
            },
            artifact="unpublished validation draft",
        )
        return {
            "verdict": "withheld-pending-publication-reconciliation",
            "analysis_verdict": verdict,
            "analysis_result_sha256": analysis_result_sha,
            "draft_path": str(draft_path),
            "publication_audit_request_path": str(request_path),
            "label_lock_path": str(lock_path),
            "label_access_receipt_path": str(receipt_path),
        }

    publication_audit = load_publication_reconciliation_audit(
        publication_audit_path,
        protocol,
        activation_manifest,
        split,
        deletion,
        label_lock,
        label_access_receipt,
        analysis_result_sha,
        publication_request,
    )
    receipt_bindings = {
        "publication_reconciliation_audit_sha256": publication_audit[
            "canonical_sha256"
        ],
        "publication_reconciliation_audit_file_sha256": publication_audit[
            "file_sha256"
        ],
        "trusted_execution_attestation_sha256": publication_audit["payload"][
            "trusted_execution_attestation_sha256"
        ],
        "publication_request_sha256": canonical_sha256(publication_request),
        "publication_request_nonce": publication_request[
            "publication_request_nonce"
        ],
        "trusted_publication_service_attestation_sha256": publication_audit[
            "payload"
        ]["trusted_publication_service_attestation_sha256"],
        "production_artifact_sha256": publication_audit["payload"][
            "production_artifact_sha256"
        ],
    }
    local_archive = {
        "schema_version": (
            "castingcompass.validation-local-publication-receipt-archive/1.0.0"
        ),
        "publishable": False,
        "local_artifact_is_production_evidence": False,
        "publication_status": "trusted-service-receipt-archived",
        "analysis_result_sha256": analysis_result_sha,
        "analysis_result": report,
        "trusted_receipt_bindings": receipt_bindings,
        "signed_publication_receipt_sha256": publication_audit[
            "canonical_sha256"
        ],
        "production_artifact_sha256": publication_audit["payload"][
            "production_artifact_sha256"
        ],
    }
    _write_new_json(output_path, local_archive)
    local_audit_path = audit_receipt_path or output_path.with_name(
        f"{output_path.stem}.audit-receipt.json"
    )
    local_audit_receipt = {
        "schema_version": "castingcompass.validation-local-audit-receipt/1.0.0",
        "result_file_sha256": sha256_file(output_path),
        "result_sha256": canonical_sha256(local_archive),
        "analysis_result_sha256": analysis_result_sha,
        "evaluator_identity_sha256": canonical_sha256(
            frozen_evaluator_identity
        ),
        "runtime_image_digest": frozen_evaluator_identity["runtime_image_digest"],
        "trusted_execution_attestation_sha256": publication_audit["payload"][
            "trusted_execution_attestation_sha256"
        ],
        "trusted_publication_service_attestation_sha256": publication_audit[
            "payload"
        ]["trusted_publication_service_attestation_sha256"],
        "production_artifact_sha256": publication_audit["payload"][
            "production_artifact_sha256"
        ],
        "publication_reconciliation_audit_sha256": publication_audit[
            "canonical_sha256"
        ],
        "publication_request_sha256": canonical_sha256(publication_request),
        "publication_request_nonce": publication_request[
            "publication_request_nonce"
        ],
        "deletion_reconciliation_sha256": deletion["ledger_sha256"],
        "label_access_receipt_sha256": canonical_sha256(label_access_receipt),
        "completed_at": publication_audit["payload"]["checked_at"],
    }
    _write_new_json(local_audit_path, local_audit_receipt)
    return {
        "result_path": str(output_path),
        "result_sha256": canonical_sha256(local_archive),
        "label_lock_path": str(lock_path),
        "label_lock_sha256": canonical_sha256(label_lock),
        "label_access_receipt_path": str(receipt_path),
        "audit_receipt_path": str(local_audit_path),
        "verdict": verdict,
        "publishable": False,
        "publication_status": "trusted-service-receipt-archived",
    }
