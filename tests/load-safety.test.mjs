import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateResults,
  percentile,
  validateTarget,
} from "../scripts/load-test.mjs";

test("load harness permanently refuses every production hostname", () => {
  for (const target of [
    "https://castingcompass.com",
    "https://www.castingcompass.com",
    "https://preview.castingcompass.com",
    "https://castcompass.brianbzeng.com",
    "https://contourcast.brianbzeng.com",
  ]) {
    assert.throws(() => validateTarget(target, "I_HAVE_AUTHORIZATION_FOR_THIS_STAGING_TARGET"), /production/);
  }
});

test("load harness permits localhost but requires explicit authorization for remote staging", () => {
  assert.equal(validateTarget("http://127.0.0.1:8787").origin, "http://127.0.0.1:8787");
  assert.equal(validateTarget("http://[::1]:8787").origin, "http://[::1]:8787");
  assert.throws(() => validateTarget("https://example.workers.dev"), /requires CASTINGCOMPASS_LOAD_AUTHORIZATION/);
  assert.equal(
    validateTarget(
      "https://example.workers.dev",
      "I_HAVE_AUTHORIZATION_FOR_THIS_STAGING_TARGET",
    ).origin,
    "https://example.workers.dev",
  );
  assert.throws(() => validateTarget("https://user:secret@example.test"), /only scheme/);
});

test("tail latency and error budgets fail closed", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  const budgets = { p95Milliseconds: 100, p99Milliseconds: 150, errorRatePercent: 1 };
  assert.equal(evaluateResults([20, 30, 40], 0, budgets).passed, true);
  assert.equal(evaluateResults([20, 30, 200], 0, budgets).passed, false);
  assert.equal(evaluateResults([20, 30, 40], 1, budgets).passed, false);
  assert.equal(evaluateResults([], 0, budgets).passed, false);
});
