import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { buildReplayPlan } from "../scripts/ai-review-queue-operator.mjs";
import { verifyAiReviewQueuePolicy } from "../scripts/verify-ai-review-queue-policy.mjs";

test("AI review queue policy is default-off, minimal, bounded, and provider-unbound", async () => {
  assert.deepEqual(await verifyAiReviewQueuePolicy(), {
    schemaVersion: "castingcompass.ai-review-queue-policy/1.0.0",
    messageContract: "castingcompass.ai-review-queue/1.0.0",
    productionDefault: "false",
    providerBindingsPresent: false,
    maximumAttempts: 5,
    deadLetterQueueRequired: true,
  });
});

test("the queue message schema compiles strictly and rejects identity or authority expansion", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../contracts/ai-review-queue-message.schema.json", import.meta.url),
    "utf8",
  ));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const good = {
    version: "castingcompass.ai-review-queue/1.0.0",
    jobId: "airj_0123456789abcdef0123456789abcdef",
  };
  assert.equal(validate(good), true);
  for (const bad of [
    { ...good, tripId: "trip_private" },
    { ...good, userId: "user_private" },
    { ...good, jobId: "airj_0123" },
    { ...good, jobId: "airj_0123456789ABCDEF0123456789ABCDEF" },
    { ...good, version: "castingcompass.ai-review-queue/2.0.0" },
  ]) assert.equal(validate(bad), false);
});

test("operator replay accepts only opaque attention-job identities and cannot publish directly", () => {
  const jobId = "airj_0123456789abcdef0123456789abcdef";
  const plan = buildReplayPlan(jobId);
  assert.equal(plan.jobId, jobId);
  assert.equal(plan.requiredCurrentState, "needs_attention");
  assert.equal(plan.changesProviderState, false);
  assert.match(plan.sql, /WHERE id = 'airj_[a-f0-9]{32}' AND state = 'needs_attention'/);
  assert.match(plan.sql, /trips\.ai_review_status = 'retry'/);
  assert.match(plan.sql, /trips\.ai_review_status = 'needs_attention'/);
  assert.doesNotMatch(plan.sql, /INSERT|DELETE|AI_REVIEW_QUEUE|MIMO|user_id|email|notes/i);
  for (const invalid of ["trip_private", "airj_../secret", "airj_A123", "airj_0123' OR 1=1 --"]) {
    assert.throws(() => buildReplayPlan(invalid), /opaque airj_/);
  }
});

test("CI security entry point includes the queue policy verifier", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts.security, /security:ai-review-queue-policy/);
  assert.equal(manifest.scripts["ai-review-queue:plan-replay"], "node scripts/ai-review-queue-operator.mjs plan-replay");
});
