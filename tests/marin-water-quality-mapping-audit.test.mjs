import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const fixturePath = "tests/fixtures/california-beachwatch-marin-stations.html";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("Marin mapping audit is deterministic, exact-name-bound, and review-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-marin-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "audit.json");
  const result = spawnSync(
    "python3",
    [
      "scripts/audit_marin_beachwatch_station_mappings.py",
      "--as-of", "2026-07-21T14:25:00Z",
      "--source-file", fixturePath,
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.schemaVersion, "castingcompass.water-quality-mapping-audit/1.1.0");
  assert.equal(payload.generatedAt, "2026-07-21T14:25:00Z");
  assert.equal(payload.sourceId, "california-beachwatch-marin");
  assert.equal(payload.automaticMappingAllowed, false);
  assert.equal(payload.independentReviewRequired, true);
  assert.equal(payload.source.stationCount, 31);
  assert.equal(payload.source.registryUse, "exact public station identity only; never current advisory status");
  assert.deepEqual(payload.mappedSites.map((site) => site.siteId), [
    "drakes-beach", "bolinas-beach", "stinson-beach", "muir-beach",
    "rodeo-beach", "mcnears-beach-pier",
  ]);
  assert.deepEqual(payload.unmappedSites.map((site) => site.siteId), [
    "limantour-beach", "point-reyes-south-beach", "paradise-beach-pier", "fort-baker-pier",
  ]);
  assert.ok(payload.mappedSites.every((site) => site.policyMapped));
  assert.ok(payload.mappedSites.every((site) => site.identityBasis === "exact official registry station name"));
  assert.ok(payload.mappedSites.every((site) => site.automaticMappingAllowed === false));
  assert.equal(
    payload.unmappedSites.find((site) => site.siteId === "paradise-beach-pier")
      .rejectedCandidate.rejectionReason,
    "different-public-location-identity",
  );
});

test("Marin mapping audit rejects a missing reviewed station", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-marin-audit-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "stations.html");
  const output = join(directory, "audit.json");
  const fixture = await readFile(new URL("fixtures/california-beachwatch-marin-stations.html", import.meta.url), "utf8");
  await writeFile(source, fixture.replace("<option value=\"241\">BOLINAS</option>\n", ""));
  const result = spawnSync(
    "python3",
    [
      "scripts/audit_marin_beachwatch_station_mappings.py",
      "--source-file", source,
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(output));
});

test("Marin mapping audit rejects unfinished registry markup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-marin-audit-malformed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "stations.html");
  const output = join(directory, "audit.json");
  const fixture = await readFile(
    new URL("fixtures/california-beachwatch-marin-stations.html", import.meta.url),
    "utf8",
  );
  await writeFile(source, `${fixture}<option value="999">UNFINISHED`);
  const result = spawnSync(
    "python3",
    [
      "scripts/audit_marin_beachwatch_station_mappings.py",
      "--source-file", source,
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(output));
});

test("checked-in Marin receipt binds exact mappings and preserves four unsupported sites", async () => {
  const [audit, policy, overlay, auditTool, policyBytes, siteBytes] = await Promise.all([
    readJson("water-quality/audits/marin-beachwatch-station-mappings.json"),
    readJson("water-quality/policy.json"),
    readJson("public/data/water-quality.json"),
    readFile(new URL("scripts/audit_marin_beachwatch_station_mappings.py", root)),
    readFile(new URL("water-quality/policy.json", root)),
    readFile(new URL("data/sites.json", root)),
  ]);
  assert.equal(audit.auditToolSha256, createHash("sha256").update(auditTool).digest("hex"));
  assert.equal(audit.policySha256, createHash("sha256").update(policyBytes).digest("hex"));
  assert.equal(audit.siteCatalogSha256, createHash("sha256").update(siteBytes).digest("hex"));
  for (const site of audit.mappedSites) {
    assert.equal(policy.site_mappings[site.siteId].source_id, "california-beachwatch-marin");
    assert.deepEqual(
      site.stationSupport.map((station) => station.stationName),
      policy.site_mappings[site.siteId].station_ids,
    );
    assert.equal(overlay.sites[site.siteId].scoreDelta, null);
  }
  for (const site of audit.unmappedSites) {
    assert.equal(policy.site_mappings[site.siteId], undefined);
    assert.equal(overlay.sites[site.siteId].status, "not-covered");
    assert.equal(overlay.sites[site.siteId].recommendationEffect, "unknown");
    assert.equal(overlay.sites[site.siteId].scoreDelta, null);
  }
});
