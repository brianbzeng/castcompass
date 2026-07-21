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
const sfpucFixture = "tests/fixtures/sfpuc-beaches-water-quality.xml";
const beachwatchFixture = "tests/fixtures/california-beachwatch-santa-barbara.html";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runCollector(output, options = {}) {
  const args = [
    "scripts/refresh_water_quality.py",
    "--as-of", options.asOf ?? "2026-07-20T20:00:00Z",
    "--sfpuc-source-file", options.sfpucSource ?? sfpucFixture,
    "--beachwatch-source-file", options.beachwatchSource ?? beachwatchFixture,
    "--output", output,
  ];
  return spawnSync("python3", args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
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
  assert.equal(overlay.schemaVersion, "castingcompass.water-quality-advisory/2.0.0");
  assert.equal(overlay.policyVersion, policy.policy_version);
  assert.equal(overlay.policySha256, sha256(policyBytes));
  assert.equal(overlay.collectorSha256, sha256(collectorBytes));
  assert.equal(overlay.siteCatalogSha256, sha256(siteBytes));
  assert.deepEqual(Object.keys(overlay.sources).sort(), Object.keys(policy.sources).sort());
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

test("deterministic fixtures preserve source-specific suppression, neutral, unknown, and uncovered states", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "water-quality.json");
  const result = runCollector(output);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.status, "partial");
  assert.deepEqual(
    Object.fromEntries([
      "baker-beach", "china-beach", "crane-cove-park", "crissy-field-east-beach",
      "ocean-beach-north", "ocean-beach-south", "gaviota-state-park-beach",
      "refugio-state-beach", "leadbetter-beach", "goleta-beach", "mesa-lane-beach", "pier-7",
    ].map((siteId) => [siteId, [payload.sites[siteId].status, payload.sites[siteId].recommendationEffect]])),
    {
      "baker-beach": ["posted", "suppress"],
      "china-beach": ["advisory", "suppress"],
      "crane-cove-park": ["closure", "suppress"],
      "crissy-field-east-beach": ["no-active-posting", "neutral"],
      "ocean-beach-north": ["stale", "unknown"],
      "ocean-beach-south": ["unmonitored", "unknown"],
      "gaviota-state-park-beach": ["posted", "suppress"],
      "refugio-state-beach": ["posted", "suppress"],
      "leadbetter-beach": ["unknown", "unknown"],
      "goleta-beach": ["unknown", "unknown"],
      "mesa-lane-beach": ["unknown", "unknown"],
      "pier-7": ["not-covered", "unknown"],
    },
  );
  assert.equal(payload.sites["crissy-field-east-beach"].scoreDelta, null);
  assert.match(payload.sites["crissy-field-east-beach"].detail, /does not improve the fishing score/i);
  assert.deepEqual(payload.sites["gaviota-state-park-beach"].actionStartDates, ["2026-06-15"]);
  assert.deepEqual(payload.sites["gaviota-state-park-beach"].actionEndDates, []);
  assert.match(payload.sites["leadbetter-beach"].detail, /absence does not prove/i);
});

test("one unavailable source fails closed without erasing the independent source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "water-quality.json");
  const missing = join(directory, "does-not-exist.xml");
  const result = runCollector(output, { sfpucSource: missing });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.status, "partial");
  assert.equal(payload.sources.sfpuc.errorCategory, "source-file-unavailable");
  assert.equal(payload.sites["baker-beach"].status, "source-unavailable");
  assert.equal(payload.sites["gaviota-state-park-beach"].status, "posted");
  assert.equal(JSON.stringify(payload).includes(directory), false);
});

test("an unreviewed SFPUC status encoding fails closed to unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-quality-code-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.xml");
  const output = join(directory, "water-quality.json");
  const fixture = await readFile(new URL(sfpucFixture, root), "utf8");
  await writeFile(
    source,
    fixture.replace(
      '"stationid":"4612","stationname":"Crissy Field Beach East","cso":null,"s_color":null',
      '"stationid":"4612","stationname":"Crissy Field Beach East","cso":null,"s_color":"P"',
    ),
  );
  const result = runCollector(output, { sfpucSource: source });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.sites["crissy-field-east-beach"].status, "unknown");
  assert.equal(payload.sites["crissy-field-east-beach"].recommendationEffect, "unknown");
  assert.match(payload.sites["crissy-field-east-beach"].detail, /unreviewed status code/);
});

test("an unreviewed BeachWatch action type fails only that source closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-beachwatch-code-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.html");
  const output = join(directory, "water-quality.json");
  const fixture = await readFile(new URL(beachwatchFixture, root), "utf8");
  await writeFile(source, fixture.replace("<td>Posting</td>", "<td>Unreviewed advisory</td>"));
  const result = runCollector(output, { beachwatchSource: source });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(
    payload.sources["california-beachwatch-santa-barbara"].errorCategory,
    "unreviewed-action-type",
  );
  assert.equal(payload.sites["gaviota-state-park-beach"].status, "source-unavailable");
  assert.equal(payload.sites["crissy-field-east-beach"].status, "no-active-posting");
});

test("countywide rain actions apply exactly while station closure precedence stays strict", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-beachwatch-rain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.html");
  const output = join(directory, "water-quality.json");
  const fixture = await readFile(new URL(beachwatchFixture, root), "utf8");
  await writeFile(
    source,
    fixture
      .replace("<td>2026-02-01</td>", "<td>2026-07-19</td>")
      .replace("<td>2026-02-05</td>", "<td></td>")
      .replace("<td>2026-08-01</td>", "<td>2026-07-18</td>"),
  );
  const result = runCollector(output, { beachwatchSource: source });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.sites["mesa-lane-beach"].status, "rain-advisory");
  assert.equal(payload.sites["mesa-lane-beach"].recommendationEffect, "suppress");
  assert.equal(payload.sites["gaviota-state-park-beach"].status, "posted");
  assert.equal(payload.sites["goleta-beach"].status, "closure");
});

test("historical date-order anomalies are inert while recent malformed actions fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-beachwatch-dates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await readFile(new URL(beachwatchFixture, root), "utf8");
  const source = join(directory, "source.html");
  const output = join(directory, "water-quality.json");
  const futureRow = "<td>2026-08-01</td>\n        <td></td>";

  await writeFile(
    source,
    fixture.replace(futureRow, "<td>2020-12-28</td>\n        <td>2020-12-02</td>"),
  );
  let result = runCollector(output, { beachwatchSource: source });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  let payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(payload.sources["california-beachwatch-santa-barbara"].errorCategory, null);
  assert.equal(payload.sites["goleta-beach"].status, "unknown");

  await writeFile(
    source,
    fixture.replace(futureRow, "<td>2026-07-19</td>\n        <td>2026-07-18</td>"),
  );
  result = runCollector(output, { beachwatchSource: source });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  payload = JSON.parse(await readFile(output, "utf8"));
  assert.equal(
    payload.sources["california-beachwatch-santa-barbara"].errorCategory,
    "invalid-action-date",
  );
  assert.equal(payload.sites["goleta-beach"].status, "source-unavailable");
});
