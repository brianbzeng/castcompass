import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../", import.meta.url);
const protocolUrl = new URL(
  "validation/protocols/california-halibut-collection-feasibility-v2.json",
  root,
);
const protocolSchemaUrl = new URL(
  "contracts/validation-feasibility-pilot.schema.json",
  root,
);
const activationSchemaUrl = new URL(
  "contracts/validation-feasibility-activation.schema.json",
  root,
);
const siteCatalogUrl = new URL("public/data/sites.json", root);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function activationCommitmentPayload(activation) {
  return {
    schema_version: activation.schema_version,
    activation_id: activation.activation_id,
    protocol_id: activation.protocol_id,
    protocol_version: activation.protocol_version,
    protocol_sha256: activation.protocol_sha256,
    protocol_release_commit: activation.protocol_release_commit,
    created_at: activation.created_at,
    enrollment: activation.enrollment,
    release: activation.release,
    contracts: activation.contracts,
    site_catalog_sha256: activation.site_catalog_sha256,
    scoring_system: activation.scoring_system,
    governance: activation.governance,
    storage: activation.storage,
    status: activation.status,
  };
}

export function activationCommitmentSha256(activation) {
  return sha256(Buffer.from(canonicalJson(activationCommitmentPayload(activation)), "utf8"));
}

function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertSchema(validate, value, label) {
  assert.equal(validate(value), true, `${label}: ${JSON.stringify(validate.errors, null, 2)}`);
}

function assertNoPlaceholders(value, location = "$") {
  if (typeof value === "string") {
    assert.doesNotMatch(
      value,
      /\b(?:tbd|todo|fixme|placeholder|replace[_ -]?me|replace with)\b/i,
      location,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaceholders(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoPlaceholders(entry, `${location}.${key}`);
    }
  }
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  assert.equal(Number.isFinite(parsed), true, `${label} must be a valid timestamp`);
  return parsed;
}

export function verifyProtocolSemantics(protocol, siteCatalogBytes) {
  assertNoPlaceholders(protocol);
  assert.equal(protocol.status, "frozen-local-not-activated");
  assert.equal(protocol.supersedes_for_activation, "california-halibut-site-window-v1");
  assert.equal(protocol.population.curated_site_catalog_sha256, sha256(siteCatalogBytes));
  assert.equal(protocol.purpose_and_claim_boundary.candidate_performance_evaluation_allowed, false);
  assert.equal(protocol.purpose_and_claim_boundary.model_promotion_allowed, false);
  assert.equal(protocol.purpose_and_claim_boundary.pilot_rows_eligible_for_future_confirmatory_testing, false);
  assert.equal(protocol.activation.must_precede_first_eligible_row, true);
  assert.equal(protocol.activation.backdating_prohibited, true);
  assert.equal(protocol.activation.per_event_external_transparency_log_required, false);
  assert.equal(protocol.activation.independent_publication_service_required, false);
  assert.equal(protocol.population.complete_attempts_including_non_encounters_required, true);
  assert.equal(protocol.collection.all_started_attempts_reconciled, true);
  assert.equal(protocol.collection.cancellation_not_encoded_as_non_encounter, true);
  assert.equal(protocol.feasibility_endpoints.candidate_score_outcome_association_computed, false);
  assert.equal(protocol.confirmatory_handoff.pilot_rows_excluded, true);
  assert.equal(protocol.confirmatory_handoff.promotion_before_confirmatory_pass_allowed, false);
}

export function verifyActivationSemantics(
  activation,
  protocolBytes,
  protocol,
  siteCatalogBytes,
) {
  const start = timestamp(activation.enrollment.start_at, "enrollment.start_at");
  const end = timestamp(activation.enrollment.end_at, "enrollment.end_at");
  const durationDays = (end - start) / 86_400_000;
  assert.ok(
    durationDays >= protocol.activation.minimum_duration_days &&
      durationDays <= protocol.activation.maximum_duration_days,
    "enrollment duration must be within the frozen 90–365 day range",
  );

  const protocolDigest = sha256(protocolBytes);
  assert.equal(activation.protocol_id, protocol.protocol_id);
  assert.equal(activation.protocol_version, protocol.protocol_version);
  assert.equal(activation.protocol_sha256, protocolDigest);
  assert.equal(
    activation.preregistration.registered_artifact_sha256,
    activationCommitmentSha256(activation),
  );
  assert.equal(
    activation.preregistration.registered_artifact_download_sha256,
    activation.preregistration.registered_artifact_sha256,
  );
  assert.equal(activation.site_catalog_sha256, sha256(siteCatalogBytes));
  assert.equal(activation.release.release_commit, activation.protocol_release_commit);
  const registrationUrl = new URL(activation.preregistration.registration_url);
  assert.equal(registrationUrl.protocol, "https:");
  assert.equal(registrationUrl.hostname, "osf.io");

  const prerequisites = [
    [activation.preregistration.registered_at, "preregistration.registered_at"],
    [activation.preregistration.receipt_verified_at, "preregistration.receipt_verified_at"],
    [activation.created_at, "created_at"],
    [activation.release.deployed_at, "release.deployed_at"],
    [
      activation.release.runtime_capture_acceptance_passed_at,
      "release.runtime_capture_acceptance_passed_at",
    ],
    [activation.governance.data_steward_approval.approved_at, "data_steward_approval.approved_at"],
    [activation.governance.privacy_approval.approved_at, "privacy_approval.approved_at"],
    [activation.governance.legal_approval.approved_at, "legal_approval.approved_at"],
    [activation.storage.restore_tested_at, "storage.restore_tested_at"],
    [
      activation.storage.deletion_reconciliation_tested_at,
      "storage.deletion_reconciliation_tested_at",
    ],
  ];
  for (const [value, label] of prerequisites) {
    assert.ok(timestamp(value, label) < start, `${label} must precede enrollment.start_at`);
  }
  assert.ok(
    timestamp(activation.created_at, "created_at") <=
      timestamp(activation.preregistration.registered_at, "preregistration.registered_at"),
    "the activation commitment must be prepared before it is registered",
  );
  assert.ok(
    timestamp(activation.preregistration.registered_at, "preregistration.registered_at") <=
      timestamp(
        activation.preregistration.receipt_verified_at,
        "preregistration.receipt_verified_at",
      ),
    "receipt verification cannot precede registration",
  );
  assert.ok(
    timestamp(activation.release.deployed_at, "release.deployed_at") <=
      timestamp(
        activation.release.runtime_capture_acceptance_passed_at,
        "release.runtime_capture_acceptance_passed_at",
    ),
    "runtime acceptance cannot precede deployment",
  );
  assert.ok(
    timestamp(
      activation.release.runtime_capture_acceptance_passed_at,
      "release.runtime_capture_acceptance_passed_at",
    ) <= timestamp(activation.created_at, "created_at"),
    "the activation commitment cannot be prepared before runtime acceptance",
  );
}

export async function verifySuccessor({ activationPath } = {}) {
  const [protocolBytes, protocolSchema, activationSchema, siteCatalogBytes] = await Promise.all([
    readFile(protocolUrl),
    readFile(protocolSchemaUrl, "utf8").then(JSON.parse),
    readFile(activationSchemaUrl, "utf8").then(JSON.parse),
    readFile(siteCatalogUrl),
  ]);
  const protocol = JSON.parse(protocolBytes.toString("utf8"));
  assertSchema(compile(protocolSchema), protocol, "successor protocol schema");
  verifyProtocolSemantics(protocol, siteCatalogBytes);

  if (!activationPath) {
    return { protocolSha256: sha256(protocolBytes), activationVerified: false };
  }

  const activation = JSON.parse(await readFile(activationPath, "utf8"));
  assertSchema(compile(activationSchema), activation, "successor activation schema");
  verifyActivationSemantics(activation, protocolBytes, protocol, siteCatalogBytes);
  return { protocolSha256: sha256(protocolBytes), activationVerified: true };
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  assert.deepEqual(argv.slice(0, 1), ["--activation"]);
  assert.equal(argv.length, 2, "usage: verify-validation-successor.mjs [--activation PATH]");
  return { activationPath: argv[1] };
}

async function main() {
  const result = await verifySuccessor(parseArguments(process.argv.slice(2)));
  const state = result.activationVerified ? "activation verified" : "activation not supplied; remains closed";
  process.stdout.write(`Successor protocol verified: ${result.protocolSha256} (${state})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Successor protocol verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
