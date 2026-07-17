import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFeasibilityCancellationEvent,
  buildFeasibilityCompletionEvent,
  buildFeasibilityCorrectionEvent,
  buildFeasibilityRecruitmentCampaign,
  buildFeasibilityStartEvent,
  createFeasibilityRecruitmentToken,
  feasibilityPanelForSite,
  feasibilityParticipantGroupId,
  feasibilityPilotEnabled,
  feasibilitySitePanelEntries,
  reconcileFeasibilityEvents,
  resolveFeasibilityContext,
  resolveFeasibilityRecruitment,
  verifyFeasibilityEventHash,
} from "../worker/validation-feasibility.ts";

const SCORING_SHA = "c".repeat(64);
const ACTIVATION = {
  id: "activation-feasibility-v2-test",
  protocol_id: "california-halibut-collection-feasibility-v2",
  protocol_version: "2.0.0",
  protocol_sha256: "8ff0d7bd009ed8eb10f328347d58d0b63d0b6c822b08351cc5c2760d41de13ed",
  activation_commitment_sha256: "e".repeat(64),
  activation_manifest_sha256: "d".repeat(64),
  site_catalog_sha256: "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860",
  scoring_system_kind: "heuristic-configuration",
  scoring_system_version: `heuristic-california-halibut-${SCORING_SHA}`,
  scoring_system_sha256: SCORING_SHA,
  worker_version_id: "worker-feasibility-test",
  study_consent_version: "castingcompass.validation-feasibility-consent/2.0.0",
  start_at: "2026-07-20T00:00:00.000Z",
  end_at: "2026-10-18T00:00:00.000Z",
  preregistered_at: "2026-07-19T00:00:00.000Z",
  receipt_verified_at: "2026-07-19T01:00:00.000Z",
  status: "sealed-before-enrollment",
};
const OPPORTUNITY = {
  snapshotSha256: "a".repeat(64),
  siteCatalogSha256: "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860",
  targetTaxonId: "california-halibut",
  taxonCatalogVersion: "castingcompass.taxa/1.0.0",
  observationContractVersion: "castingcompass.observation/2.0.0",
  modelRunContractVersion: "castingcompass.model-run/2.0.0",
  opportunityContractVersion: "castingcompass.opportunity/2.0.0",
  scoringSystemKind: "heuristic-configuration",
  scoringSystemVersion: `heuristic-california-halibut-${SCORING_SHA}`,
  scoringSystemSha256: SCORING_SHA,
  generatedAt: "2026-07-21T09:00:00.000Z",
  windowId: "ocean-beach-north--20260721T1000Z",
  siteId: "ocean-beach-north",
  windowStart: "2026-07-21T10:00:00.000Z",
  windowEnd: "2026-07-21T12:00:00.000Z",
  opportunityScore: 81,
  habitatScore: 78,
  seasonalityScore: 74,
  conditionsScore: 72,
  fishabilityScore: 69,
};
const ENV = {
  VALIDATION_FEASIBILITY_ENABLED: "true",
  VALIDATION_FEASIBILITY_ACTIVATION_ID: ACTIVATION.id,
  VALIDATION_FEASIBILITY_ACTIVATION_MANIFEST_SHA256: ACTIVATION.activation_manifest_sha256,
  VALIDATION_FEASIBILITY_COMMITMENT_SHA256: ACTIVATION.activation_commitment_sha256,
  VALIDATION_PARTICIPANT_HMAC_SECRET: "feasibility-test-secret-with-at-least-32-bytes",
  VALIDATION_RECRUITMENT_HMAC_SECRET: "feasibility-recruitment-secret-at-least-32-bytes",
  CF_VERSION_METADATA: { id: ACTIVATION.worker_version_id },
};

function storedStart(event) {
  return {
    activation_id: event.activationId,
    trip_id: event.tripId,
    event_sha256: event.eventSha256,
    source_record_sha256: event.sourceRecordSha256,
    participant_group_id: event.participantGroupId,
    recruitment_frame_id: event.recruitmentFrameId,
    recruitment_source_id: event.recruitmentSourceId,
    selection_method: event.selectionMethod,
    score_influenced_choice: Number(event.scoreInfluencedChoice),
    study_consent_version: event.studyConsentVersion,
    study_consented_at: event.studyConsentedAt,
    target_taxon_id: event.targetTaxonId,
    site_id: event.siteId,
    geographic_panel: event.geographicPanel,
    mode: event.mode,
    segment_start_at: event.segmentStartAt,
    angler_count: event.anglerCount,
    scoring_system_kind: event.scoringSystemKind,
    scoring_system_version: event.scoringSystemVersion,
    scoring_system_sha256: event.scoringSystemSha256,
    opportunity_score: event.opportunityScore,
    opportunity_window_id: event.opportunityWindowId,
    snapshot_sha256: event.snapshotSha256,
    snapshot_suppression_sha256: event.snapshotSuppressionSha256,
  };
}

async function activeContext(accountId = "user-feasibility") {
  return resolveFeasibilityContext({
    env: ENV,
    activation: ACTIVATION,
    accountId,
    opportunity: OPPORTUNITY,
    timestamp: "2026-07-21T10:15:00.000Z",
    studyConsent: true,
    studyConsentVersion: ACTIVATION.study_consent_version,
  });
}

async function activeRecruitment(context, overrides = {}) {
  return resolveFeasibilityRecruitment({
    env: ENV,
    activation: ACTIVATION,
    accountId: "user-feasibility",
    participantGroupId: context.participantGroupId,
    timestamp: "2026-07-21T10:15:00.000Z",
    recruitmentToken: null,
    campaign: null,
    existing: null,
    ...overrides,
  });
}

test("feasibility activation is default-off and binds consent, release, score, and participant identity", async () => {
  assert.equal(feasibilityPilotEnabled({}), false);
  assert.equal(feasibilityPilotEnabled({ VALIDATION_FEASIBILITY_ENABLED: "TRUE" }), true);
  const context = await activeContext();
  assert.ok(context);
  assert.match(context.participantGroupId, /^participant-[a-f0-9]{64}$/);
  assert.equal(
    await feasibilityParticipantGroupId(ENV.VALIDATION_PARTICIPANT_HMAC_SECRET, ACTIVATION.id, "user-feasibility"),
    context.participantGroupId,
  );
  assert.notEqual(
    await feasibilityParticipantGroupId(ENV.VALIDATION_PARTICIPANT_HMAC_SECRET, ACTIVATION.id, "another-user"),
    context.participantGroupId,
  );
  assert.equal(await feasibilityParticipantGroupId("too-short", ACTIVATION.id, "user"), null);

  const wrongWorker = await resolveFeasibilityContext({
    env: { ...ENV, CF_VERSION_METADATA: { id: "wrong-worker" } },
    activation: ACTIVATION,
    accountId: "user-feasibility",
    opportunity: OPPORTUNITY,
    timestamp: "2026-07-21T10:15:00.000Z",
    studyConsent: true,
    studyConsentVersion: ACTIVATION.study_consent_version,
  });
  assert.equal(wrongWorker, null);
  const missingConsent = await resolveFeasibilityContext({
    env: ENV,
    activation: ACTIVATION,
    accountId: "user-feasibility",
    opportunity: OPPORTUNITY,
    timestamp: "2026-07-21T10:15:00.000Z",
    studyConsent: false,
    studyConsentVersion: ACTIVATION.study_consent_version,
  });
  assert.equal(missingConsent, null);
});

test("the frozen site catalog maps exactly once into five geographic panels", () => {
  const entries = feasibilitySitePanelEntries();
  assert.equal(entries.length, 46);
  assert.equal(new Set(entries.map(([site]) => site)).size, 46);
  assert.equal(new Set(entries.map(([, panel]) => panel)).size, 5);
  assert.equal(feasibilityPanelForSite("ocean-beach-north"), "golden-gate-sf-coast");
  assert.equal(feasibilityPanelForSite("not-a-frozen-site"), null);
});

test("pre-activation signed recruitment captures direct and approved-community sources", async () => {
  const context = await activeContext();
  assert.ok(context);
  const directPayload = {
    schema_version: "castingcompass.validation-feasibility-recruitment-token/2.0.0",
    activation_id: ACTIVATION.id,
    campaign_id: "campaign-direct-runtime-test",
    recruitment_source_id: "direct-opt-in-research-invite",
    selection_method: "direct_precommitment",
    issued_at: "2026-07-19T02:00:00.000Z",
    expires_at: "2026-10-18T00:00:00.000Z",
    community_approval_sha256: null,
  };
  const directToken = await createFeasibilityRecruitmentToken(
    ENV.VALIDATION_RECRUITMENT_HMAC_SECRET,
    directPayload,
  );
  assert.ok(directToken);
  const directCampaign = await buildFeasibilityRecruitmentCampaign(
    directPayload,
    "2026-07-19T02:00:00.000Z",
  );
  assert.ok(directCampaign);
  const storedCampaign = (campaign) => ({
    activation_id: campaign.activationId,
    campaign_id: campaign.campaignId,
    recruitment_source_id: campaign.recruitmentSourceId,
    selection_method: campaign.selectionMethod,
    invite_issued_at: campaign.inviteIssuedAt,
    invite_expires_at: campaign.inviteExpiresAt,
    community_approval_sha256: campaign.communityApprovalSha256,
    token_payload_sha256: campaign.tokenPayloadSha256,
    sealed_at: campaign.sealedAt,
  });
  const direct = await activeRecruitment(context, {
    recruitmentToken: directToken,
    campaign: storedCampaign(directCampaign),
  });
  assert.equal(direct.record.recruitmentSourceId, "direct-opt-in-research-invite");
  assert.equal(direct.record.selectionMethod, "direct_precommitment");
  assert.equal(direct.record.campaignId, directPayload.campaign_id);
  assert.equal(await activeRecruitment(context, {
    recruitmentToken: directToken,
    campaign: null,
  }), null);
  assert.equal(await activeRecruitment(context, {
    recruitmentToken: directToken,
    campaign: {
      ...storedCampaign(directCampaign),
      token_payload_sha256: "0".repeat(64),
    },
  }), null);
  const tamperedToken = `${directToken.slice(0, -1)}${directToken.endsWith("A") ? "B" : "A"}`;
  assert.equal(await activeRecruitment(context, {
    recruitmentToken: tamperedToken,
    campaign: storedCampaign(directCampaign),
  }), null);

  const communityPayload = {
    ...directPayload,
    campaign_id: "campaign-community-runtime-test",
    recruitment_source_id: "admin-approved-community-prospective",
    community_approval_sha256: "9".repeat(64),
  };
  const communityToken = await createFeasibilityRecruitmentToken(
    ENV.VALIDATION_RECRUITMENT_HMAC_SECRET,
    communityPayload,
  );
  assert.ok(communityToken);
  const communityCampaign = await buildFeasibilityRecruitmentCampaign(
    communityPayload,
    "2026-07-19T02:00:00.000Z",
  );
  assert.ok(communityCampaign);
  const community = await activeRecruitment(context, {
    recruitmentToken: communityToken,
    campaign: storedCampaign(communityCampaign),
  });
  assert.equal(community.record.recruitmentSourceId, "admin-approved-community-prospective");
  assert.equal(community.record.communityApprovalSha256, "9".repeat(64));
  assert.equal(await createFeasibilityRecruitmentToken(
    ENV.VALIDATION_RECRUITMENT_HMAC_SECRET,
    { ...directPayload, recruitment_source_id: "admin-approved-community-prospective" },
  ), null);
});

test("event hashes, terminal bounds, safe cancellation, and reconciliation fail closed", async () => {
  const context = await activeContext();
  assert.ok(context);
  const recruitment = await activeRecruitment(context);
  assert.ok(recruitment);
  const started = await buildFeasibilityStartEvent({
    context,
    recruitment: recruitment.record,
    tripId: "trip_11111111-1111-4111-8111-111111111111",
    opportunity: OPPORTUNITY,
    siteId: OPPORTUNITY.siteId,
    mode: "beach",
    anglerCount: 2,
    scoreInfluencedChoice: true,
    timestamp: "2026-07-21T10:15:00.000Z",
  });
  assert.ok(started);
  assert.equal(await verifyFeasibilityEventHash(started), true);
  const completed = await buildFeasibilityCompletionEvent({
    start: storedStart(started),
    timestamp: "2026-07-21T11:15:00.000Z",
    anglerCount: 2,
    targetEncounterCount: 0,
    targetRetainedCount: 0,
    targetReleasedCount: 0,
  });
  assert.ok(completed);
  assert.equal(completed.targetEncountered, false);
  assert.equal(await verifyFeasibilityEventHash(completed), true);
  const correction = await buildFeasibilityCorrectionEvent({
    start: storedStart(started),
    rootCompletionEventSha256: completed.eventSha256,
    previousEventSha256: completed.eventSha256,
    siteId: started.siteId,
    mode: started.mode,
    segmentStartAt: started.segmentStartAt,
    segmentEndAt: completed.segmentEndAt,
    anglerCount: 2,
    targetEncounterCount: 1,
    targetRetainedCount: 1,
    targetReleasedCount: 0,
    correctedAt: "2026-07-21T11:20:00.000Z",
  });
  assert.ok(correction);
  assert.equal(correction.analyticalStatus, "eligible_corrected_completion");
  assert.equal(await buildFeasibilityCompletionEvent({
    start: storedStart(started),
    timestamp: "2026-07-23T00:15:00.001Z",
    anglerCount: 2,
    targetEncounterCount: 0,
    targetRetainedCount: 0,
    targetReleasedCount: 0,
  }), null);

  const canceledStart = await buildFeasibilityStartEvent({
    context,
    recruitment: recruitment.record,
    tripId: "trip_22222222-2222-4222-8222-222222222222",
    opportunity: OPPORTUNITY,
    siteId: OPPORTUNITY.siteId,
    mode: "beach",
    anglerCount: 1,
    scoreInfluencedChoice: false,
    timestamp: "2026-07-21T10:30:00.000Z",
  });
  assert.ok(canceledStart);
  const canceled = await buildFeasibilityCancellationEvent({
    start: storedStart(canceledStart),
    timestamp: "2026-07-21T10:45:00.000Z",
    reason: "water_safety",
  });
  assert.ok(canceled);
  assert.equal(await buildFeasibilityCancellationEvent({
    start: storedStart(canceledStart),
    timestamp: "2026-07-21T10:45:00.000Z",
    reason: "outcome_disappointing",
  }), null);

  const result = await reconcileFeasibilityEvents({
    events: [started, completed, canceledStart, canceled],
    corrections: [correction],
    privacyRemovals: {
      removedStartedAttempts: 0,
      removedCompletedAttempts: 0,
      removedSafeCanceledAttempts: 0,
    },
    snapshotAndRestorePassed: true,
  });
  assert.equal(result.startedAttempts, 2);
  assert.equal(result.completedAttempts, 1);
  assert.equal(result.safeCanceledAttempts, 1);
  assert.equal(result.unreconciledAttempts, 0);
  assert.equal(result.reconciliationRate, 1);
  assert.equal(result.completionRateExcludingSafeCancellations, 1);
  assert.equal(result.correctionEvents, 1);
  assert.equal(result.targetEncounters, 1);
  assert.equal(result.candidatePerformanceComputed, false);
  assert.equal(result.status, "collection-feasibility-not-demonstrated");
  assert.ok(result.failedGates.includes("minimum_recruitment_sources_with_attempts"));

  const tampered = { ...completed, eventSha256: "0".repeat(64) };
  const invalid = await reconcileFeasibilityEvents({
    events: [started, started, tampered],
    corrections: [{ ...correction, previousEventSha256: "1".repeat(64) }],
    snapshotAndRestorePassed: false,
  });
  assert.ok(invalid.failedGates.includes("duplicate_start_event"));
  assert.ok(invalid.failedGates.includes("invalid_event_hash"));
  assert.ok(invalid.failedGates.includes("invalid_correction_hash"));
});
