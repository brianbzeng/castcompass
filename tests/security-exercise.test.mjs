import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  ACTIVE_EXECUTION_CONFIRMATION,
  aggregateZapReport,
  buildAggregateReceipt,
  buildAutomationPlan,
  buildDockerArguments,
  executeSecurityExercise,
  loadPolicy,
  preflightTarget,
  validateAuthorization,
  validatePolicy,
  validateTargetOrigin,
  validateZapReport,
} from "../scripts/security-exercise.mjs";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const EXERCISE_ID = "sec_0123456789abcdef0123456789abcdef";
const TARGET = "https://isolated.example.test";

function authorization(overrides = {}) {
  const base = {
    schema_version: "castingcompass.security-exercise-authorization/1.0.0",
    exercise_id: EXERCISE_ID,
    source_commit: "a".repeat(40),
    mode: "active-staging",
    environment: "isolated-staging",
    target_origin: TARGET,
    expected_worker_version_id: "version-123",
    window_start_at: "2026-07-18T11:00:00.000Z",
    window_end_at: "2026-07-18T13:00:00.000Z",
    authorization: {
      written_scope_approved: true,
      active_testing_approved: true,
      independent_tester_authorized: true,
    },
    safety: {
      synthetic_data_only: true,
      production_bindings_attached: false,
      production_user_data_accessible: false,
      external_providers_disabled: true,
      outbound_callbacks_disabled: true,
      monitoring_operator_ready: true,
      emergency_stop_verified: true,
    },
  };
  return {
    ...base,
    ...overrides,
    authorization: { ...base.authorization, ...(overrides.authorization ?? {}) },
    safety: { ...base.safety, ...(overrides.safety ?? {}) },
  };
}

function acceptedHealth(overrides = {}) {
  return new Response(JSON.stringify({
    status: "ok",
    service: "castingcompass-web",
    workerVersionId: "version-123",
    releaseMaintenance: false,
    securityExerciseId: EXERCISE_ID,
    ...overrides,
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function privateTemporaryParent() {
  const parent = mkdtempSync(join(tmpdir(), "castingcompass-security-exercise-"));
  chmodSync(parent, 0o700);
  return parent;
}

test("the locked policy pins the scanner, production host inventory, limits, and open gates", () => {
  const policy = loadPolicy();
  assert.equal(policy.scanner.version, "2.17.0");
  assert.equal(
    policy.scanner.image_reference,
    "ghcr.io/zaproxy/zaproxy@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2",
  );
  assert.equal(Object.values(policy.production_gates).every((value) => value === false), true);

  const weakened = structuredClone(policy);
  weakened.limits.threads_per_host = 2;
  assert.throws(() => validatePolicy(weakened), /weakened/u);
  const selfApproved = structuredClone(policy);
  selfApproved.production_gates.isolated_staging_provisioned = true;
  assert.throws(() => validatePolicy(selfApproved), /cannot self-approve/u);
});

test("CI and release provenance verify the fail-closed exercise policy without running a scan", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const release = readFileSync(
    new URL("../.github/workflows/release-provenance.yml", import.meta.url),
    "utf8",
  );
  for (const workflow of [ci, release]) {
    assert.match(
      workflow,
      /npm run security:release-sbom\n\s+- run: npm run security:api-image-upstream-watch\n\s+- run: npm run security:exercise-policy/u,
    );
    assert.doesNotMatch(workflow, /security:exercise-(?:plan|run)/u);
  }
});

test("every production alias and CastingCompass subdomain is permanently blocked", () => {
  const policy = loadPolicy();
  for (const target of [
    "https://castingcompass.com",
    "https://www.castingcompass.com",
    "https://castcompass.brianbzeng.com",
    "https://contourcast.brianbzeng.com",
    "https://preview.castingcompass.com",
  ]) {
    assert.throws(
      () => validateTargetOrigin(target, policy, "active-staging", "isolated-staging"),
      /permanently blocked/u,
    );
  }
});

test("target parsing rejects credentials, paths, queries, fragments, IPs, cleartext, and loopback active scans", () => {
  const policy = loadPolicy();
  for (const target of [
    "https://user:secret@isolated.example.test",
    "https://isolated.example.test/path",
    "https://isolated.example.test?scope=widened",
    "https://isolated.example.test#fragment",
    "ftp://isolated.example.test",
    "https://castingcompass.com.",
    "https://ISOLATED.example.test",
    "https://isolated.example.test:443",
    "https://isolated_example.test",
  ]) {
    assert.throws(
      () => validateTargetOrigin(target, policy, "active-staging", "isolated-staging"),
      /Target must|canonical DNS/u,
    );
  }
  for (const target of ["https://127.0.0.2", "http://isolated.example.test", "http://127.0.0.1:8787"]) {
    assert.throws(
      () => validateTargetOrigin(target, policy, "active-staging", "isolated-staging"),
    );
  }
  assert.equal(
    validateTargetOrigin("http://127.0.0.1:8787", policy, "passive-baseline", "local-synthetic").origin,
    "http://127.0.0.1:8787",
  );
});

test("authorization rejects extra fields, stale or oversized windows, and every false safety assurance", () => {
  const policy = loadPolicy();
  assert.equal(validateAuthorization(authorization(), policy, { now: NOW }).target.origin, TARGET);
  assert.throws(
    () => validateAuthorization({ ...authorization(), operator_email: "private@example.test" }, policy, { now: NOW }),
    /contract rejected/u,
  );
  assert.throws(
    () => validateAuthorization(authorization({ window_end_at: "2026-07-19T13:00:00.000Z" }), policy, { now: NOW }),
    /window/u,
  );
  assert.throws(
    () => validateAuthorization(authorization({ window_end_at: "2026-07-18T11:30:00.000Z" }), policy, { now: NOW }),
    /window/u,
  );
  for (const [key, unsafe] of [
    ["synthetic_data_only", false],
    ["production_bindings_attached", true],
    ["production_user_data_accessible", true],
    ["external_providers_disabled", false],
    ["outbound_callbacks_disabled", false],
    ["monitoring_operator_ready", false],
    ["emergency_stop_verified", false],
  ]) {
    assert.throws(
      () => validateAuthorization(authorization({ safety: { [key]: unsafe } }), policy, { now: NOW }),
      /gate/u,
    );
  }
  for (const key of ["active_testing_approved", "independent_tester_authorized"]) {
    assert.throws(
      () => validateAuthorization(authorization({ authorization: { [key]: false } }), policy, { now: NOW }),
      /independent authorization/u,
    );
  }
});

test("preflight binds the exact health marker and Worker version without following redirects", async () => {
  const policy = loadPolicy();
  const validated = validateAuthorization(authorization(), policy, { now: NOW });
  let request;
  await preflightTarget(validated, policy, {
    fetchImpl: async (input, init) => {
      request = { input: String(input), init };
      return acceptedHealth();
    },
  });
  assert.equal(request.input, `${TARGET}/api/health`);
  assert.equal(request.init.redirect, "manual");

  for (const response of [
    new Response(null, { status: 302, headers: { Location: "https://castingcompass.com/api/health" } }),
    acceptedHealth({ workerVersionId: "wrong-worker" }),
    acceptedHealth({ securityExerciseId: "sec_ffffffffffffffffffffffffffffffff" }),
    acceptedHealth({ releaseMaintenance: true }),
    new Response("{}", { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }),
  ]) {
    await assert.rejects(
      () => preflightTarget(validated, policy, { fetchImpl: async () => response }),
    );
  }
});

test("the generated ZAP plan stays on the public unauthenticated scope with fixed low-impact limits", () => {
  const policy = loadPolicy();
  const validated = validateAuthorization(authorization(), policy, { now: NOW });
  const plan = buildAutomationPlan(validated, policy);
  assert.equal(plan.includes('"^https://isolated\\\\.example\\\\.test/$"'), true);
  assert.equal(plan.includes('"^https://isolated\\\\.example\\\\.test/api/(?!health$).*$"'), true);
  assert.match(plan, /type: activeScan/u);
  assert.match(plan, /maxScanDurationInMins: 15/u);
  assert.match(plan, /maxRuleDurationInMins: 2/u);
  assert.match(plan, /delayInMs: 250/u);
  assert.match(plan, /threadPerHost: 1/u);
  assert.match(plan, /defaultStrength: Low/u);
  assert.doesNotMatch(plan, /auth\/login|auth\/signup|profile\/export|trips\/|Cookie|Authorization:/u);

  const passive = validateAuthorization(authorization({
    mode: "passive-baseline",
    environment: "local-synthetic",
    target_origin: "http://127.0.0.1:8787",
    authorization: { active_testing_approved: false, independent_tester_authorized: false },
  }), policy, { now: NOW });
  assert.doesNotMatch(buildAutomationPlan(passive, policy), /type: activeScan/u);
});

test("the Docker command is digest-pinned, non-privileged, bounded, read-only, and never pulls implicitly", () => {
  const policy = loadPolicy();
  const arguments_ = buildDockerArguments("/private/tmp/private-evidence", policy);
  assert.deepEqual(arguments_.slice(0, 4), ["run", "--rm", "--pull=never", "--read-only"]);
  assert.equal(arguments_.includes("--cap-drop=ALL"), true);
  assert.equal(arguments_.includes("--security-opt=no-new-privileges"), true);
  assert.equal(arguments_.includes("--hostname"), true);
  assert.equal(arguments_.includes("castingcompass-zap:127.0.0.1"), true);
  assert.equal(
    arguments_.includes("JAVA_TOOL_OPTIONS=-Djava.util.prefs.userRoot=/home/zap/.ZAP/java-prefs"),
    true,
  );
  assert.equal(arguments_.some((value) => value.includes("mode=1777")), true);
  assert.equal(arguments_.some((value) => value.includes("uid=1000,gid=1000,mode=0700")), true);
  assert.equal(arguments_.includes("--network=host"), false);
  assert.equal(arguments_.includes(policy.scanner.image_reference), true);
  assert.equal(arguments_.some((value) => value.includes(":latest")), false);
});

test("aggregate evidence excludes target, exercise ID, raw URLs, request data, and every production-ready claim", () => {
  const policy = loadPolicy();
  const report = {
    "@version": "2.17.0",
    site: [{
      "@name": TARGET,
      alerts: [
        { riskcode: "3", url: `${TARGET}/private`, request: "Cookie: secret" },
        { riskcode: "1", evidence: EXERCISE_ID },
      ],
    }],
  };
  assert.deepEqual(aggregateZapReport(report), {
    counts: { critical: 0, high: 1, medium: 0, low: 1, informational: 0 },
    total: 2,
  });
  const receipt = buildAggregateReceipt({
    policy,
    authorization: authorization(),
    report,
    exitCode: 1,
    completedAt: NOW,
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.production_ready, false);
  assert.equal(receipt.acceptance_passed, false);
  assert.equal(receipt.authenticated_business_logic_exercised, false);
  assert.equal(receipt.multi_account_authorization_exercised, false);
  assert.doesNotMatch(serialized, /isolated\.example\.test|sec_0123|\/private|Cookie|secret/u);

  const wrongTarget = structuredClone(report);
  wrongTarget.site[0]["@name"] = "https://different.example.test";
  assert.throws(() => validateZapReport(wrongTarget, policy, new URL(TARGET)), /authorized target/u);
  const malformed = structuredClone(report);
  malformed.site[0].alerts[0].riskcode = "unknown";
  assert.throws(() => buildAggregateReceipt({
    policy,
    authorization: authorization(),
    report: malformed,
    exitCode: 0,
    completedAt: NOW,
  }), /invalid aggregate alert/u);
});

test("rejected authorization never preflights, creates output, or invokes Docker", async () => {
  const policy = loadPolicy();
  const parent = privateTemporaryParent();
  const output = join(parent, "evidence");
  let fetched = false;
  let spawned = false;
  await assert.rejects(
    () => executeSecurityExercise({
      policy,
      authorization: authorization({ target_origin: "https://castingcompass.com" }),
      outputDirectory: output,
      executionConfirmation: ACTIVE_EXECUTION_CONFIRMATION,
      now: NOW,
      checkoutVerifier: async () => { throw new Error("must not be called"); },
      fetchImpl: async () => { fetched = true; return acceptedHealth(); },
      spawnImpl: () => { spawned = true; return { status: 0 }; },
    }),
    /permanently blocked/u,
  );
  assert.equal(fetched, false);
  assert.equal(spawned, false);
  assert.equal(existsSync(output), false);

  await assert.rejects(
    () => executeSecurityExercise({
      policy,
      authorization: authorization(),
      outputDirectory: output,
      executionConfirmation: "",
      now: NOW,
      checkoutVerifier: async () => { throw new Error("must not be called"); },
      fetchImpl: async () => { fetched = true; return acceptedHealth(); },
      spawnImpl: () => { spawned = true; return { status: 0 }; },
    }),
    /confirmation/u,
  );
  assert.equal(fetched, false);
  assert.equal(spawned, false);
});

test("a dirty or wrong-source checkout stops before preflight, evidence creation, and Docker", async () => {
  const policy = loadPolicy();
  const parent = privateTemporaryParent();
  const output = join(parent, "evidence");
  let fetched = false;
  let spawned = false;
  await assert.rejects(
    () => executeSecurityExercise({
      policy,
      authorization: authorization(),
      outputDirectory: output,
      executionConfirmation: ACTIVE_EXECUTION_CONFIRMATION,
      now: NOW,
      checkoutVerifier: async () => { throw new Error("private dirty paths"); },
      fetchImpl: async () => { fetched = true; return acceptedHealth(); },
      spawnImpl: () => { spawned = true; return { status: 0 }; },
    }),
    /clean exact-source checkout/u,
  );
  assert.equal(fetched, false);
  assert.equal(spawned, false);
  assert.equal(existsSync(output), false);
});

test("a fully authorized fake exercise retains private raw evidence and an aggregate-only receipt", async () => {
  const policy = loadPolicy();
  const parent = privateTemporaryParent();
  const output = join(parent, "evidence");
  let spawned = false;
  const receipt = await executeSecurityExercise({
    policy,
    authorization: authorization(),
    outputDirectory: output,
    executionConfirmation: ACTIVE_EXECUTION_CONFIRMATION,
    now: NOW,
    checkoutVerifier: async ({ expectedCommit }) => {
      assert.equal(expectedCommit, "a".repeat(40));
      return { clean: true };
    },
    fetchImpl: async () => acceptedHealth(),
    spawnImpl: (command, arguments_) => {
      spawned = true;
      assert.equal(command, "docker");
      assert.equal(arguments_.includes(policy.scanner.image_reference), true);
      writeFileSync(join(output, "zap-report.json"), JSON.stringify({
        "@version": "2.17.0",
        site: [{ "@name": TARGET, alerts: [{ riskcode: "1", url: `${TARGET}/privacy` }] }],
      }), { mode: 0o600 });
      return { status: 0, stdout: `private scanner log ${TARGET}`, stderr: "" };
    },
  });
  assert.equal(spawned, true);
  assert.equal(receipt.acceptance_passed, true);
  assert.equal(receipt.production_ready, false);
  assert.equal(
    readFileSync(join(output, "scanner-stdout.log"), "utf8"),
    `private scanner log ${TARGET}`,
  );
  const aggregate = readFileSync(join(output, "aggregate-receipt.json"), "utf8");
  assert.doesNotMatch(aggregate, /isolated\.example\.test|sec_0123|\/privacy/u);
});

test("the CLI refuses repository, symlinked, and group-readable authorization files without echoing private values", () => {
  const parent = privateTemporaryParent();
  const authPath = join(parent, "authorization.json");
  writeFileSync(authPath, `${JSON.stringify(authorization())}\n`, { mode: 0o600 });
  chmodSync(authPath, 0o644);
  const output = join(parent, "output");
  const result = spawnSync(process.execPath, [
    new URL("../scripts/security-exercise.mjs", import.meta.url).pathname,
    "plan", "--authorization", authPath, "--output", output,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /authorization-permissions/u);
  assert.doesNotMatch(result.stderr, /isolated\.example\.test|sec_0123|private@example/u);

  chmodSync(authPath, 0o600);
  const symlinkPath = join(parent, "authorization-link.json");
  symlinkSync(authPath, symlinkPath);
  const linked = spawnSync(process.execPath, [
    new URL("../scripts/security-exercise.mjs", import.meta.url).pathname,
    "plan", "--authorization", symlinkPath, "--output", join(parent, "linked-output"),
  ], { encoding: "utf8" });
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /file-invalid/u);

  const repositoryAuthorization = new URL("../security/temporary-authorization.json", import.meta.url);
  writeFileSync(repositoryAuthorization, `${JSON.stringify(authorization())}\n`, { mode: 0o600 });
  try {
    const inside = spawnSync(process.execPath, [
      new URL("../scripts/security-exercise.mjs", import.meta.url).pathname,
      "plan", "--authorization", repositoryAuthorization.pathname, "--output", join(parent, "other"),
    ], { encoding: "utf8" });
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /authorization-location/u);
  } finally {
    rmSync(repositoryAuthorization);
  }
});
