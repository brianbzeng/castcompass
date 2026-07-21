#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyReleaseCheckout } from "./verify-release-checkout.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = "security/production-change-authorization-policy.json";
const LOCKED_POLICY_SHA256 = "6e2a405435d519bc4d47d3078e9a142883e112dc7cf383d676780cd489141f57";
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const CLOCK_SKEW_MS = 60 * 1000;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EVIDENCE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const EXPECTED_ACTIONS = Object.freeze([
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
  "deploy:normal",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields or field order are invalid.`);
  }
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseTimestamp(value, label) {
  if (!TIMESTAMP_PATTERN.test(value ?? "")) {
    throw new Error(`${label} must be an exact UTC timestamp with milliseconds.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is not a valid UTC timestamp.`);
  }
  return milliseconds;
}

function assertOutsideRepositories(repositoryRoots, authorizationPath) {
  for (const repositoryRoot of repositoryRoots) {
    const pathFromRepository = relative(repositoryRoot, authorizationPath);
    const outside = pathFromRepository === ".."
      || pathFromRepository.startsWith(`..${sep}`)
      || isAbsolute(pathFromRepository);
    if (!outside) {
      throw new Error("Production authorization must be stored outside every release repository.");
    }
  }
}

export function validateProductionChangePolicy(policy, source = stableJson(policy)) {
  exactKeys(policy, [
    "schema_version",
    "authorization_schema_version",
    "receipt_schema_version",
    "repository",
    "environment",
    "worker",
    "database",
    "max_authorization_seconds",
    "required_approval_roles",
    "actions",
  ], "Production change policy");
  if (source !== stableJson(policy)) {
    throw new Error("Production change policy must use canonical JSON without duplicate keys.");
  }
  if (sha256(source) !== LOCKED_POLICY_SHA256) {
    throw new Error("Production change policy does not match the locked reviewed policy.");
  }
  if (policy.schema_version !== "castingcompass.production-change-policy/1.0.0"
    || policy.authorization_schema_version !== "castingcompass.production-change-authorization/1.0.0"
    || policy.receipt_schema_version !== "castingcompass.production-change-authorization-receipt/1.0.0") {
    throw new Error("Production change policy schema versions are invalid.");
  }
  if (policy.repository !== "brianbzeng/castingcompass"
    || policy.environment !== "production"
    || policy.worker !== "contourcast-halibut"
    || policy.database !== "contourcast-trips") {
    throw new Error("Production change policy resource identity is invalid.");
  }
  if (policy.max_authorization_seconds !== 21600) {
    throw new Error("Production change authorization window is invalid.");
  }
  exactArray(policy.required_approval_roles, ["operator", "independent_reviewer"],
    "Required production approval roles");
  exactKeys(policy.actions, EXPECTED_ACTIONS, "Production change actions");
  for (const [action, contract] of Object.entries(policy.actions)) {
    exactKeys(contract, ["fixed_release_commit", "required_evidence"], `${action} policy`);
    if (action === "deploy:safety-floor") {
      if (contract.fixed_release_commit !== "e2c612246fadfdb231e481c405fa72e502458ed1") {
        throw new Error("Safety-floor release commit is invalid.");
      }
    } else if (contract.fixed_release_commit !== null) {
      throw new Error(`${action} cannot pin an unexpected release commit.`);
    }
    if (!Array.isArray(contract.required_evidence) || contract.required_evidence.length === 0) {
      throw new Error(`${action} must require evidence.`);
    }
    const sorted = [...contract.required_evidence].sort();
    if (JSON.stringify(contract.required_evidence) !== JSON.stringify(sorted)
      || new Set(contract.required_evidence).size !== contract.required_evidence.length
      || contract.required_evidence.some((name) => !EVIDENCE_NAME_PATTERN.test(name))) {
      throw new Error(`${action} evidence names must be unique, sorted, and canonical.`);
    }
  }
  return policy;
}

export async function loadProductionChangePolicy(root = DEFAULT_ROOT) {
  const source = await readFile(resolve(root, POLICY_PATH), "utf8");
  let policy;
  try {
    policy = JSON.parse(source);
  } catch {
    throw new Error("Production change policy is not valid JSON.");
  }
  return validateProductionChangePolicy(policy, source);
}

async function readPrivateAuthorization(repositoryRoots, authorizationFile) {
  if (!isAbsolute(authorizationFile ?? "")) {
    throw new Error("--authorization-file must be an absolute path outside the repository.");
  }
  const requestedPath = resolve(authorizationFile);
  const symbolicMetadata = await lstat(requestedPath).catch(() => null);
  if (!symbolicMetadata) throw new Error("Production authorization file does not exist.");
  if (symbolicMetadata.isSymbolicLink()) {
    throw new Error("Production authorization file cannot be a symbolic link.");
  }
  const authorizationPathBeforeOpen = await realpath(requestedPath);
  assertOutsideRepositories(repositoryRoots, authorizationPathBeforeOpen);

  let handle;
  try {
    handle = await open(requestedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("Production authorization file could not be opened safely.");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Production authorization must be a regular file.");
    if (metadata.dev !== symbolicMetadata.dev || metadata.ino !== symbolicMetadata.ino) {
      throw new Error("Production authorization file changed while it was being opened.");
    }
    if (metadata.nlink !== 1) {
      throw new Error("Production authorization file cannot use hard links.");
    }
    if (metadata.size < 2 || metadata.size > MAX_AUTHORIZATION_BYTES) {
      throw new Error("Production authorization file size is invalid.");
    }
    if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0) {
      throw new Error("Production authorization file must be owner-readable and inaccessible to group/other users.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Production authorization file must be owned by the current operator.");
    }
    const source = await handle.readFile({ encoding: "utf8" });
    const pathMetadataAfterRead = await lstat(requestedPath).catch(() => null);
    if (!pathMetadataAfterRead || pathMetadataAfterRead.isSymbolicLink()
      || pathMetadataAfterRead.dev !== metadata.dev || pathMetadataAfterRead.ino !== metadata.ino) {
      throw new Error("Production authorization file changed while it was being read.");
    }
    const authorizationPathAfterOpen = await realpath(requestedPath);
    if (authorizationPathAfterOpen !== authorizationPathBeforeOpen) {
      throw new Error("Production authorization file changed while it was being opened.");
    }
    return { source, path: authorizationPathBeforeOpen };
  } finally {
    await handle.close();
  }
}

export function validateProductionChangeAuthorization(
  authorization,
  { policy, action, expectedCommit, expectedGateCommit = expectedCommit, now = new Date() },
) {
  exactKeys(authorization, [
    "schema_version",
    "authorization_id",
    "repository",
    "environment",
    "worker",
    "database",
    "release_commit",
    "gate_commit",
    "action",
    "issued_at",
    "expires_at",
    "approvals",
    "evidence",
  ], "Production authorization");
  if (authorization.schema_version !== policy.authorization_schema_version) {
    throw new Error("Production authorization schema version is invalid.");
  }
  if (!UUID_V4_PATTERN.test(authorization.authorization_id ?? "")) {
    throw new Error("Production authorization ID must be a lowercase UUIDv4.");
  }
  for (const [field, expected] of [
    ["repository", policy.repository],
    ["environment", policy.environment],
    ["worker", policy.worker],
    ["database", policy.database],
  ]) {
    if (authorization[field] !== expected) {
      throw new Error(`Production authorization ${field} is invalid.`);
    }
  }
  if (!COMMIT_PATTERN.test(expectedCommit ?? "") || authorization.release_commit !== expectedCommit) {
    throw new Error("Production authorization must bind the exact full lowercase release commit.");
  }
  if (!COMMIT_PATTERN.test(expectedGateCommit ?? "") || authorization.gate_commit !== expectedGateCommit) {
    throw new Error("Production authorization must bind the exact full lowercase gate commit.");
  }
  const actionPolicy = policy.actions[action];
  if (!actionPolicy || authorization.action !== action) {
    throw new Error("Production authorization action is invalid.");
  }
  if (actionPolicy.fixed_release_commit && authorization.release_commit !== actionPolicy.fixed_release_commit) {
    throw new Error("Production authorization does not bind the fixed safety-floor commit.");
  }

  const nowMilliseconds = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMilliseconds)) throw new Error("Authorization verification time is invalid.");
  const issuedAt = parseTimestamp(authorization.issued_at, "Production authorization issued_at");
  const expiresAt = parseTimestamp(authorization.expires_at, "Production authorization expires_at");
  if (issuedAt > nowMilliseconds + CLOCK_SKEW_MS) {
    throw new Error("Production authorization was issued in the future.");
  }
  if (expiresAt <= nowMilliseconds) throw new Error("Production authorization has expired.");
  if (expiresAt <= issuedAt
    || expiresAt - issuedAt > policy.max_authorization_seconds * 1000) {
    throw new Error("Production authorization window is invalid.");
  }

  if (!Array.isArray(authorization.approvals)
    || authorization.approvals.length !== policy.required_approval_roles.length) {
    throw new Error("Production authorization approvals are incomplete.");
  }
  const approvalRoles = [];
  const approvalEvidenceHashes = [];
  for (const approval of authorization.approvals) {
    exactKeys(approval, ["role", "approved_at", "evidence_sha256"], "Production approval");
    approvalRoles.push(approval.role);
    approvalEvidenceHashes.push(approval.evidence_sha256);
    if (!SHA256_PATTERN.test(approval.evidence_sha256 ?? "")) {
      throw new Error("Production approval evidence hash is invalid.");
    }
    const approvedAt = parseTimestamp(approval.approved_at, `${approval.role} approved_at`);
    if (approvedAt < issuedAt || approvedAt > nowMilliseconds + CLOCK_SKEW_MS || approvedAt >= expiresAt) {
      throw new Error("Production approval timestamp is outside the authorization window.");
    }
  }
  exactArray(approvalRoles, policy.required_approval_roles, "Production approval roles");
  if (new Set(approvalEvidenceHashes).size !== approvalEvidenceHashes.length) {
    throw new Error("Production approvals must bind distinct evidence hashes.");
  }

  exactKeys(authorization.evidence, actionPolicy.required_evidence, "Production authorization evidence");
  for (const [name, digest] of Object.entries(authorization.evidence)) {
    if (!EVIDENCE_NAME_PATTERN.test(name) || !SHA256_PATTERN.test(digest ?? "")) {
      throw new Error("Production authorization evidence hashes are invalid.");
    }
  }
  if (new Set(Object.values(authorization.evidence)).size !== actionPolicy.required_evidence.length) {
    throw new Error("Production authorization evidence items must bind distinct hashes.");
  }
  if (new Set([...approvalEvidenceHashes, ...Object.values(authorization.evidence)]).size
    !== approvalEvidenceHashes.length + actionPolicy.required_evidence.length) {
    throw new Error("Production approval and phase evidence must use separate hashes.");
  }
  return {
    schema_version: policy.receipt_schema_version,
    authorized: true,
    action,
    release_commit: authorization.release_commit,
    gate_commit: authorization.gate_commit,
    expires_at: authorization.expires_at,
    approval_roles: [...approvalRoles],
    evidence_names: [...actionPolicy.required_evidence],
  };
}

export async function verifyProductionChangeAuthorization({
  root = DEFAULT_ROOT,
  policyRoot = DEFAULT_ROOT,
  expectedCommit,
  expectedGateCommit = expectedCommit,
  authorizationFile,
  action,
  now = new Date(),
  checkoutVerifier = verifyReleaseCheckout,
}) {
  const repositoryRoot = await realpath(resolve(root));
  const policyRepositoryRoot = await realpath(resolve(policyRoot));
  const policy = await loadProductionChangePolicy(policyRepositoryRoot);
  if (!policy.actions[action]) throw new Error("Requested production action is not allowlisted.");
  await checkoutVerifier({ root: repositoryRoot, expectedCommit });
  if (policyRepositoryRoot === repositoryRoot) {
    if (expectedGateCommit !== expectedCommit) {
      throw new Error("A single release checkout must use the same release and gate commit.");
    }
  } else {
    await checkoutVerifier({ root: policyRepositoryRoot, expectedCommit: expectedGateCommit });
  }
  const { source } = await readPrivateAuthorization(
    [...new Set([repositoryRoot, policyRepositoryRoot])],
    authorizationFile,
  );
  let authorization;
  try {
    authorization = JSON.parse(source);
  } catch {
    throw new Error("Production authorization is not valid JSON.");
  }
  if (source !== stableJson(authorization)) {
    throw new Error("Production authorization must use canonical JSON without duplicate keys.");
  }
  const receipt = validateProductionChangeAuthorization(authorization, {
    policy,
    action,
    expectedCommit,
    expectedGateCommit,
    now,
  });
  return { ...receipt, authorization_sha256: sha256(source) };
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const options = {
    command,
    root: DEFAULT_ROOT,
    expectedCommit: undefined,
    expectedGateCommit: undefined,
    authorizationFile: undefined,
    action: undefined,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--root", "--expected-commit", "--expected-gate-commit", "--authorization-file", "--action"].includes(value)) {
      const argument = rest[index + 1];
      if (!argument) throw new Error(`${value} requires a value.`);
      const field = {
        "--root": "root",
        "--expected-commit": "expectedCommit",
        "--expected-gate-commit": "expectedGateCommit",
        "--authorization-file": "authorizationFile",
        "--action": "action",
      }[value];
      options[field] = argument;
      index += 1;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.command) {
    process.stdout.write(
      "Usage:\n" +
      "  node scripts/verify-production-change-authorization.mjs verify-policy\n" +
      "  node scripts/verify-production-change-authorization.mjs verify --root . --expected-commit COMMIT --expected-gate-commit GATE_COMMIT --authorization-file /PRIVATE/PATH.json --action ACTION\n",
    );
    return;
  }
  if (options.command === "verify-policy") {
    await loadProductionChangePolicy(options.root);
    process.stdout.write("Production change authorization policy passed.\n");
    return;
  }
  if (options.command !== "verify") throw new Error(`Unknown command: ${options.command}`);
  const receipt = await verifyProductionChangeAuthorization(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
