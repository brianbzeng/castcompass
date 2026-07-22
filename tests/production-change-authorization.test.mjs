import assert from "node:assert/strict";
import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  loadProductionChangePolicy,
  validateProductionChangeAuthorization,
  validateProductionChangePolicy,
  verifyProductionChangeAuthorization,
} from "../scripts/verify-production-change-authorization.mjs";

const ROOT = resolve(new URL("../", import.meta.url).pathname);
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NOW = "2026-07-19T16:00:00.000Z";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function authorization(policy, action = "deploy:normal", overrides = {}) {
  const releaseCommit = action === "deploy:safety-floor"
    ? policy.actions[action].fixed_release_commit
    : HEAD;
  const value = {
    schema_version: policy.authorization_schema_version,
    authorization_id: "123e4567-e89b-42d3-a456-426614174000",
    repository: policy.repository,
    environment: policy.environment,
    worker: policy.worker,
    database: policy.database,
    release_commit: releaseCommit,
    gate_commit: HEAD,
    action,
    issued_at: "2026-07-19T15:30:00.000Z",
    expires_at: "2026-07-19T17:30:00.000Z",
    approvals: policy.required_approval_roles.map((role, index) => ({
      role,
      approved_at: `2026-07-19T15:${index === 0 ? "35" : "40"}:00.000Z`,
      evidence_sha256: String(index + 1).repeat(64),
    })),
    evidence: Object.fromEntries(
      policy.actions[action].required_evidence.map((name, index) => [
        name,
        (index + 10).toString(16).padStart(64, "0"),
      ]),
    ),
  };
  return Object.assign(value, overrides);
}

async function privateFile(directory, value, name = "authorization.json") {
  const path = join(directory, name);
  await writeFile(path, typeof value === "string" ? value : stableJson(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

test("locked production change policy is canonical and covers every release phase", async () => {
  const policy = await loadProductionChangePolicy(ROOT);
  assert.deepEqual(policy.required_approval_roles, ["operator", "independent_reviewer"]);
  assert.equal(policy.max_authorization_seconds, 21600);
  assert.deepEqual(Object.keys(policy.actions), [
    "deploy:safety-floor",
    "migrate:reconcile-0007",
    "migrate:0009_human_discussion_approval.sql",
    "migrate:0010_privacy_durability.sql",
    "deploy:maintenance",
    "migrate:0011_species_aware_observations.sql",
    "migrate:0012_validation_protocol.sql",
    "migrate:0013_validation_feasibility_pilot.sql",
    "migrate:0014_validation_feasibility_recruitment_and_corrections.sql",
    "migrate:0015_validation_snapshot_suppression.sql",
    "migrate:0016_data_resilience_indexes.sql",
    "migrate:0017_trip_idempotency.sql",
    "migrate:0018_ai_review_queue.sql",
    "migrate:0019_async_privacy_exports.sql",
    "migrate:0020_trip_photo_upload_reservations.sql",
    "deploy:normal",
  ]);
  const weakened = structuredClone(policy);
  weakened.actions["deploy:normal"].required_evidence.pop();
  assert.throws(() => validateProductionChangePolicy(weakened), /locked reviewed policy/);
});

test("valid private authorization binds one exact action and returns only a redacted receipt", async () => {
  const policy = await loadProductionChangePolicy(ROOT);
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-production-auth-"));
  try {
    const value = authorization(policy);
    const path = await privateFile(directory, value);
    let checkoutCalls = 0;
    const receipt = await verifyProductionChangeAuthorization({
      root: ROOT,
      expectedCommit: HEAD,
      authorizationFile: path,
      action: "deploy:normal",
      now: new Date(NOW),
      checkoutVerifier: async ({ root, expectedCommit }) => {
        checkoutCalls += 1;
        assert.equal(root, ROOT);
        assert.equal(expectedCommit, HEAD);
      },
    });
    assert.equal(checkoutCalls, 1);
    assert.deepEqual(Object.keys(receipt), [
      "schema_version",
      "authorized",
      "action",
      "release_commit",
      "gate_commit",
      "expires_at",
      "approval_roles",
      "evidence_names",
      "authorization_sha256",
    ]);
    assert.equal(receipt.authorized, true);
    assert.equal(receipt.action, "deploy:normal");
    assert.match(receipt.authorization_sha256, /^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /authorization_id|evidence_sha256|123e4567|000000000000000a/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authorization rejects wrong identity, action, commit, safety floor, and time windows", async () => {
  const policy = await loadProductionChangePolicy(ROOT);
  const baseOptions = { policy, action: "deploy:normal", expectedCommit: HEAD, now: new Date(NOW) };
  for (const [label, candidate, pattern] of [
    ["repository", authorization(policy, "deploy:normal", { repository: "owner/fork" }), /repository is invalid/],
    ["environment", authorization(policy, "deploy:normal", { environment: "staging" }), /environment is invalid/],
    ["commit", authorization(policy, "deploy:normal", { release_commit: "f".repeat(40) }), /bind the exact/],
    ["gate", authorization(policy, "deploy:normal", { gate_commit: "f".repeat(40) }), /gate commit/],
    ["action", authorization(policy, "deploy:normal", { action: "deploy:maintenance" }), /action is invalid/],
    ["future", authorization(policy, "deploy:normal", { issued_at: "2026-07-19T16:02:00.000Z" }), /issued in the future/],
    ["expired", authorization(policy, "deploy:normal", { expires_at: NOW }), /has expired/],
    ["long", authorization(policy, "deploy:normal", { expires_at: "2026-07-20T00:00:00.000Z" }), /window is invalid/],
  ]) {
    assert.throws(
      () => validateProductionChangeAuthorization(candidate, baseOptions),
      pattern,
      label,
    );
  }
  assert.throws(
    () => validateProductionChangeAuthorization(authorization(policy, "deploy:safety-floor", {
      release_commit: HEAD,
    }), {
      policy,
      action: "deploy:safety-floor",
      expectedCommit: HEAD,
      now: new Date(NOW),
    }),
    /fixed safety-floor commit/,
  );
});

test("historical safety release binds both target and current gate checkouts", async () => {
  const policy = await loadProductionChangePolicy(ROOT);
  const target = await mkdtemp(join(tmpdir(), "castingcompass-safety-target-"));
  const privateDirectory = await mkdtemp(join(tmpdir(), "castingcompass-safety-auth-"));
  try {
    const value = authorization(policy, "deploy:safety-floor");
    const path = await privateFile(privateDirectory, value);
    const calls = [];
    const receipt = await verifyProductionChangeAuthorization({
      root: target,
      policyRoot: ROOT,
      expectedCommit: policy.actions["deploy:safety-floor"].fixed_release_commit,
      expectedGateCommit: HEAD,
      authorizationFile: path,
      action: "deploy:safety-floor",
      now: new Date(NOW),
      checkoutVerifier: async (options) => { calls.push(options); },
    });
    assert.deepEqual(calls, [
      {
        root: await realpath(target),
        expectedCommit: policy.actions["deploy:safety-floor"].fixed_release_commit,
      },
      { root: ROOT, expectedCommit: HEAD },
    ]);
    assert.equal(receipt.release_commit, policy.actions["deploy:safety-floor"].fixed_release_commit);
    assert.equal(receipt.gate_commit, HEAD);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(privateDirectory, { recursive: true, force: true });
  }
});

test("authorization rejects missing, reordered, duplicate, or malformed approvals and evidence", async () => {
  const policy = await loadProductionChangePolicy(ROOT);
  const options = { policy, action: "deploy:normal", expectedCommit: HEAD, now: new Date(NOW) };

  const missingApproval = authorization(policy);
  missingApproval.approvals.pop();
  assert.throws(() => validateProductionChangeAuthorization(missingApproval, options), /approvals are incomplete/);

  const reordered = authorization(policy);
  reordered.approvals.reverse();
  assert.throws(() => validateProductionChangeAuthorization(reordered, options), /approval roles is invalid/);

  const malformedApproval = authorization(policy);
  malformedApproval.approvals[0].evidence_sha256 = "not-a-hash";
  assert.throws(() => validateProductionChangeAuthorization(malformedApproval, options), /approval evidence hash/);

  const repeatedApproval = authorization(policy);
  repeatedApproval.approvals[1].evidence_sha256 = repeatedApproval.approvals[0].evidence_sha256;
  assert.throws(() => validateProductionChangeAuthorization(repeatedApproval, options), /distinct evidence hashes/);

  const missingEvidence = authorization(policy);
  delete missingEvidence.evidence[Object.keys(missingEvidence.evidence)[0]];
  assert.throws(() => validateProductionChangeAuthorization(missingEvidence, options), /evidence fields/);

  const extraEvidence = authorization(policy);
  extraEvidence.evidence.unreviewed_override = "f".repeat(64);
  assert.throws(() => validateProductionChangeAuthorization(extraEvidence, options), /evidence fields/);

  const repeatedEvidence = authorization(policy);
  const evidenceNames = Object.keys(repeatedEvidence.evidence);
  repeatedEvidence.evidence[evidenceNames[1]] = repeatedEvidence.evidence[evidenceNames[0]];
  assert.throws(() => validateProductionChangeAuthorization(repeatedEvidence, options), /evidence items must bind distinct/);

  const approvalAsPhaseEvidence = authorization(policy);
  approvalAsPhaseEvidence.evidence[evidenceNames[0]] = approvalAsPhaseEvidence.approvals[0].evidence_sha256;
  assert.throws(() => validateProductionChangeAuthorization(approvalAsPhaseEvidence, options), /must use separate hashes/);
});

test("authorization file boundary rejects repository files, symlinks, broad modes, and noncanonical JSON", async () => {
  const policy = await loadProductionChangePolicy(ROOT);
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-production-auth-boundary-"));
  const checkoutVerifier = async () => {};
  const verify = (authorizationFile) => verifyProductionChangeAuthorization({
    root: ROOT,
    expectedCommit: HEAD,
    authorizationFile,
    action: "deploy:normal",
    now: new Date(NOW),
    checkoutVerifier,
  });
  let repositoryFile;
  try {
    const validPath = await privateFile(directory, authorization(policy));
    await chmod(validPath, 0o644);
    await assert.rejects(verify(validPath), /inaccessible to group\/other/);
    await chmod(validPath, 0o600);

    const symlinkPath = join(directory, "authorization-link.json");
    await symlink(validPath, symlinkPath);
    await assert.rejects(verify(symlinkPath), /cannot be a symbolic link/);

    const hardlinkPath = join(directory, "authorization-hardlink.json");
    await link(validPath, hardlinkPath);
    await assert.rejects(verify(hardlinkPath), /cannot use hard links/);

    const duplicateJson = stableJson(authorization(policy)).replace(
      '  "repository": "brianbzeng/castingcompass",',
      '  "repository": "owner/fork",\n  "repository": "brianbzeng/castingcompass",',
    );
    const duplicatePath = await privateFile(directory, duplicateJson, "duplicate.json");
    await assert.rejects(verify(duplicatePath), /canonical JSON without duplicate keys/);

    repositoryFile = resolve(ROOT, ".production-authorization-test.json");
    await writeFile(repositoryFile, stableJson(authorization(policy)), { mode: 0o600 });
    await chmod(repositoryFile, 0o600);
    await assert.rejects(verify(repositoryFile), /outside every release repository/);
    await assert.rejects(verify("relative-authorization.json"), /absolute path/);
  } finally {
    if (repositoryFile) await rm(repositoryFile, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
