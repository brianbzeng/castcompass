import copy
import hashlib
import json
import unittest
from pathlib import Path

from pipeline.contourcast.sources import load_source_manifests
from scripts import acquire_cdfw_crfs


ROOT = Path(__file__).resolve().parents[2]


def manifest_for(dataset_id: str):
    _, manifest = acquire_cdfw_crfs.load_manifest(dataset_id)
    return manifest


def valid_metadata(manifest):
    access = manifest["access"]
    return {
        "name": access["expected_layer_name"],
        "geometryType": "esriGeometryPolygon",
        "objectIdField": "OBJECTID",
        "copyrightText": access["expected_copyright"],
        "maxRecordCount": access["expected_max_record_count"],
        "extent": {"spatialReference": {"wkid": 102100, "latestWkid": 3857}},
        "fields": copy.deepcopy(access["expected_fields"]),
        "editingInfo": copy.deepcopy(manifest["source_version"]["service_revision"]),
    }


def valid_feature(manifest, object_id=1):
    properties = {}
    for field in manifest["access"]["expected_fields"]:
        name = field["name"]
        if name == "OBJECTID":
            properties[name] = object_id
        elif name == "BlockBox":
            properties[name] = "501-30"
        elif name == "Catch":
            properties[name] = manifest["sampling_design"]["catch_label"]
        elif name == "Trip":
            properties[name] = manifest["sampling_design"]["trip_label"]
        elif name == "Samples":
            properties[name] = 3
        elif name in acquire_cdfw_crfs.BINNED_CPUA_FIELDS:
            properties[name] = -9999
        else:
            properties[name] = 1.0
    return {
        "type": "Feature",
        "id": object_id,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-122.0, 37.0], [-122.0, 37.1], [-121.9, 37.1], [-122.0, 37.0]]],
        },
        "properties": properties,
    }


class CdfwOfficialSourceTests(unittest.TestCase):
    def test_machine_source_register_keeps_aggregate_layers_context_only(self):
        manifests = load_source_manifests()
        for dataset_id in ("ds3185", "ds3186"):
            manifest = manifests[f"cdfw_crfs_{dataset_id}"]
            self.assertEqual(manifest["dataset_id"], dataset_id)
            self.assertEqual(manifest["access"]["mode"], "official_arcgis_snapshot")
            self.assertTrue(manifest["permitted_uses"]["descriptive_context"])
            for forbidden in ("model_training", "model_validation", "production_scoring", "point_labels"):
                self.assertFalse(manifest["permitted_uses"][forbidden])
            self.assertIn("never an exact fishing point", manifest["spatial_support"])
            self.assertEqual(manifest["field_semantics"]["missing_binned_cpua_sentinel"], -9999)

    def test_layer_contract_binds_identity_revision_and_exact_dictionary(self):
        manifest = manifest_for("ds3186")
        metadata = valid_metadata(manifest)
        acquire_cdfw_crfs.validate_layer_metadata(metadata, manifest)

        for mutation in (
            lambda value: value.update(name="unexpected layer"),
            lambda value: value["editingInfo"].update(dataLastEditDate=1),
            lambda value: value["fields"][0].update(type="esriFieldTypeString"),
            lambda value: value["extent"]["spatialReference"].update(latestWkid=4326),
        ):
            candidate = copy.deepcopy(metadata)
            mutation(candidate)
            with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
                acquire_cdfw_crfs.validate_layer_metadata(candidate, manifest)

    def test_feature_contract_preserves_only_the_exact_missing_sentinel(self):
        manifest = manifest_for("ds3185")
        feature = valid_feature(manifest)
        self.assertEqual(acquire_cdfw_crfs.validate_feature(feature, manifest), 1)

        negative = copy.deepcopy(feature)
        negative["properties"]["All_21_24"] = -1
        with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
            acquire_cdfw_crfs.validate_feature(negative, manifest)

        too_few = copy.deepcopy(feature)
        too_few["properties"]["Samples"] = 2
        with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
            acquire_cdfw_crfs.validate_feature(too_few, manifest)

        relabeled = copy.deepcopy(feature)
        relabeled["properties"]["Catch"] = "California halibut"
        with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
            acquire_cdfw_crfs.validate_feature(relabeled, manifest)

        boolean_id = copy.deepcopy(feature)
        boolean_id["id"] = True
        boolean_id["properties"]["OBJECTID"] = True
        with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
            acquire_cdfw_crfs.validate_feature(boolean_id, manifest)

        invalid_coordinate = copy.deepcopy(feature)
        invalid_coordinate["geometry"]["coordinates"][0][0] = [-222.0, 37.0]
        with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
            acquire_cdfw_crfs.validate_feature(invalid_coordinate, manifest)

        open_ring = copy.deepcopy(feature)
        open_ring["geometry"]["coordinates"][0][-1] = [-121.8, 37.0]
        with self.assertRaises(acquire_cdfw_crfs.AcquisitionError):
            acquire_cdfw_crfs.validate_feature(open_ring, manifest)

    def test_snapshot_canonicalization_is_object_id_ordered(self):
        manifest = manifest_for("ds3186")
        first = valid_feature(manifest, object_id=1)
        second = valid_feature(manifest, object_id=2)
        forward = acquire_cdfw_crfs._canonical_bytes(
            acquire_cdfw_crfs.build_snapshot([first, second], manifest["source_id"])
        )
        reverse = acquire_cdfw_crfs._canonical_bytes(
            acquire_cdfw_crfs.build_snapshot([second, first], manifest["source_id"])
        )
        self.assertEqual(forward, reverse)

    def test_committed_receipts_bind_manifests_and_keep_raw_snapshots_external(self):
        receipt_dir = ROOT / "pipeline" / "sources" / "receipts"
        for dataset_id, revision, expected_count, expected_digest in (
            ("ds3185", 1753737060466, 4471, "51b1c5f64c6917791438883fc3ad31cd195b8dfb354780306a4c237bc4fb7e93"),
            ("ds3186", 1753738461560, 6936, "872cdef85230f9fa60ef34bfbf7475c8eaab39913761e18e4f233ce3a205eaec"),
        ):
            receipt = json.loads((receipt_dir / f"{dataset_id}-{revision}.receipt.json").read_text(encoding="utf-8"))
            manifest_path = ROOT / receipt["source_manifest"]["path"]
            self.assertEqual(hashlib.sha256(manifest_path.read_bytes()).hexdigest(), receipt["source_manifest"]["sha256"])
            self.assertEqual(receipt["snapshot"]["feature_count"], expected_count)
            self.assertEqual(receipt["snapshot"]["sha256"], expected_digest)
            self.assertFalse((ROOT / receipt["snapshot"]["file"]).exists())
            self.assertTrue(all(receipt["verification"].values()))

    def test_roadmap_keeps_complete_effort_and_cohort_gates_open(self):
        register = (ROOT / "docs" / "OFFICIAL-FISHERIES-DATA.md").read_text(encoding="utf-8")
        roadmap = (ROOT / "docs" / "PRODUCT_ROADMAP.md").read_text(encoding="utf-8")
        dashboard = (ROOT / "docs" / "GOAL_STATUS.md").read_text(encoding="utf-8")
        normalized_register = " ".join(register.split())
        self.assertIn("The stale export was rejected", normalized_register)
        self.assertIn(
            "disabled for model training, validation, production scoring, and point labels",
            normalized_register,
        )
        self.assertIn("- [x] Acquire and twice reproduce exact current ds3186 and ds3185", roadmap)
        self.assertIn("- [ ] Obtain a permitted, reproducible complete-effort CRFS/RecFIN", roadmap)
        self.assertIn("a complete-effort RecFIN export and the prospective cohort remain open", dashboard)


if __name__ == "__main__":
    unittest.main()
