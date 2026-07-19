import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

function keys(value) {
  return Object.keys(value).sort();
}

async function plan() {
  return JSON.parse(await read("research/user-interview-plan.json"));
}

const expectedInterviewIds = [
  "relative-ranking",
  "source-freshness",
  "limitations-safety-legality",
  "trip-report-privacy",
  "combined-comprehension",
];

test("user-interview plan is exact, draft-only, and contains five bounded scripts", async () => {
  const value = await plan();
  assert.deepEqual(keys(value), [
    "claimBoundary",
    "interviews",
    "participantBoundary",
    "ratingScale",
    "researchExecutionAuthorized",
    "reviewedOn",
    "schemaVersion",
    "status",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.reviewedOn, "2026-07-19");
  assert.equal(value.status, "draft_only");
  assert.equal(value.researchExecutionAuthorized, false);
  assert.equal(
    value.claimBoundary,
    "comprehension_research_only_not_model_validation_or_fishing_outcome_evidence",
  );
  assert.deepEqual(value.ratingScale, [
    "understood",
    "partly_understood",
    "misunderstood",
    "not_observed",
  ]);

  assert.deepEqual(value.interviews.map(({ id }) => id), expectedInterviewIds);
  assert.equal(new Set(value.interviews.map(({ id }) => id)).size, 5);
  for (const interview of value.interviews) {
    assert.deepEqual(keys(interview), [
      "durationMinutes",
      "expectedConcepts",
      "id",
      "prompts",
      "scenario",
      "title",
    ]);
    assert.ok(interview.durationMinutes >= 3 && interview.durationMinutes <= 5);
    assert.match(interview.scenario, /fictional/u);
    assert.equal(interview.prompts.length, 4);
    assert.ok(interview.prompts.every((prompt) => prompt.endsWith("?")));
    assert.equal(interview.expectedConcepts.length, 3);
  }
});

test("interview prompts cannot request private or real-trip data", async () => {
  const value = await plan();
  const boundary = value.participantBoundary;
  assert.deepEqual(keys(boundary), [
    "accountRequired",
    "allowedCapture",
    "prohibitedCollection",
    "realTripDisclosureRequired",
    "recordingAllowed",
    "volunteeredSensitiveDataResponse",
  ]);
  assert.equal(boundary.accountRequired, false);
  assert.equal(boundary.recordingAllowed, false);
  assert.equal(boundary.realTripDisclosureRequired, false);
  assert.deepEqual(boundary.allowedCapture, [
    "aggregate non-identifying comprehension tallies",
  ]);
  assert.equal(boundary.prohibitedCollection.length, 7);
  assert.ok(boundary.prohibitedCollection.includes("precise fishing locations or coordinates"));
  assert.ok(boundary.prohibitedCollection.includes("credentials, cookies, tokens, or recovery codes"));
  assert.ok(boundary.prohibitedCollection.includes("real trip notes or fishing history"));
  assert.match(boundary.volunteeredSensitiveDataResponse, /do not copy or summarize/u);

  const promptSurface = value.interviews.flatMap((interview) => [
    interview.scenario,
    ...interview.prompts,
  ]).join("\n");
  assert.doesNotMatch(promptSurface, /(?:your|their) (?:name|email|phone|password|account id)/iu);
  assert.doesNotMatch(promptSurface, /where exactly do you fish|share (?:your|a) location|coordinates/iu);
  assert.doesNotMatch(promptSurface, /describe (?:your|a) real trip|upload|attach|sign in|log in/iu);

  const raw = JSON.stringify(value);
  assert.doesNotMatch(raw, /authorization:\s*bearer/iu);
  assert.doesNotMatch(raw, /(?:api|access|session)[_-]?(?:key|token|cookie)\s*[=:]\s*["'][A-Za-z0-9_-]{12,}/iu);
});

test("human guide mirrors all scripts and preserves the no-evidence boundary", async () => {
  const [value, guide, goals, publicStatus] = await Promise.all([
    plan(),
    read("docs/USER-INTERVIEWS.md"),
    read("docs/GOAL_STATUS.md"),
    read("validation/public-status.json"),
  ]);
  const headings = [...guide.matchAll(/^### Interview \d — (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, value.interviews.map(({ title }) => title));
  assert.match(guide, /researchExecutionAuthorized` remains `false`/u);
  assert.match(guide, /Do not record audio, video, a transcript, raw quotes, or\s+participant-level notes/u);
  assert.match(guide, /aggregate non-identifying tally/u);
  assert.match(guide, /cannot validate the Opportunity Score/u);
  assert.match(guide, /does not change the all-zero public validation status/u);
  assert.match(goals, /\[x\] Draft five short user-interview scripts/u);

  const status = JSON.parse(publicStatus);
  assert.equal(status.prospectiveStudyActivated, false);
  assert.ok(Object.values(status.eligibleValidationEvidence).every((count) => count === 0));
  assert.ok(Object.values(status.completedPerformanceAnalyses).every((count) => count === 0));
});
