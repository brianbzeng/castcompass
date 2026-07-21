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

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("published advisory overlay is contract-bound and never boosts the score", async () => {
  const [schema, policy, sites, overlay, policyBytes, collectorBytes, siteBytes, interfaceSource, disclosure] = await Promise.all([
    readJson("contracts/water-quality-advisory.schema.json"),
    readJson("water-quality/policy.json"),
    readJson("data/sites.json"),
    readJson("public/data/water-quality.json"),
    readFile(new URL("water-quality/policy.json", root)),
    readFile(new URL("scripts/refresh_water_quality.py", root)),
    readFile(new URL("data/sites.json", root)),
    readFile(new URL("app/components/OpportunityApp.tsx", root), "utf8"),
    readFile(new URL("docs/WATER-QUALITY-ADVISORY.md", root), "utf8"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  assert.equal(ajv.validate(schema, overlay), true, JSON.stringify(ajv.errors));
  assert.equal(overlay.policyVersion, policy.policy_version);
  assert.equal(overlay.policySha256, sha256(policyBytes));
  assert.equal(overlay.collectorSha256, sha256(collectorBytes));
  assert.equal(overlay.siteCatalogSha256, sha256(siteBytes));
  assert.deepEqual(Object.keys(overlay.sites).sort(), sites.map((site) => site.id).sort());
  assert.equal(overlay.scoreContribution.mode, "excluded-pending-frozen-baseline-validation");
  assert.equal(overlay.scoreContribution.positiveContributionAllowed, false);
  assert.ok(Object.values(overlay.sites).every((assessment) => assessment.scoreDelta === null));
  assert.ok(Object.values(overlay.sites).every((assessment) => !/\bsafe\b/i.test(assessment.officialLabel)));
  assert.match(interfaceSource, /recommendationEffect !== "suppress"/);
  assert.match(interfaceSource, /No clean-water or safety claim is made/);
  assert.match(interfaceSource, /does not improve this fishing score/);
  assert.match(disclosure, /broader roadmap item stays open/i);
  assert.match(disclosure, /every numeric scoreDelta remains null/i);
});

test("deterministic fixture exercises suppression, neutral, stale, unmonitored, and uncovered states", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "water-quality.json");
  const result = spawnSync(
    "python3",
    [
      "scripts/refresh_water_quality.py",
      "--as-of", "2026-07-20T20:00:00Z",
      "--source-file", "tests/fixtures/sfpuc-beaches-water-quality.xml",
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.status, "partial");
  assert.deepEqual(
    Object.fromEntries([
      "baker-beach", "china-beach", "crane-cove-park", "crissy-field-east-beach",
      "ocean-beach-north", "ocean-beach-south", "pier-7",
    ].map((siteId) => [siteId, [payload.sites[siteId].status, payload.sites[siteId].recommendationEffect]])),
    {
      "baker-beach": ["posted", "suppress"],
      "china-beach": ["advisory", "suppress"],
      "crane-cove-park": ["closure", "suppress"],
      "crissy-field-east-beach": ["no-active-posting", "neutral"],
      "ocean-beach-north": ["stale", "unknown"],
      "ocean-beach-south": ["unmonitored", "unknown"],
      "pier-7": ["not-covered", "unknown"],
    },
  );
  assert.equal(payload.sites["crissy-field-east-beach"].scoreDelta, null);
  assert.match(payload.sites["crissy-field-east-beach"].detail, /does not improve the fishing score/i);
});

test("malformed or unavailable source data fails closed without publishing raw exception details", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "water-quality.json");
  const result = spawnSync(
    "python3",
    [
      "scripts/refresh_water_quality.py",
      "--as-of", "2026-07-20T20:00:00Z",
      "--source-file", "tests/fixtures/does-not-exist.xml",
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.status, "unavailable");
  assert.equal(payload.source.errorCategory, "source-file-unavailable");
  assert.equal(payload.sites["baker-beach"].status, "source-unavailable");
  assert.equal(payload.sites["baker-beach"].recommendationEffect, "unknown");
  assert.equal(JSON.stringify(payload).includes(directory), false);
});

test("an unreviewed agency status encoding fails closed to unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-code-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.xml");
  const output = join(directory, "water-quality.json");
  const fixture = await readFile(
    new URL("tests/fixtures/sfpuc-beaches-water-quality.xml", root),
    "utf8",
  );
  await writeFile(
    source,
    fixture.replace(
      '"stationid":"4612","stationname":"Crissy Field Beach East","cso":null,"s_color":null',
      '"stationid":"4612","stationname":"Crissy Field Beach East","cso":null,"s_color":"P"',
    ),
  );
  const result = spawnSync(
    "python3",
    [
      "scripts/refresh_water_quality.py",
      "--as-of", "2026-07-20T20:00:00Z",
      "--source-file", source,
      "--output", output,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.sites["crissy-field-east-beach"].status, "unknown");
  assert.equal(payload.sites["crissy-field-east-beach"].recommendationEffect, "unknown");
  assert.match(payload.sites["crissy-field-east-beach"].detail, /unreviewed status code/);
});
