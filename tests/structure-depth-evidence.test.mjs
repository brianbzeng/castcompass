import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../", import.meta.url);
const snapshotPath = "structure-depth/noaa-enc-approach-snapshot.json";
const artifactPath = "public/data/structure-depth.json";
const fixedAsOf = "2026-07-21T09:15:58Z";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function containsObjectKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => containsObjectKey(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.prototype.hasOwnProperty.call(value, key)
    || Object.values(value).some((item) => containsObjectKey(item, key));
}

function runCollector(output, sourceSnapshot = snapshotPath) {
  return spawnSync(
    "python3",
    [
      "scripts/refresh_structure_depth.py",
      "--as-of", fixedAsOf,
      "--source-snapshot-file", sourceSnapshot,
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
}

test("published 24-site chart context is contract-bound, display-only, and non-navigational", async () => {
  const [schema, policy, sites, artifact, policyBytes, collectorBytes, siteBytes, snapshotBytes, interfaceSource, disclosure] = await Promise.all([
    readJson("contracts/structure-depth-evidence.schema.json"),
    readJson("structure-depth/policy.json"),
    readJson("data/sites.json"),
    readJson(artifactPath),
    readFile(new URL("structure-depth/policy.json", root)),
    readFile(new URL("scripts/refresh_structure_depth.py", root)),
    readFile(new URL("data/sites.json", root)),
    readFile(new URL(snapshotPath, root)),
    readFile(new URL("app/components/OpportunityApp.tsx", root), "utf8"),
    readFile(new URL("docs/STRUCTURE-DEPTH-EVIDENCE.md", root), "utf8"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  assert.equal(ajv.validate(schema, artifact), true, JSON.stringify(ajv.errors));
  assert.equal(artifact.status, "partial");
  assert.equal(artifact.policyVersion, policy.policy_version);
  assert.equal(artifact.policySha256, sha256(policyBytes));
  assert.equal(artifact.collectorSha256, sha256(collectorBytes));
  assert.equal(artifact.siteCatalogSha256, sha256(siteBytes));
  assert.equal(artifact.sourceSnapshotSha256, sha256(snapshotBytes));
  assert.deepEqual(Object.keys(artifact.sites).sort(), policy.covered_site_ids.toSorted());
  assert.equal(artifact.scoreContribution.numericContributionAllowed, false);
  assert.equal(artifact.scoreContribution.catalogMutationAllowed, false);
  assert.equal(artifact.source.notForNavigation, true);
  assert.equal(artifact.source.resolutionStatus, "vector-chart-features-no-fixed-grid-resolution");
  assert.equal(artifact.source.positionalAccuracyStatus, "not-exposed-by-selected-service-layers");
  assert.equal(artifact.source.uncertaintyStatus, "not-exposed-by-selected-service-layers");

  const sitesById = new Map(sites.map((site) => [site.id, site]));
  for (const siteId of policy.covered_site_ids) {
    const evidence = artifact.sites[siteId];
    const site = sitesById.get(siteId);
    assert.notEqual(evidence.status, "source-unavailable");
    if (siteId === "crane-cove-park") {
      assert.equal(evidence.status, "partial");
      assert.equal(evidence.depth.status, "no-charted-sector-band");
      assert.deepEqual(evidence.depth.chartedBandsMeters, []);
      assert.ok(evidence.depth.contextSoundingCount > 0);
    } else {
      assert.equal(evidence.status, "charted-context");
      assert.equal(evidence.depth.status, "charted-sector-bands");
      assert.ok(evidence.depth.chartedBandsMeters.length > 0);
    }
    assert.equal(evidence.depth.uncertaintyMeters, null);
    assert.ok(evidence.depth.sourceDates.length + evidence.depth.partialSourceDates.length > 0);
    assert.equal(evidence.scoreDelta, null);
    assert.equal(evidence.navigationUseAllowed, false);
    assert.deepEqual(
      evidence.structure.catalogClues,
      site.structureTags.map((tag) => ({
        tag,
        reviewStatus: "catalog-only-not-validated-by-this-source",
      })),
    );
  }
  assert.equal(containsObjectKey(artifact, "geometrySha256"), false);
  assert.equal(containsObjectKey(artifact, "point"), false);
  assert.match(interfaceSource, /not an exact depth at the marker or a shore-reachable casting-depth promise/);
  assert.match(interfaceSource, /does not change the fishing score and is not for navigation/);
  assert.match(disclosure, /not a measured cast envelope/i);
  assert.match(disclosure, /scoreDelta: null/);
});

test("checked-in normalized NOAA snapshot regenerates the public artifact byte for byte", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-structure-depth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "structure-depth.json");
  const result = runCollector(output);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(await readFile(output), await readFile(new URL(artifactPath, root)));
});

test("overlapping ENC cells are deduplicated and partial source dates remain explicit", async () => {
  const [snapshot, artifact] = await Promise.all([readJson(snapshotPath), readJson(artifactPath)]);
  assert.equal(snapshot.sites["goleta-beach"].queries["soundings:context"].features.length, 6);
  assert.equal(artifact.sites["goleta-beach"].depth.contextSoundingCount, 3);

  const wreck = artifact.sites["stearns-wharf"].structure.chartedFeatures
    .find((feature) => feature.category === "charted-wreck");
  assert.ok(wreck);
  assert.equal(wreck.recordCount, 1);
  assert.equal(wreck.hasUndatedRecords, false);
  assert.deepEqual(wreck.sourceDates, []);
  assert.deepEqual(wreck.partialSourceDates, ["2005"]);
});

test("one required site query fails only that evidence slice closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-structure-depth-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await readJson(snapshotPath);
  snapshot.sites["goleta-beach"].queries["depthAreas:sector"] = {
    ...snapshot.sites["goleta-beach"].queries["depthAreas:sector"],
    errorCategory: "source-request-failed",
    features: [],
  };
  const source = join(directory, "source.json");
  const output = join(directory, "artifact.json");
  await writeFile(source, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = runCollector(output, source);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(await readFile(output, "utf8"));
  assert.equal(artifact.status, "partial");
  assert.equal(artifact.sites["goleta-beach"].status, "partial");
  assert.equal(artifact.sites["goleta-beach"].depth.status, "source-unavailable");
  assert.equal(artifact.sites["goleta-beach"].structure.status, "charted-features-present");
  assert.equal(artifact.sites["gaviota-state-park-beach"].status, "charted-context");
  assert.equal(JSON.stringify(artifact).includes(directory), false);
});

test("service metadata drift makes every site unavailable without retaining stale claims", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-structure-depth-drift-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await readJson(snapshotPath);
  snapshot.serviceErrorCategory = "source-layer-drift";
  snapshot.serviceMetadata = {};
  for (const site of Object.values(snapshot.sites)) site.queries = {};
  const source = join(directory, "source.json");
  const output = join(directory, "artifact.json");
  await writeFile(source, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = runCollector(output, source);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(await readFile(output, "utf8"));
  assert.equal(artifact.status, "unavailable");
  assert.equal(artifact.source.errorCategory, "source-layer-drift");
  assert.ok(Object.values(artifact.sites).every((site) => site.status === "source-unavailable"));
  assert.ok(Object.values(artifact.sites).every((site) => site.depth.chartedBandsMeters.length === 0));
  assert.ok(Object.values(artifact.sites).every((site) => site.structure.chartedFeatures.length === 0));
});

test("an unexpected normalized source field is rejected before publication", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-structure-depth-field-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await readJson(snapshotPath);
  snapshot.sites["goleta-beach"].queries["soundings:context"].features[0].attributes.UNEXPECTED = "value";
  const source = join(directory, "source.json");
  const output = join(directory, "artifact.json");
  await writeFile(source, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = runCollector(output, source);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "error",
    errorCategory: "invalid-source-feature",
  });
});

test("source-selection receipt preserves incomplete alternatives instead of overstating coverage", async () => {
  const policy = await readJson("structure-depth/policy.json");
  const receipt = policy.source_selection_receipt;
  assert.deepEqual(receipt.blue_topo.published_site_ids, [
    "gaviota-state-park-beach",
    "refugio-state-beach",
    "el-capitan-state-beach",
  ]);
  assert.equal(receipt.blue_topo.unpublished_site_count, 11);
  assert.equal(receipt.usgs_santa_barbara_channel_10m.configured_sector_coverage_site_count, 6);
  assert.equal(receipt.noaa_enc_direct.configured_sector_depth_area_site_count, 23);
  assert.equal(receipt.san_francisco_extension.site_ids.length, 10);
  assert.equal(receipt.san_francisco_extension.selection_result, "accepted-with-one-explicit-partial-depth-sector");
  assert.match(receipt.blue_topo.tile_scheme_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.usgs_santa_barbara_channel_10m.archive_sha256, /^[a-f0-9]{64}$/);
});

test("partial ENC source dates retain their published precision and invalid months fail closed", async (t) => {
  const artifact = await readJson(artifactPath);
  assert.ok(artifact.sites["torpedo-wharf"].depth.partialSourceDates.includes("2013-06"));
  assert.ok(artifact.sites["stearns-wharf"].structure.chartedFeatures
    .some((feature) => feature.partialSourceDates.includes("2005")));

  const directory = await mkdtemp(join(tmpdir(), "castingcompass-structure-depth-date-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await readJson(snapshotPath);
  snapshot.sites["torpedo-wharf"].queries["soundings:context"].features[0].attributes.SORDAT = "201313";
  const source = join(directory, "source.json");
  const output = join(directory, "artifact.json");
  await writeFile(source, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = runCollector(output, source);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rejected = JSON.parse(await readFile(output, "utf8"));
  assert.equal(rejected.status, "partial");
  assert.equal(rejected.sites["torpedo-wharf"].depth.status, "source-unavailable");
  assert.equal(rejected.sites["torpedo-wharf"].structure.status, "charted-features-present");
});
