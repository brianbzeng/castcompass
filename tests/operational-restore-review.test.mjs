import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runOfflineOperationalRestoreDrill } from "../scripts/run-operational-restore-drill.mjs";
import {
  evaluateOperationalRestoreReview,
  loadOperationalRestoreReviewPolicy,
  validateOperationalRestoreReviewPolicy,
  verifyOperationalRestoreIndependentReview,
  verifyOperationalRestoreReviewContract,
} from "../scripts/verify-operational-restore-review.mjs";

const SOURCE_COMMIT = "c".repeat(40);
const DRILL_COMPLETED_AT = "2026-07-18T06:24:47.211Z";
const REVIEWED_AT = "2026-07-18T07:24:47.211Z";
const NOW = new Date("2026-07-18T08:24:47.211Z");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function privateWrite(path, source) {
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "castingcompass-restore-review-test-"));
  chmodSync(parent, 0o700);
  const packetDirectory = join(parent, "packet");
  await runOfflineOperationalRestoreDrill({
    outputDirectory: packetDirectory,
    sourceCommit: SOURCE_COMMIT,
    completedAt: DRILL_COMPLETED_AT,
    checkoutVerifier: async ({ expectedCommit }) => ({
      head: expectedCommit,
      expectedCommit,
      clean: true,
    }),
  });
  const acceptanceSource = readFileSync(join(packetDirectory, "acceptance-record.json"), "utf8");
  const evidenceSource = readFileSync(join(packetDirectory, "operational-restore-evidence.json"), "utf8");
  const auditSource = readFileSync(join(packetDirectory, "storage-audit.ndjson"), "utf8");
  const review = {
    schema_version: "castingcompass.operational-restore-independent-review/1.0.0",
    review_id: "123e4567-e89b-42d3-a456-426614174000",
    packet_source_commit: SOURCE_COMMIT,
    packet_acceptance_sha256: sha256(acceptanceSource),
    packet_restore_evidence_sha256: sha256(evidenceSource),
    packet_storage_audit_sha256: sha256(auditSource),
    reviewed_at: REVIEWED_AT,
    reviewer_role: "independent_reviewer",
    reviewer_was_not_drill_operator: true,
    review_checklist: {
      acceptance_boundaries_understood: true,
      aggregate_only_evidence_confirmed: true,
      no_production_authority_granted: true,
      packet_integrity_confirmed: true,
      source_binding_confirmed: true,
    },
    review_evidence_sha256: "9".repeat(64),
  };
  const reviewFile = join(parent, "independent-review.json");
  privateWrite(reviewFile, stableJson(review));
  return {
    parent,
    packetDirectory,
    reviewFile,
    review,
    sources: { acceptanceSource, evidenceSource, auditSource },
  };
}

test("the locked review policy and private-record contract are exact", async () => {
  const policy = await loadOperationalRestoreReviewPolicy();
  await verifyOperationalRestoreReviewContract();
  assert.equal(policy.packet_scope, "synthetic-production-shaped-non-production");
  assert.deepEqual(policy.required_packet_files, [
    "acceptance-record.json",
    "operational-restore-evidence.json",
    "storage-audit.ndjson",
  ]);
  assert.deepEqual(policy.remaining_approvals_after_review, [
    "production-key-custody-policy",
    "provider-and-production-release-evidence",
    "validation-snapshot-governance",
  ]);
  const weakened = structuredClone(policy);
  weakened.limits.maximum_review_delay_hours = 8760;
  assert.throws(() => validateOperationalRestoreReviewPolicy(weakened), /locked reviewed policy/u);
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const release = readFileSync(
    new URL("../.github/workflows/release-provenance.yml", import.meta.url),
    "utf8",
  );
  assert.match(manifest, /"security:operational-restore-review": "node scripts\/verify-operational-restore-review\.mjs verify-policy"/u);
  assert.match(manifest, /"verify:operational-restore-review": "node scripts\/verify-operational-restore-review\.mjs evaluate/u);
  assert.match(ci, /npm run security:production-change-policy\n\s+- run: npm run security:operational-restore-review/u);
  assert.match(release, /npm run security:production-change-policy\n\s+- run: npm run security:operational-restore-review/u);
});

test("a source-bound second-person record yields only a minimized non-authorizing receipt", async () => {
  const value = await fixture();
  try {
    const receipt = await verifyOperationalRestoreIndependentReview({
      packetDirectory: value.packetDirectory,
      reviewFile: value.reviewFile,
      expectedSourceCommit: SOURCE_COMMIT,
      now: NOW,
    });
    assert.deepEqual(receipt, {
      schema_version: "castingcompass.operational-restore-independent-review-receipt/1.0.0",
      packet_scope: "synthetic-production-shaped-non-production",
      source_commit: SOURCE_COMMIT,
      packet_acceptance_sha256: sha256(value.sources.acceptanceSource),
      reviewed_at: REVIEWED_AT,
      reviewer_role: "independent_reviewer",
      independent_review_record_accepted: true,
      separation_attested: true,
      verified_acceptance_checks: [
        "aggregate_only_evidence",
        "completed_object_task_preserved",
        "current_deletion_ledger_replayed",
        "deleted_account_suppressed",
        "deleted_public_discussion_suppressed",
        "deleted_trip_suppressed",
        "encrypted_fixture_artifacts_destroyed",
        "foreign_key_check_passed",
        "operational_restore_passed",
        "pending_object_task_preserved",
        "plaintext_sources_destroyed",
        "restored_database_destroyed",
        "source_checkout_verified_clean",
        "sqlite_integrity_passed",
        "tampered_artifact_rejected",
        "temporary_keys_destroyed",
        "wrong_key_rejected",
      ],
      verified_review_checks: [
        "acceptance_boundaries_understood",
        "aggregate_only_evidence_confirmed",
        "no_production_authority_granted",
        "packet_integrity_confirmed",
        "source_binding_confirmed",
      ],
      production_key_custody_approved: false,
      production_provider_evidence_verified: false,
      production_restore_gate_passed: false,
      production_release_authorized: false,
      remaining_approvals: [
        "production-key-custody-policy",
        "provider-and-production-release-evidence",
        "validation-snapshot-governance",
      ],
    });
    const serialized = JSON.stringify(receipt);
    for (const prohibited of [
      "review_id", "review_evidence_sha256", "activation_id", "storage_audit_sha256",
      "audit_head_sha256", "runtime", "platform", "architecture",
    ]) assert.doesNotMatch(serialized, new RegExp(prohibited, "u"));
  } finally {
    rmSync(value.parent, { recursive: true, force: true });
  }
});

test("packet, evidence, audit, review, chronology, and source mutations fail closed", async () => {
  const value = await fixture();
  const policy = await loadOperationalRestoreReviewPolicy();
  const base = {
    ...value.sources,
    reviewSource: stableJson(value.review),
  };
  const evaluate = (sources = base, options = {}) => evaluateOperationalRestoreReview(
    sources,
    policy,
    { expectedSourceCommit: SOURCE_COMMIT, now: NOW, ...options },
  );
  try {
    assert.throws(() => evaluate(base, { expectedSourceCommit: "d".repeat(40) }),
      /expected source commit/u);

    const unchecked = JSON.parse(base.acceptanceSource);
    unchecked.acceptance_checks.current_deletion_ledger_replayed = false;
    assert.throws(() => evaluate({ ...base, acceptanceSource: `${JSON.stringify(unchecked)}\n` }),
      /current_deletion_ledger_replayed must be true/u);

    const widened = JSON.parse(base.acceptanceSource);
    widened.boundaries.production_restore_gate_passed = true;
    assert.throws(() => evaluate({ ...base, acceptanceSource: `${JSON.stringify(widened)}\n` }),
      /production_restore_gate_passed must be false/u);

    const privateField = JSON.parse(base.evidenceSource);
    privateField.account_id = "acct_private";
    assert.throws(() => evaluate({
      ...base,
      evidenceSource: `${canonicalJson(privateField)}\n`,
    }), /fields are invalid|prohibited field/u);

    const alteredEvidence = JSON.parse(base.evidenceSource);
    alteredEvidence.suppressed_trip_count = 2;
    assert.throws(() => evaluate({
      ...base,
      evidenceSource: `${canonicalJson(alteredEvidence)}\n`,
    }), /suppressed_trip_count is invalid|file digests/u);

    const alteredAudit = JSON.parse(base.auditSource.split("\n")[0]);
    alteredAudit.operator_role = "operator";
    const auditLines = base.auditSource.trimEnd().split("\n");
    auditLines[0] = canonicalJson(alteredAudit);
    assert.throws(() => evaluate({ ...base, auditSource: `${auditLines.join("\n")}\n` }),
      /event 1 contract|file digests/u);

    const noSeparation = structuredClone(value.review);
    noSeparation.reviewer_was_not_drill_operator = false;
    assert.throws(() => evaluate({ ...base, reviewSource: stableJson(noSeparation) }),
      /separation attestation/u);

    const uncheckedReview = structuredClone(value.review);
    uncheckedReview.review_checklist.no_production_authority_granted = false;
    assert.throws(() => evaluate({ ...base, reviewSource: stableJson(uncheckedReview) }),
      /no_production_authority_granted must be true/u);

    const reusedDigest = structuredClone(value.review);
    reusedDigest.review_evidence_sha256 = reusedDigest.packet_acceptance_sha256;
    assert.throws(() => evaluate({ ...base, reviewSource: stableJson(reusedDigest) }),
      /distinct from every packet digest/u);

    const reusedNestedDigest = structuredClone(value.review);
    reusedNestedDigest.review_evidence_sha256 = JSON.parse(
      base.evidenceSource,
    ).snapshot_encrypted_sha256;
    assert.throws(() => evaluate({ ...base, reviewSource: stableJson(reusedNestedDigest) }),
      /distinct from every packet digest/u);

    const reusedAuditEventDigest = structuredClone(value.review);
    reusedAuditEventDigest.review_evidence_sha256 = JSON.parse(
      base.auditSource.split("\n")[0],
    ).event_sha256;
    assert.throws(() => evaluate({ ...base, reviewSource: stableJson(reusedAuditEventDigest) }),
      /distinct from every packet digest/u);

    const staleReview = structuredClone(value.review);
    staleReview.reviewed_at = "2026-07-26T06:24:47.212Z";
    assert.throws(() => evaluate({ ...base, reviewSource: stableJson(staleReview) }, {
      now: new Date("2026-07-26T06:24:47.212Z"),
    }), /outside the accepted window/u);

    const duplicate = base.reviewSource.replace(
      '  "review_id":',
      '  "schema_version": "castingcompass.operational-restore-independent-review/1.0.0",\n  "review_id":',
    );
    assert.throws(() => evaluate({ ...base, reviewSource: duplicate }), /canonical JSON/u);
  } finally {
    rmSync(value.parent, { recursive: true, force: true });
  }
});

test("private packet and review filesystem boundaries reject exposure and path tricks", async () => {
  const value = await fixture();
  try {
    chmodSync(value.reviewFile, 0o644);
    await assert.rejects(verifyOperationalRestoreIndependentReview({
      packetDirectory: value.packetDirectory,
      reviewFile: value.reviewFile,
      expectedSourceCommit: SOURCE_COMMIT,
      now: NOW,
    }), /permissions|ownership/u);
    chmodSync(value.reviewFile, 0o600);

    const symlink = join(value.parent, "review-link.json");
    symlinkSync(value.reviewFile, symlink);
    await assert.rejects(verifyOperationalRestoreIndependentReview({
      packetDirectory: value.packetDirectory,
      reviewFile: symlink,
      expectedSourceCommit: SOURCE_COMMIT,
      now: NOW,
    }), /symbolic link/u);

    const hardLink = join(value.parent, "review-hard-link.json");
    linkSync(value.reviewFile, hardLink);
    await assert.rejects(verifyOperationalRestoreIndependentReview({
      packetDirectory: value.packetDirectory,
      reviewFile: hardLink,
      expectedSourceCommit: SOURCE_COMMIT,
      now: NOW,
    }), /link count/u);
    rmSync(hardLink);

    privateWrite(join(value.packetDirectory, "unexpected.json"), "{}\n");
    await assert.rejects(verifyOperationalRestoreIndependentReview({
      packetDirectory: value.packetDirectory,
      reviewFile: value.reviewFile,
      expectedSourceCommit: SOURCE_COMMIT,
      now: NOW,
    }), /exactly the three reviewed files/u);
  } finally {
    rmSync(value.parent, { recursive: true, force: true });
  }
});
