import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("SFPUC coverage audit exposes candidates but cannot create policy mappings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "audit.json");
  const result = spawnSync(
    "python3",
    [
      "scripts/audit_sfpuc_station_coverage.py",
      "--as-of", "2026-07-21T12:30:00Z",
      "--source-file", "tests/fixtures/sfpuc-beaches-water-quality.xml",
      "--site-id", "torpedo-wharf",
      "--site-id", "pier-7",
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.schemaVersion, "castingcompass.water-quality-coverage-audit/1.0.0");
  assert.equal(payload.generatedAt, "2026-07-21T12:30:00Z");
  assert.equal(payload.automaticMappingAllowed, false);
  assert.equal(payload.source.stationCount, 9);
  assert.deepEqual(payload.sites.map((site) => site.siteId), ["torpedo-wharf", "pier-7"]);
  assert.ok(payload.sites.every((site) => site.policyMapped === false));
  assert.ok(payload.sites.every((site) => site.automaticMappingAllowed === false));
  assert.ok(payload.sites.every((site) => site.automatedDisposition === "candidate-only-do-not-map"));
  assert.ok(payload.sites.every((site) => site.nearestOfficialStations.length === 4));
  assert.ok(payload.sites.every((site) => site.nearestOfficialStations.every((station) => station.distanceMeters > 0)));
  assert.ok(payload.sites.every((site) => site.nearestOfficialStations.every(
    (station) => typeof station.stationName === "string" && station.stationName.length <= 160,
  )));
});

test("coverage audit fails closed on invalid official station coordinates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-audit-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "invalid.xml");
  const output = join(directory, "audit.json");
  const fixture = await readFile(new URL("fixtures/sfpuc-beaches-water-quality.xml", import.meta.url), "utf8");
  await writeFile(source, fixture.replace('"lat":"37.73567"', '"lat":"not-a-coordinate"'));
  const result = spawnSync(
    "python3",
    [
      "scripts/audit_sfpuc_station_coverage.py",
      "--as-of", "2026-07-21T12:30:00Z",
      "--source-file", source,
      "--site-id", "torpedo-wharf",
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(output));
});

test("checked-in audit keeps unsupported SF waterfront sites fail-closed", async () => {
  const [audit, policy, overlay, auditTool] = await Promise.all([
    readJson("water-quality/audits/sf-unmapped-station-candidates.json"),
    readJson("water-quality/policy.json"),
    readJson("public/data/water-quality.json"),
    readFile(new URL("scripts/audit_sfpuc_station_coverage.py", root)),
  ]);
  const expectedSiteIds = ["torpedo-wharf", "pier-7", "pier-14", "herons-head-park-pier"];
  assert.deepEqual(audit.sites.map((site) => site.siteId), expectedSiteIds);
  assert.equal(audit.automaticMappingAllowed, false);
  assert.equal(audit.source.stationCount, 20);
  assert.equal(audit.auditToolSha256, createHash("sha256").update(auditTool).digest("hex"));
  for (const site of audit.sites) {
    assert.equal(site.policyMapped, false);
    assert.equal(site.automaticMappingAllowed, false);
    assert.equal(site.automatedDisposition, "candidate-only-do-not-map");
    assert.equal(policy.site_mappings[site.siteId], undefined);
    assert.equal(overlay.sites[site.siteId].status, "not-covered");
    assert.equal(overlay.sites[site.siteId].recommendationEffect, "unknown");
    assert.equal(overlay.sites[site.siteId].scoreDelta, null);
  }
});
