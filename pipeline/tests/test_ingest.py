import copy
import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from pipeline.contourcast.geo import GridValidationError
from pipeline.contourcast.ingest import ingest_observations, load_model_observations
from shared.species_contract import (
    OBSERVATION_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    SYNTHETIC_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
)


def taxon_row(
    taxon_id: str,
    count: int,
    *,
    confidence: str | None = None,
    basis: str | None = None,
) -> dict:
    if confidence is None:
        confidence = "self_reported" if count else "not_observed"
    if basis is None:
        basis = "angler-report" if count else "not-observed"
    return {
        "taxon_id": taxon_id,
        "encounter_count": count,
        "retained_count": 0,
        "released_count": count,
        "disposition_unknown_count": 0,
        "identification_confidence": confidence,
        "identification_basis": basis,
    }


def observation(
    observation_id: str,
    taxa: list[dict],
    outcome: str,
    *,
    kind: str = "point",
    precision: str = "exact",
    target: str = PRODUCTION_TARGET_TAXON_ID,
    data_kind: str = "complete-effort-segment",
) -> dict:
    spatial = {"kind": kind, "support_id": f"support-{observation_id}"}
    if kind == "point":
        spatial.update({"crs": "EPSG:32610", "x": 500_000.0, "y": 4_200_000.0})
    return {
        "contract_version": OBSERVATION_CONTRACT_VERSION,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "contract_status": "valid",
        "observation_id": observation_id,
        "effort_segment_id": f"effort-{observation_id}",
        "primary_target_taxon_id": target,
        "source": {
            "source_id": "cdfw_crfs" if data_kind == "complete-effort-segment" else "synthetic_fixture",
            "data_kind": data_kind,
            "complete_attempt": True,
            "expanded_estimate": False,
        },
        "target_effort": {"value": 2.0, "unit": "angler-hours", "mode": "shore"},
        "temporal_support": {
            "start_at": "2026-06-01T12:00:00Z",
            "end_at": "2026-06-01T14:00:00Z",
            "precision": precision,
        },
        "spatial_support": spatial,
        "taxon_observations": taxa,
        "outcome_class": outcome,
    }


class ObservationIngestTests(unittest.TestCase):
    def write_and_ingest(self, root: Path, records: list[dict], *, target: str = PRODUCTION_TARGET_TAXON_ID) -> Path:
        source = root / "observations.jsonl"
        output = root / "normalized.csv"
        source.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        ingest_observations(
            source,
            output,
            source_id="synthetic_fixture" if target == SYNTHETIC_TARGET_TAXON_ID else "cdfw_crfs",
            primary_target_taxon_id=target,
        )
        return output

    def test_distinguishes_all_outcomes_and_preserves_identity(self):
        records = [
            observation("target", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 2)], "target_encountered"),
            observation(
                "other",
                [
                    taxon_row(PRODUCTION_TARGET_TAXON_ID, 0),
                    taxon_row("unresolved-fish", 1, confidence="unresolved", basis="unresolved"),
                ],
                "non_target_only",
            ),
            observation("none", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)], "no_fish"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            output = self.write_and_ingest(Path(temporary), records)
            normalized = pd.read_csv(output)
            loaded = load_model_observations(
                output,
                "EPSG:32610",
                expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
            )
        self.assertEqual(normalized["outcome_class"].tolist(), ["target_encountered", "non_target_only", "no_fish"])
        self.assertEqual(normalized["target_encounter_count"].tolist(), [2, 0, 0])
        self.assertEqual(normalized["any_fish_encounter_count"].tolist(), [2, 1, 0])
        self.assertTrue((normalized["sample_weight"] == 1.0).all())
        self.assertTrue((normalized["spatial_support_id"].str.startswith("support-")).all())
        self.assertEqual(len(loaded), 3)

    def test_area_and_bounded_rows_are_descriptive_not_model_points(self):
        records = [
            observation("area", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)], "no_fish", kind="area"),
            observation(
                "bounded",
                [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)],
                "no_fish",
                precision="bounded",
            ),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            output = self.write_and_ingest(Path(temporary), records)
            normalized = pd.read_csv(output)
            self.assertFalse(normalized["terrain_model_eligible"].any())
            self.assertEqual(normalized.loc[0, "area_id"], "support-area")
            self.assertTrue(pd.isna(normalized.loc[1, "area_id"]))
            with self.assertRaisesRegex(ValueError, "no point-resolution observations"):
                load_model_observations(
                    output,
                    "EPSG:32610",
                    expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                )

    def test_explicit_timezone_offsets_normalize_to_utc(self):
        record = observation("offset", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)], "no_fish")
        record["temporal_support"].update(
            start_at="2026-06-01T08:00:00-07:00",
            end_at="2026-06-01T10:00:00-07:00",
        )
        with tempfile.TemporaryDirectory() as temporary:
            output = self.write_and_ingest(Path(temporary), [record])
            normalized = pd.read_csv(output)
        self.assertEqual(normalized.loc[0, "observed_at"], "2026-06-01T15:00:00Z")
        self.assertEqual(normalized.loc[0, "observed_end_at"], "2026-06-01T17:00:00Z")

    def test_rejects_unsafe_source_and_contract_mutations(self):
        base = observation("safe", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)], "no_fish")
        mutations = {
            "expanded estimate": lambda row: row["source"].update(expanded_estimate=True),
            "catch-only": lambda row: row["source"].update(complete_attempt=False),
            "wrong version": lambda row: row.update(contract_version="castingcompass.observation/1.0.0"),
            "implicit mixed target": lambda row: row.update(primary_target_taxon_id="rockfish"),
            "naive time": lambda row: row["temporal_support"].update(start_at="2026-06-01T12:00:00"),
            "invalid effort": lambda row: row["target_effort"].update(value=0),
            "invalid disposition": lambda row: row["taxon_observations"][0].update(retained_count=1),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                record = copy.deepcopy(base)
                mutate(record)
                with self.assertRaises(ValueError):
                    self.write_and_ingest(Path(temporary), [record])

    def test_rejects_production_synthetic_taxa_and_identity_basis(self):
        records = [
            observation(
                "synthetic-row",
                [
                    taxon_row(PRODUCTION_TARGET_TAXON_ID, 0),
                    taxon_row(SYNTHETIC_TARGET_TAXON_ID, 1, confidence="verified", basis="synthetic-fixture"),
                ],
                "non_target_only",
            ),
            observation(
                "false-synthetic-basis",
                [taxon_row(PRODUCTION_TARGET_TAXON_ID, 1, confidence="verified", basis="synthetic-fixture")],
                "target_encountered",
            ),
        ]
        for record in records:
            with self.subTest(record=record["observation_id"]), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(ValueError):
                    self.write_and_ingest(Path(temporary), [record])

    def test_model_boundary_rejects_tampering_and_excludes_legacy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = self.write_and_ingest(
                root,
                [observation("valid", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 1)], "target_encountered")],
            )
            original = pd.read_csv(output)
            legacy = original.copy()
            legacy.loc[0, "observation_id"] = "legacy"
            legacy.loc[0, "effort_segment_id"] = "effort-legacy"
            legacy.loc[0, "contract_status"] = "legacy_unverified"
            pd.concat([original, legacy], ignore_index=True).to_csv(output, index=False)
            loaded = load_model_observations(
                output,
                "EPSG:32610",
                expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
            )
            self.assertEqual(loaded["observation_id"].tolist(), ["valid"])

            tampered = original.copy()
            tampered.loc[0, "sample_weight"] = 4.0
            tampered.to_csv(output, index=False)
            with self.assertRaisesRegex(ValueError, "sample_weight"):
                load_model_observations(output, "EPSG:32610", expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID)

            tampered = original.copy()
            tampered.loc[0, "target_encounter_count"] = 0
            tampered.to_csv(output, index=False)
            with self.assertRaisesRegex(ValueError, "taxon_observations_json"):
                load_model_observations(output, "EPSG:32610", expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID)

            tampered = original.copy()
            tampered["source_expanded_estimate"] = tampered["source_expanded_estimate"].astype(object)
            tampered.loc[0, "source_expanded_estimate"] = "garbage"
            tampered.to_csv(output, index=False)
            with self.assertRaisesRegex(ValueError, "serialized boolean"):
                load_model_observations(output, "EPSG:32610", expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID)

    def test_model_boundary_rejects_null_blank_nonstring_ids_and_inexact_crs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = self.write_and_ingest(
                root,
                [observation("strict", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)], "no_fish")],
            )
            original = pd.read_csv(output)
            for field in (
                "observation_id",
                "effort_segment_id",
                "source_id",
                "spatial_support_id",
            ):
                for value in (None, "", 123):
                    with self.subTest(field=field, value=value):
                        tampered = original.copy()
                        tampered[field] = tampered[field].astype(object)
                        tampered.loc[0, field] = value
                        tampered.to_csv(output, index=False)
                        with self.assertRaisesRegex(ValueError, "normalized identifier"):
                            load_model_observations(
                                output,
                                "EPSG:32610",
                                expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                            )

            for value in (None, "", "epsg:32610", " EPSG:32610 ", "EPSG:26910"):
                with self.subTest(crs=value):
                    tampered = original.copy()
                    tampered["crs"] = tampered["crs"].astype(object)
                    tampered.loc[0, "crs"] = value
                    tampered.to_csv(output, index=False)
                    with self.assertRaisesRegex(GridValidationError, "exactly match"):
                        load_model_observations(
                            output,
                            "EPSG:32610",
                            expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                        )
            with self.assertRaisesRegex(GridValidationError, "approved model CRS"):
                load_model_observations(
                    output,
                    "EPSG:4326",
                    expected_target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                )

    def test_extreme_json_numbers_fail_closed_with_value_errors(self):
        base = observation("huge", [taxon_row(PRODUCTION_TARGET_TAXON_ID, 0)], "no_fish")
        mutations = {
            "effort": lambda row: row["target_effort"].update(value=10**400),
            "coordinate": lambda row: row["spatial_support"].update(x=10**400),
            "count": lambda row: row["taxon_observations"][0].update(
                encounter_count=10**400,
                released_count=10**400,
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                record = copy.deepcopy(base)
                mutate(record)
                with self.assertRaises(ValueError):
                    self.write_and_ingest(Path(temporary), [record])


if __name__ == "__main__":
    unittest.main()
