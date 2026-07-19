import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PRIVACY_RIGHTS_CASE_VERSION,
  PRIVACY_RIGHTS_DECISION_VERSION,
  PRIVACY_RIGHTS_DRILL_RECEIPT_VERSION,
  compileCaseValidator,
  evaluatePrivacyRightsCase,
  loadPrivacyRightsPolicy,
  policySha256,
  runSyntheticPrivacyRightsDrill,
  syntheticPrivacyRightsCase,
  validatePolicy,
} from "../scripts/privacy-rights-case.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const COMPLETED_AT = "2026-07-18T20:00:00.000Z";

function fixture() {
  return syntheticPrivacyRightsCase({ sourceCommit: SOURCE_COMMIT, completedAt: COMPLETED_AT });
}

test("the strict schema and locked policy accept the privacy-minimized synthetic case", () => {
  const policy = loadPrivacyRightsPolicy();
  const validate = compileCaseValidator();
  const value = fixture();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(value.schema_version, PRIVACY_RIGHTS_CASE_VERSION);
  assert.equal(
    policySha256(policy),
    "a87dee0cf45f35e9da35c4557ee0fff9040c02e0a333996383919b52c1592334",
  );
  assert.equal(policy.current_deletion_semantics.active_account_removal, "immediate-and-nonrecoverable");
  assert.equal(policy.current_deletion_semantics.recovery_window_authorized, false);
  assert.equal(policy.current_deletion_semantics.deletion_receipt_is_recovery_credential, false);
});

test("the schema rejects extra personal-data fields and ambiguous case fields", () => {
  const validate = compileCaseValidator();
  const withEmail = { ...fixture(), email: "fixture@example.invalid" };
  assert.equal(validate(withEmail), false);
  const nestedEscape = structuredClone(fixture());
  nestedEscape.delivery.unreviewed_note = "anything";
  assert.equal(validate(nestedEscape), false);
});

test("policy validation fails closed if immediate deletion or inventories are weakened", () => {
  const policy = loadPrivacyRightsPolicy();
  const recovery = structuredClone(policy);
  recovery.current_deletion_semantics.recovery_window_authorized = true;
  assert.throws(() => validatePolicy(recovery), /weakened/u);

  const missingSystem = structuredClone(policy);
  missingSystem.required_systems.pop();
  assert.throws(() => validatePolicy(missingSystem), /inventory/u);

  const inferredLaw = structuredClone(policy);
  inferredLaw.internal_service_level.law_applicability_must_not_be_inferred = false;
  assert.throws(() => validatePolicy(inferredLaw), /safeguards/u);
});

test("the evaluator closes the synthetic case locally but never authorizes production", () => {
  const decision = evaluatePrivacyRightsCase(fixture());
  assert.equal(decision.schema_version, PRIVACY_RIGHTS_DECISION_VERSION);
  assert.equal(decision.case_contract_valid, true);
  assert.equal(decision.semantic_evaluation_passed, true);
  assert.equal(decision.production_ready, false);
  assert.deepEqual(decision.gap_codes, []);
  assert.deepEqual(decision.production_blockers, [
    "production-gate:independent_review_accepted",
    "production-gate:privacy_counsel_approval",
    "production-gate:processor_retention_review",
    "production-gate:production_shaped_drill_witnessed",
    "production-gate:provider_case_system_activated",
  ]);
  assert.equal(Object.hasOwn(decision, "case_id"), false);
});

test("an applicable legal clock cannot be selected without recorded legal review", () => {
  const value = fixture();
  value.applied_clock = "california-know-delete-correct";
  const decision = evaluatePrivacyRightsCase(value);
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("applied-clock-without-legal-review"));
});

test("reviewed California reference clocks detect a late acknowledgement", () => {
  const value = fixture();
  value.applied_clock = "california-know-delete-correct";
  value.review.legal_clock_review_completed = true;
  value.received_at = "2026-07-01T20:00:00.000Z";
  value.acknowledged_at = "2026-07-17T20:00:00.000Z";
  const decision = evaluatePrivacyRightsCase(value);
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("reviewed-acknowledgement-clock-missed"));
});

test("access or portability must be delivered before irreversible erasure", () => {
  const value = fixture();
  value.delivery.delivered_at = "2026-07-18T19:55:00.000Z";
  value.disposition.deletion_completed_at = "2026-07-18T19:50:00.000Z";
  const decision = evaluatePrivacyRightsCase(value);
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("export-not-delivered-before-erasure"));
});

test("schema-valid but non-canonical timestamps fail the semantic boundary", () => {
  const value = fixture();
  value.received_at = "2026-07-18T19:20:00Z";
  const decision = evaluatePrivacyRightsCase(value);
  assert.equal(decision.case_contract_valid, true);
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("timestamp-invalid"));
});

test("an unanswered case fails closed once the conservative internal target is overdue", () => {
  const value = fixture();
  value.acknowledged_at = null;
  value.responded_at = null;
  value.closed_at = null;
  value.identity = { status: "pending", method: "not-completed", completed_at: null };
  value.status = "identity-pending";
  value.delivery = { status: "pending", channel: "none", delivered_at: null, export_section_count: 0 };
  value.disposition.outcome = "pending";
  value.disposition.deletion_completed_at = null;
  value.review.privacy_case_review_completed = false;
  value.review.second_person_review_completed = false;
  const decision = evaluatePrivacyRightsCase(value, { evaluatedAt: "2026-08-20T20:00:00.000Z" });
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("internal-response-target-overdue"));
});

test("a closed case cannot record response or closure before delivery and deletion finish", () => {
  const value = fixture();
  value.responded_at = "2026-07-18T19:45:00.000Z";
  const decision = evaluatePrivacyRightsCase(value);
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("response-recorded-before-case-actions-completed"));
});

test("a case cannot close with an unresolved system, processor, object task, or safety check", () => {
  const value = fixture();
  value.systems[0].result = "unresolved";
  value.processors[0].result = "request-sent";
  value.disposition.object_task_pending_count = 1;
  value.safety_checks.secrets_absent = false;
  const decision = evaluatePrivacyRightsCase(value);
  assert.equal(decision.semantic_evaluation_passed, false);
  assert.ok(decision.gap_codes.includes("closed-with-unresolved-system"));
  assert.ok(decision.gap_codes.includes("closed-with-unresolved-processor"));
  assert.ok(decision.gap_codes.includes("erasure-closed-before-cleanup-complete"));
  assert.ok(decision.gap_codes.includes("closed-with-failed-safety-check"));
});

test("the evaluate CLI requires a private out-of-repository file and never echoes the case ID", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-privacy-case-"));
  chmodSync(directory, 0o700);
  const casePath = join(directory, "case.json");
  writeFileSync(casePath, JSON.stringify(fixture()), { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    "scripts/privacy-rights-case.mjs",
    "evaluate",
    "--case",
    casePath,
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.includes(fixture().case_id), false);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.semantic_evaluation_passed, true);

  chmodSync(casePath, 0o644);
  const rejected = spawnSync(process.execPath, [
    "scripts/privacy-rights-case.mjs",
    "evaluate",
    "--case",
    casePath,
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr, "privacy-rights command failed: input or policy rejected\n");
});

test("the offline drill writes only a private aggregate receipt and preserves every external blocker", async () => {
  const parent = mkdtempSync(join(tmpdir(), "cc-privacy-drill-"));
  chmodSync(parent, 0o700);
  const output = join(parent, "evidence");
  const checkoutVerifier = async ({ expectedCommit }) => ({
    head: expectedCommit,
    expectedCommit,
    clean: true,
  });
  const result = await runSyntheticPrivacyRightsDrill({
    outputDirectory: output,
    sourceCommit: SOURCE_COMMIT,
    completedAt: COMPLETED_AT,
    checkoutVerifier,
  });
  assert.equal(result.receipt.schema_version, PRIVACY_RIGHTS_DRILL_RECEIPT_VERSION);
  assert.equal(result.receipt.synthetic, true);
  assert.equal(result.receipt.production_ready, false);
  assert.equal(result.receipt.source_checkout_verified_clean, true);
  assert.equal(result.receipt.raw_identifiers_recorded, false);
  assert.equal(result.receipt.request_or_response_content_recorded, false);
  assert.equal(result.receipt.systems_checked_count, 8);
  assert.equal(result.receipt.processors_checked_count, 5);
  assert.equal(result.receipt.production_blockers.length, 5);
  const serialized = readFileSync(result.path, "utf8");
  assert.equal(serialized.includes(fixture().case_id), false);
  assert.equal(serialized.includes("example.invalid"), false);
  assert.match(result.receipt.receipt_sha256, /^[a-f0-9]{64}$/u);
});
