import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ObservabilityActivationRefusal,
  assertPublicReceipt,
  evaluateEvidence,
  loadPolicy,
  validatePolicy,
} from "../scripts/verify-observability-activation.mjs";

const NOW = new Date("2026-07-19T20:00:00.000Z");
const DIGESTS = Array.from({ length: 12 }, (_, index) => (
  index.toString(16).padStart(2, "0").repeat(32)
));

function completeEvidence() {
  const policy = loadPolicy();
  return {
    schema_version: "castingcompass.observability-activation-evidence/1.0.0",
    observed_at: "2026-07-19T19:00:00.000Z",
    evidence_packet_sha256: DIGESTS[0],
    release_binding: {
      reviewed_commit: "a".repeat(40),
      preview_evidence_sha256: DIGESTS[1],
      production_evidence_sha256: DIGESTS[2],
      preview_matches_reviewed_commit: true,
      production_matches_reviewed_commit: true,
    },
    log_hygiene: {
      preview_evidence_sha256: DIGESTS[3],
      production_evidence_sha256: DIGESTS[4],
      preview_structured_only: true,
      production_structured_only: true,
      preview_raw_invocation_absent: true,
      production_raw_invocation_absent: true,
    },
    dashboards: {
      evidence_sha256: DIGESTS[5],
      saved_views: [...policy.required_saved_views],
    },
    access: {
      evidence_sha256: DIGESTS[6],
      mfa_enforced: true,
      least_privilege_role: true,
      access_review_completed: true,
    },
    retention_and_cost: {
      evidence_sha256: DIGESTS[7],
      plan_recorded: true,
      retention_days: 7,
      sampling_percent: 100,
      estimated_daily_events: 1000,
      estimated_monthly_events: 30000,
      monthly_cost_ceiling_usd: 50,
      owner_assigned: true,
    },
    alerts: {
      evidence_sha256: DIGESTS[8],
      drills: policy.required_alert_drills.map((name) => ({
        name,
        delivered: true,
        acknowledged: true,
        closed: true,
        redaction_tested: true,
      })),
    },
    uptime: {
      evidence_sha256: DIGESTS[9],
      checks: policy.required_uptime_checks.map((name) => ({
        name,
        configured: true,
        delivered: true,
        acknowledged: true,
      })),
    },
    reconstruction: {
      evidence_sha256: DIGESTS[10],
      drills: policy.required_reconstruction_drills.map((name) => ({
        name,
        completed: true,
        structured_only: true,
        redaction_passed: true,
      })),
    },
    pseudonym_key: {
      evidence_sha256: DIGESTS[11],
      distinct_from_session_secret: true,
      access_separated: true,
      rotation_owner_assigned: true,
    },
    posthog: { enabled: false, separate_approval_recorded: false },
    production_change_authorized: false,
  };
}

test("the locked policy names every dashboard, alert, uptime, and reconstruction gate", () => {
  const policy = loadPolicy();
  assert.equal(policy.required_saved_views.length, 9);
  assert.equal(policy.required_alert_drills.length, 5);
  assert.equal(policy.required_uptime_checks.length, 3);
  assert.equal(policy.required_reconstruction_drills.length, 6);
  assert.equal(policy.limits.maximum_evidence_age_hours, 72);

  const weakened = structuredClone(policy);
  weakened.required_alert_drills.pop();
  assert.throws(() => validatePolicy(weakened), /locked policy/u);
});

test("complete fresh evidence produces only an aggregate ready receipt", () => {
  const evidence = completeEvidence();
  const receipt = evaluateEvidence(evidence, loadPolicy(), { now: NOW });
  assert.equal(receipt.activation_ready, true);
  assert.equal(receipt.read_only, true);
  assert.equal(receipt.provider_query_performed, false);
  assert.equal(receipt.production_change_authorized, false);
  assert.deepEqual(receipt.blockers, []);
  assert.equal(Object.values(receipt.checks).every(Boolean), true);

  const publicJson = JSON.stringify(receipt);
  for (const privateValue of [
    evidence.release_binding.reviewed_commit,
    evidence.evidence_packet_sha256,
    ...DIGESTS.slice(1),
    ...evidence.dashboards.saved_views,
  ]) {
    assert.equal(publicJson.includes(privateValue), false);
  }
});

test("a dashboard cannot substitute for access, alerts, retention, or incident evidence", () => {
  const evidence = completeEvidence();
  evidence.access.mfa_enforced = false;
  evidence.alerts.drills[0].delivered = false;
  evidence.retention_and_cost.owner_assigned = false;
  evidence.reconstruction.drills[0].redaction_passed = false;
  const receipt = evaluateEvidence(evidence, loadPolicy(), { now: NOW });
  assert.equal(receipt.checks.dashboards, true);
  assert.equal(receipt.activation_ready, false);
  assert.deepEqual(receipt.blockers, [
    "access-evidence-missing",
    "alert-drill-evidence-missing",
    "reconstruction-evidence-missing",
    "retention-cost-evidence-missing",
  ]);
});

test("expired and future-dated evidence fail closed", () => {
  const expired = completeEvidence();
  expired.observed_at = "2026-07-15T00:00:00.000Z";
  assert.deepEqual(evaluateEvidence(expired, loadPolicy(), { now: NOW }).blockers,
    ["evidence-expired"]);

  const future = completeEvidence();
  future.observed_at = "2026-07-19T20:06:00.000Z";
  assert.deepEqual(evaluateEvidence(future, loadPolicy(), { now: NOW }).blockers,
    ["evidence-not-yet-valid"]);
});

test("PostHog and production authorization remain separate fail-closed boundaries", () => {
  const posthog = completeEvidence();
  posthog.posthog.enabled = true;
  assert.deepEqual(evaluateEvidence(posthog, loadPolicy(), { now: NOW }).blockers,
    ["posthog-policy-violated"]);

  const authorization = completeEvidence();
  authorization.production_change_authorized = true;
  assert.throws(
    () => evaluateEvidence(authorization, loadPolicy(), { now: NOW }),
    (error) => error instanceof ObservabilityActivationRefusal
      && error.code === "authorization-boundary-violated",
  );
});

test("unknown fields, names, malformed hashes, and widened receipts are rejected", () => {
  const widened = completeEvidence();
  widened.account_id = "private-account";
  assert.throws(() => evaluateEvidence(widened, loadPolicy(), { now: NOW }),
    /unexpected fields/u);

  const unknownView = completeEvidence();
  unknownView.dashboards.saved_views[0] = "unreviewed view";
  const viewReceipt = evaluateEvidence(unknownView, loadPolicy(), { now: NOW });
  assert.deepEqual(viewReceipt.blockers, ["dashboard-evidence-missing"]);

  const malformed = completeEvidence();
  malformed.access.evidence_sha256 = "not-a-digest";
  assert.throws(() => evaluateEvidence(malformed, loadPolicy(), { now: NOW }), /SHA-256/u);

  const receipt = evaluateEvidence(completeEvidence(), loadPolicy(), { now: NOW });
  receipt.evidence_digest = DIGESTS[0];
  assert.throws(() => assertPublicReceipt(receipt, loadPolicy()), /unexpected fields/u);
});

test("incomplete, duplicated, and non-boolean drill claims are rejected or blocked", () => {
  const incomplete = completeEvidence();
  incomplete.alerts.drills.pop();
  assert.throws(() => evaluateEvidence(incomplete, loadPolicy(), { now: NOW }),
    /every required entry/u);

  const duplicated = completeEvidence();
  duplicated.uptime.checks[1].name = duplicated.uptime.checks[0].name;
  assert.throws(() => evaluateEvidence(duplicated, loadPolicy(), { now: NOW }),
    /unique strings/u);

  const invalid = completeEvidence();
  invalid.reconstruction.drills[0].completed = "yes";
  assert.throws(() => evaluateEvidence(invalid, loadPolicy(), { now: NOW }), /must be boolean/u);
});

test("the source never queries a provider or turns the verifier into a release command", () => {
  const source = readFileSync(
    new URL("../scripts/verify-observability-activation.mjs", import.meta.url), "utf8",
  );
  assert.doesNotMatch(source, /fetch\s*\(|spawnSync|execFile|wrangler|cloudflare\.com/iu);
  assert.doesNotMatch(source, /production_change_authorized:\s*true/iu);
});

test("CI and release provenance verify only the locked policy", () => {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const release = readFileSync(
    new URL("../.github/workflows/release-provenance.yml", import.meta.url), "utf8",
  );
  assert.match(manifest,
    /"security:observability-activation": "node scripts\/verify-observability-activation\.mjs verify-policy"/u);
  assert.match(manifest,
    /"verify:observability:activation": "node scripts\/verify-observability-activation\.mjs evaluate --evidence-file/iu);
  for (const workflow of [ci, release]) {
    assert.match(workflow, /npm run security:observability-activation/u);
    assert.doesNotMatch(workflow, /verify:observability:activation/u);
  }
});
