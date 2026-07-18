import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSnapshot } from "../scripts/submit-python-dependency-snapshot.mjs";

const snapshot = buildSnapshot({
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  runId: "12345",
  runAttempt: "2",
  serverUrl: "https://github.com",
  scanned: "2026-07-17T00:00:00.000Z",
});

test("Python dependency snapshot publishes exact versioned lock inventories", () => {
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.job.correlator, "castingcompass-python-locks");
  assert.equal(snapshot.job.id, "12345.2");
  assert.equal(snapshot.detector.name, "castingcompass-python-locks");

  const runtime = snapshot.manifests["services/api/requirements.txt"];
  const tests = snapshot.manifests["services/api/requirements-test.in"];
  const pipeline = snapshot.manifests["pipeline/requirements-ci.in"];
  assert.equal(Object.keys(runtime.resolved).length, 24);
  assert.equal(Object.keys(tests.resolved).length, 32);
  assert.equal(Object.keys(pipeline.resolved).length, 14);

  assert.deepEqual(runtime.resolved.psycopg, {
    package_url: "pkg:pypi/psycopg@3.3.4",
    relationship: "direct",
    scope: "runtime",
  });
  assert.deepEqual(tests.resolved.pytest, {
    package_url: "pkg:pypi/pytest@9.0.3",
    relationship: "direct",
    scope: "development",
  });
  assert.deepEqual(runtime.resolved.starlette, {
    package_url: "pkg:pypi/starlette@1.3.1",
    relationship: "direct",
    scope: "runtime",
  });
  assert.deepEqual(tests.resolved.httpx2, {
    package_url: "pkg:pypi/httpx2@2.7.0",
    relationship: "direct",
    scope: "development",
  });
  assert.equal("httpx" in tests.resolved, false);
  assert.equal(tests.resolved.anyio.relationship, "indirect");
  assert.equal(pipeline.resolved.ruff.relationship, "direct");
  assert.equal(pipeline.resolved.pycparser.relationship, "indirect");

  for (const manifest of Object.values(snapshot.manifests)) {
    assert.match(manifest.metadata["castingcompass:lock-sha256"], /^[a-f0-9]{64}$/);
    for (const dependency of Object.values(manifest.resolved)) {
      assert.match(dependency.package_url, /^pkg:pypi\/[a-z0-9-]+@[^@]+$/);
      assert.notEqual(dependency.package_url.endsWith("@null"), true);
    }
  }
});

test("dependency submission waits for tested main locks and has narrow write permission", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /dependency-submission:[\s\S]+needs:\s*\[api, pipeline\]/);
  assert.match(workflow, /github\.event_name == 'push'[\s\S]+github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /dependency-submission:[\s\S]+permissions:[\s\S]+contents:\s*write/);
  assert.match(workflow, /submit-python-dependency-snapshot\.mjs --submit/);
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test("dependency snapshot rejects non-main and incomplete identities", () => {
  assert.throws(() => buildSnapshot({
    sha: "short",
    ref: "refs/heads/main",
    runId: "1",
    runAttempt: "1",
    serverUrl: "https://github.com",
    scanned: "2026-07-17T00:00:00.000Z",
  }), /full commit SHA/);
  assert.throws(() => buildSnapshot({
    sha: "a".repeat(40),
    ref: "refs/heads/feature",
    runId: "1",
    runAttempt: "1",
    serverUrl: "https://github.com",
    scanned: "2026-07-17T00:00:00.000Z",
  }), /only refs\/heads\/main/);
});
