import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/ai-review-exercise-stub.ts";

const EXERCISE_ID = "sec_0123456789abcdef0123456789abcdef";
const ENV = {
  SECURITY_EXERCISE_ID: EXERCISE_ID,
  CF_VERSION_METADATA: { id: "stub-version-456" },
};

function request(overrides = {}) {
  const body = {
    model: "castingcompass-isolated-stub-v1",
    max_completion_tokens: 950,
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: "s".repeat(200) },
      { role: "user", content: JSON.stringify({ siteId: "synthetic-site" }) },
    ],
    ...(overrides.body ?? {}),
  };
  return new Request(overrides.url ?? "https://ai-review-stub.invalid/v1/chat/completions", {
    method: overrides.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CastingCompass-Exercise-Contract": "castingcompass.ai-review-exercise-provider/1.0.0",
      "X-CastingCompass-Exercise-Id": EXERCISE_ID,
      ...(overrides.headers ?? {}),
    },
    body: overrides.method === "GET" ? undefined : JSON.stringify(body),
  });
}

test("the isolated stub returns deterministic private non-model output and its exact Worker identity", async () => {
  const response = await worker.fetch(request(), ENV);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-CastingCompass-Exercise-Provider-Version"), "stub-version-456");
  const envelope = await response.json();
  const review = JSON.parse(envelope.choices[0].message.content);
  assert.equal(review.needs_human_review, true);
  assert.equal(review.discussion.publish, false);
  assert.deepEqual(review.flags, ["exercise_stub_output"]);
  assert.match(review.summary, /not a real model review/u);
  assert.doesNotMatch(JSON.stringify(review), /synthetic-site/u);
});

test("the stub rejects public-provider credentials, identity drift, widened routes, and malformed envelopes", async () => {
  for (const candidate of [
    request({ headers: { "api-key": "must-never-arrive" } }),
    request({ headers: { "X-CastingCompass-Exercise-Id": "sec_ffffffffffffffffffffffffffffffff" } }),
    request({ url: "https://ai-review-stub.invalid/other" }),
    request({ method: "GET" }),
    request({ body: { model: "mimo-v2.5" } }),
  ]) {
    const response = await worker.fetch(candidate, ENV);
    assert.notEqual(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("the stub fails closed when its environment identity is absent or invalid", async () => {
  for (const env of [
    {},
    { ...ENV, SECURITY_EXERCISE_ID: "unsafe" },
    { ...ENV, CF_VERSION_METADATA: { id: "bad/version" } },
  ]) {
    assert.equal((await worker.fetch(request(), env)).status, 503);
  }
});
