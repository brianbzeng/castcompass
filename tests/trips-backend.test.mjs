import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSpeciesObservationContract, handleTripRequest } from "../worker/trips.ts";

const ORIGIN = "https://contourcast.example";
const SITES = [
  { id: "oyster-point", type: "Pier" },
  { id: "crissy-field", type: "Beach" },
];

test("recruitment identity matches the shared cross-runtime vector", async () => {
  const vector = JSON.parse(await readFile(
    new URL("../contracts/fixtures/recruitment-event-vector.json", import.meta.url),
    "utf8",
  ));
  const participantDigest = createHash("sha256")
    .update(`${vector.participant_token_domain}\u0000${vector.reporter_key_hash_input}`)
    .digest("hex");
  assert.equal(`participant-${participantDigest}`, vector.expected_participant_group_id);
  assert.deepEqual(Object.keys(vector.payload), [
    "community_approval_sha256",
    "participant_group_id",
    "recruitment_event_at",
    "recruitment_frame_id",
    "recruitment_source_id",
  ]);
  assert.equal(JSON.stringify(vector.payload), vector.canonical_json);
  assert.equal(
    createHash("sha256").update(vector.canonical_json).digest("hex"),
    vector.expected_recruitment_event_sha256,
  );
});

test("completion identity and proof match the shared multi-angler vector", async () => {
  const vector = JSON.parse(await readFile(
    new URL("../contracts/fixtures/completion-event-vector.json", import.meta.url),
    "utf8",
  ));
  const sourceRecordSha256 = createHash("sha256")
    .update(`${vector.source_record_domain}\u0000${vector.immutable_trip_id}`)
    .digest("hex");
  const effortSegmentSha256 = createHash("sha256")
    .update(`${vector.effort_segment_domain}\u0000${vector.immutable_trip_id}`)
    .digest("hex");
  const assignmentSha256 = createHash("sha256")
    .update(`${vector.assignment_domain}\u0000${vector.validation_protocol_id}\u0000${sourceRecordSha256}`)
    .digest("hex");
  assert.equal(sourceRecordSha256, vector.expected_source_record_sha256);
  assert.equal(`effort-${effortSegmentSha256}`, vector.expected_effort_segment_id);
  assert.equal(`assignment-${assignmentSha256}`, vector.expected_assignment_id);
  assert.ok(vector.payload.angler_count > 1, "fixture must exercise multi-angler effort");
  assert.equal(
    vector.payload.person_milliseconds,
    vector.payload.duration_milliseconds * vector.payload.angler_count,
  );
  assert.deepEqual(Object.keys(vector.payload), Object.keys(vector.payload).toSorted());
  assert.equal(JSON.stringify(vector.payload), vector.canonical_json);
  assert.equal(
    createHash("sha256").update(vector.canonical_json).digest("hex"),
    vector.expected_completion_event_sha256,
  );
});

test("export mapping vector freezes secondary-admission cases and signed audit fields", async () => {
  const vector = JSON.parse(await readFile(
    new URL("../contracts/fixtures/validation-export-mapping-vector.json", import.meta.url),
    "utf8",
  ));
  const rule = vector.mapping_rule;
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  };
  const provenanceSummary = (raw) => {
    const events = [...raw.provenance_events]
      .map((event) => canonicalize(event))
      .sort((left, right) => left.created_at.localeCompare(right.created_at)
        || left.event_type.localeCompare(right.event_type)
        || left.id.localeCompare(right.id));
    const counts = Object.fromEntries(Object.keys(rule.required_event_type_counts).map((type) => [type, 0]));
    for (const event of events) counts[event.event_type] += 1;
    const terminal = events.at(-1);
    return {
      counts,
      terminal,
      sha256: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
    };
  };
  const immutableIdFields = [
    "participant_group_id",
    "recruitment_event_sha256",
    "forecast_impression_id",
    "assignment_id",
    "source_record_sha256",
    "effort_segment_id",
    "completion_event_sha256",
  ];
  const secondaryAdmissionAllowed = (raw) => {
    const chain = provenanceSummary(raw);
    return raw.event_type === rule.required_raw_event_type
    && raw.source_role === rule.required_raw_source_role
    && raw.evidence_status === rule.required_raw_evidence_status
    && raw.cohort_id === rule.required_raw_cohort_id
    && raw.selection_method === rule.required_raw_selection_method
    && raw.validation_protocol_id === rule.required_validation_protocol_id
    && /^[a-f0-9]{64}$/.test(raw.activation_manifest_sha256 ?? "")
    && /^[a-f0-9]{64}$/.test(raw.activation_scoring_system_sha256 ?? "")
    && Date.parse(raw.activated_at ?? "") < Date.parse("2026-08-01T00:00:00.000Z")
    && raw.exclusion_reason === null
    && immutableIdFields.every((field) => typeof raw[field] === "string" && raw[field].length > 0)
    && JSON.stringify(raw.collection_event_type_counts) === JSON.stringify(rule.required_event_type_counts)
    && JSON.stringify(chain.counts) === JSON.stringify(rule.required_event_type_counts)
    && raw.collection_event_id === raw.collection_terminal_event_id
    && raw.collection_event_at === raw.collection_terminal_event_at
    && raw.collection_event_at === raw.completion_event_at
    && raw.collection_terminal_event_type === "completion"
    && chain.terminal.id === raw.collection_terminal_event_id
    && chain.terminal.event_type === raw.collection_terminal_event_type
    && chain.terminal.created_at === raw.collection_terminal_event_at
    && chain.sha256 === raw.collection_provenance_chain_sha256;
  };

  assert.equal(vector.cases.filter((item) => item.expected_secondary_admission_allowed).length, 1);
  for (const item of vector.cases) {
    assert.equal(
      secondaryAdmissionAllowed(item.raw_collection),
      item.expected_secondary_admission_allowed,
      item.id,
    );
    assert.equal(item.promotion_bearing, false, item.id);
    assert.deepEqual(
      item.expected_evaluator_mapping,
      item.expected_secondary_admission_allowed ? rule.evaluator_mapping : null,
      item.id,
    );
    const auditProjection = {
      collection_source_role: item.raw_collection.source_role,
      collection_evidence_status: item.raw_collection.evidence_status,
      collection_cohort_id: item.raw_collection.cohort_id,
      collection_selection_method: item.raw_collection.selection_method,
      collection_validation_protocol_id: item.raw_collection.validation_protocol_id,
      activation_manifest_sha256: item.raw_collection.activation_manifest_sha256,
      collection_activated_at: item.raw_collection.activated_at,
      collection_activation_scoring_system_sha256: item.raw_collection.activation_scoring_system_sha256,
      collection_exclusion_reason: item.raw_collection.exclusion_reason,
      collection_event_type: item.raw_collection.event_type,
      collection_event_id: item.raw_collection.collection_event_id,
      collection_event_at: item.raw_collection.collection_event_at,
      collection_event_type_counts: item.raw_collection.collection_event_type_counts,
      collection_terminal_event_id: item.raw_collection.collection_terminal_event_id,
      collection_terminal_event_type: item.raw_collection.collection_terminal_event_type,
      collection_terminal_event_at: item.raw_collection.collection_terminal_event_at,
      collection_provenance_chain_sha256: item.raw_collection.collection_provenance_chain_sha256,
      ...Object.fromEntries(immutableIdFields.map((field) => [field, item.raw_collection[field]])),
      completion_event_at: item.raw_collection.completion_event_at,
    };
    assert.deepEqual(Object.keys(auditProjection), vector.required_signed_audit_fields, item.id);
  }
  const clientInjection = vector.cases.find((item) => item.id === "context-with-normalized-client-claims");
  assert.deepEqual(clientInjection.untrusted_client_evaluator_fields, rule.evaluator_mapping);
  assert.equal(secondaryAdmissionAllowed(clientInjection.raw_collection), false);
});

class MemoryTripStore {
  trips = new Map();
  validations = new Map();
  completionEvents = new Map();
  rateLimited = false;
  initialized = false;

  async initialize() {
    this.initialized = true;
  }

  async assertSubmissionAllowed() {
    if (this.rateLimited) {
      const error = new Error("Too many trip submissions. Please try again later.");
      error.name = "RateLimitError";
      throw error;
    }
  }

  async insertTrip(record, validation) {
    const row = recordToRow(record);
    this.trips.set(row.id, row);
    if (validation) this.validations.set(row.id, validation);
    return row;
  }

  async getTrip(id) {
    return this.trips.get(id) ?? null;
  }

  async getValidationEnrollment(id) {
    const record = this.validations.get(id)?.provenance;
    if (!record || record.eventType !== "enrollment") return null;
    return {
      collection_contract_version: record.collectionContractVersion,
      source_role: record.sourceRole,
      cohort_id: record.cohortId,
      validation_protocol_id: record.validationProtocolId,
      activation_manifest_sha256: record.activationManifestSha256,
      activated_at: record.activatedAt,
      activation_scoring_system_sha256: record.activationScoringSystemSha256,
      participant_group_id: record.participantGroupId,
      recruitment_frame_id: record.recruitmentFrameId,
      recruitment_source_id: record.recruitmentSourceId,
      recruitment_event_contract_version: record.recruitmentEventContractVersion,
      recruitment_event_at: record.recruitmentEventAt,
      recruitment_event_sha256: record.recruitmentEventSha256,
      community_approval_sha256: record.communityApprovalSha256,
      assignment_id: record.assignmentId,
      source_record_sha256: record.sourceRecordSha256,
      effort_segment_id: record.effortSegmentId,
      effort_unit: record.effortUnit,
      attempt_count: record.attemptCount,
      target_taxon_id: record.targetTaxonId,
      segment_start_at: record.segmentStartAt,
      incentive_policy_id: record.incentivePolicyId,
      selection_method: record.selectionMethod,
      target_intent: record.targetIntent,
      primary_target_confirmed: Number(record.primaryTargetConfirmed),
      complete_attempt_confirmed: record.completeAttemptConfirmed,
      mode_at_enrollment: record.modeAtEnrollment,
      consent_version: record.consentVersion,
      consented_at: record.consentedAt,
      score_influenced_choice: Number(record.scoreInfluencedChoice),
      forecast_impression_id: record.forecastImpressionId,
      attestation_status: record.attestationStatus,
    };
  }

  async getRecruitmentEvent(participantGroupId, activation) {
    const records = [...this.validations.values()]
      .map((validation) => validation.provenance)
      .filter((record) => record.eventType === "enrollment"
        && record.sourceRole === "prospective_secondary"
        && record.participantGroupId === participantGroupId
        && record.validationProtocolId === activation.protocolId
        && record.activationManifestSha256 === activation.manifestSha256
        && record.activatedAt === activation.activatedAt
        && record.activationScoringSystemSha256 === activation.scoringSystemSha256
        && record.recruitmentFrameId === "california-halibut-site-window-recruitment-v1")
      .sort((left, right) => left.recruitmentEventAt.localeCompare(right.recruitmentEventAt));
    const record = records[0];
    if (!record) return null;
    return {
      participant_group_id: record.participantGroupId,
      recruitment_frame_id: record.recruitmentFrameId,
      recruitment_source_id: record.recruitmentSourceId,
      recruitment_event_contract_version: record.recruitmentEventContractVersion,
      recruitment_event_at: record.recruitmentEventAt,
      recruitment_event_sha256: record.recruitmentEventSha256,
      community_approval_sha256: record.communityApprovalSha256,
    };
  }

  async getForecastImpression(id) {
    const record = this.validations.get(id)?.impression;
    if (!record) return null;
    return {
      id: record.id,
      window_start: record.windowStart,
      window_end: record.windowEnd,
      site_id: record.siteId,
    };
  }

  async completeTrip(id, tokenHash, completion, provenance) {
    const row = this.trips.get(id);
    if (!row || row.status !== "active" || row.token_hash !== tokenHash) return null;
    const forecastAttributionCleared = row.mode !== completion.mode;
    Object.assign(row, {
      status: "completed",
      ended_at: completion.endedAt,
      mode: completion.mode,
      fishing_method: completion.fishingMethod,
      gear: completion.gear,
      angler_count: completion.anglerCount,
      angler_hours: completion.anglerHours,
      keeper_count: completion.keeperCount,
      short_released_count: completion.shortReleasedCount,
      halibut_encounters: completion.halibutEncounters,
      no_catch: Number(completion.noCatch),
      other_catch_count: completion.otherCatchCount,
      other_species: completion.otherSpecies,
      observations_json: completion.observationsJson,
      observation_contract_version: completion.observationContractVersion,
      taxon_catalog_version: completion.taxonCatalogVersion,
      target_taxon_id: completion.targetTaxonId,
      contract_status: completion.contractStatus,
      taxon_observations_json: completion.taxonObservationsJson,
      outcome_class: completion.outcomeClass,
      target_encounter_count: completion.targetEncounterCount,
      any_fish_encounter_count: completion.anyFishEncounterCount,
      target_identification_confidence: completion.targetIdentificationConfidence,
      notes: completion.notes,
      consent: 1,
      consent_at: completion.consentAt,
      moderation_status: "pending",
      ...(forecastAttributionCleared ? {
        opportunity_window_id: null,
        opportunity_score: null,
        habitat_score: null,
        seasonality_score: null,
        conditions_score: null,
        fishability_score: null,
        model_version: null,
        prediction_metadata_json: null,
      } : {}),
      photo_key: completion.photoKey,
      photo_content_type: completion.photoContentType,
      photo_size_bytes: completion.photoSizeBytes,
      updated_at: completion.updatedAt,
      completed_at: completion.updatedAt,
      token_hash: null,
    });
    if (provenance) this.completionEvents.set(id, provenance);
    return row;
  }

  async getSummary(now) {
    const rows = [...this.trips.values()].filter(
      (trip) => trip.status === "completed" && trip.consent === 1 && trip.moderation_status !== "rejected"
        && trip.contract_status === "valid"
        && trip.observation_contract_version === "castingcompass.observation/2.0.0"
        && trip.taxon_catalog_version === "castingcompass.taxa/1.0.0"
        && trip.target_taxon_id === "california-halibut",
    );
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const recentRows = rows.filter((trip) => new Date(trip.completed_at).getTime() >= cutoff);
    const halibutTrips = rows.filter((trip) => trip.halibut_encounters > 0).length;
    const totalHalibut = rows.reduce((sum, trip) => sum + trip.halibut_encounters, 0);
    return {
      completedTrips: rows.length,
      noCatchTrips: rows.filter((trip) => trip.no_catch === 1).length,
      halibutTrips,
      totalHalibut,
      anglerHours: rows.reduce((sum, trip) => sum + trip.angler_hours, 0),
      halibutEncounters: totalHalibut,
      sitesCovered: new Set(rows.map((trip) => trip.site_id)).size,
      lastUpdated: rows.map((trip) => trip.updated_at).sort().at(-1) ?? null,
      past24Hours: {
        completedTrips: recentRows.length,
        anglerHours: recentRows.reduce((sum, trip) => sum + trip.angler_hours, 0),
        halibutEncounters: recentRows.reduce((sum, trip) => sum + trip.halibut_encounters, 0),
        sitesCovered: new Set(recentRows.map((trip) => trip.site_id)).size,
      },
    };
  }
}

function recordToRow(record) {
  return {
    id: record.id,
    user_id: record.userId,
    status: record.status,
    source: record.source,
    site_id: record.siteId,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    mode: record.mode,
    fishing_method: record.fishingMethod,
    gear: record.gear,
    angler_count: record.anglerCount,
    angler_hours: record.anglerHours,
    keeper_count: record.keeperCount,
    short_released_count: record.shortReleasedCount,
    halibut_encounters: record.halibutEncounters,
    no_catch: record.noCatch === null ? null : Number(record.noCatch),
    other_catch_count: record.otherCatchCount,
    other_species: record.otherSpecies,
    observations_json: record.observationsJson,
    observation_contract_version: record.observationContractVersion,
    taxon_catalog_version: record.taxonCatalogVersion,
    target_taxon_id: record.targetTaxonId,
    contract_status: record.contractStatus,
    taxon_observations_json: record.taxonObservationsJson,
    outcome_class: record.outcomeClass,
    target_encounter_count: record.targetEncounterCount,
    any_fish_encounter_count: record.anyFishEncounterCount,
    target_identification_confidence: record.targetIdentificationConfidence,
    notes: record.notes,
    consent: Number(record.consent),
    consent_at: record.consentAt,
    moderation_status: record.moderationStatus,
    reporter_key_hash: record.reporterKeyHash,
    referral_code: record.referralCode,
    token_hash: record.tokenHash,
    idempotency_key_hash: record.idempotencyKeyHash,
    opportunity_window_id: record.opportunityWindowId,
    opportunity_score: record.opportunityScore,
    habitat_score: record.habitatScore,
    seasonality_score: record.seasonalityScore,
    conditions_score: record.conditionsScore,
    fishability_score: record.fishabilityScore,
    conditions_score: record.conditionsScore,
    model_version: record.modelVersion,
    score_influenced_choice:
      record.scoreInfluencedChoice === null ? null : Number(record.scoreInfluencedChoice),
    prediction_metadata_json: record.predictionMetadataJson,
    photo_key: record.photoKey,
    photo_content_type: record.photoContentType,
    photo_size_bytes: record.photoSizeBytes,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    completed_at: record.completedAt,
  };
}

function jsonRequest(path, body, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function multipartRequest(path, form) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: form,
  });
}

let tripRequestSequence = 0;

function nextTripRequestMaterial() {
  tripRequestSequence += 1;
  const suffix = tripRequestSequence.toString(16).padStart(12, "0");
  return {
    clientTripId: `trip_00000000-0000-4000-8000-${suffix}`,
    requestToken: `request-token-${tripRequestSequence.toString(36).padStart(29, "0")}`,
  };
}

function validStartBody(overrides = {}) {
  return {
    ...nextTripRequestMaterial(),
    siteId: "oyster-point",
    consent: true,
    primaryTargetConfirmed: true,
    mode: "pier",
    scoreInfluencedChoice: false,
    reporterKey: "valid-anonymous-device-key-123456",
    website: "",
    ...overrides,
  };
}

function addRequiredCompletionFields(form, { mode = "beach", includeInfluence = true } = {}) {
  if (form.has("siteId")) {
    const request = nextTripRequestMaterial();
    form.set("clientTripId", request.clientTripId);
    form.set("requestToken", request.requestToken);
  }
  form.set("consent", "true");
  form.set("primaryTargetConfirmed", "true");
  form.set("completeAttempt", "true");
  form.set("mode", mode);
  if (includeInfluence) form.set("scoreInfluencedChoice", "false");
  return form;
}

const ATTESTATION_SCORING_SHA = "c".repeat(64);

function attestationEnv({
  siteId = "oyster-point",
  windowId = `${siteId}--20260711T1600Z`,
  start = "2026-07-11T16:00:00Z",
  end = "2026-07-11T18:00:00Z",
  score = 84,
} = {}) {
  const index = {
    schema_version: "castingcompass.opportunity-attestation-index/1.0.0",
    generated_at: "2026-07-11T15:00:00Z",
    snapshot_sha256: "a".repeat(64),
    site_catalog_sha256: "b".repeat(64),
    target_taxon_id: "california-halibut",
    taxon_catalog_version: "castingcompass.taxa/1.0.0",
    observation_contract_version: "castingcompass.observation/2.0.0",
    model_run_contract_version: "castingcompass.model-run/2.0.0",
    opportunity_contract_version: "castingcompass.opportunity/2.0.0",
    scoring_system_kind: "heuristic-configuration",
    scoring_system_version: `heuristic-california-halibut-${ATTESTATION_SCORING_SHA}`,
    scoring_system_sha256: ATTESTATION_SCORING_SHA,
    windows: [[windowId, siteId, start, end, score, 71, 72, 73, 74]],
  };
  return {
    ASSETS: {
      async fetch() {
        return new Response(JSON.stringify(index), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  };
}

test("start validates origin and curated site IDs", async () => {
  const store = new MemoryTripStore();
  const options = { store, now: () => new Date("2026-07-11T18:00:00.000Z") };

  const wrongOrigin = jsonRequest(
    "/api/trips/start",
    { siteId: "oyster-point", consent: true, reporterKey: "a".repeat(32) },
    { Origin: "https://attacker.example" },
  );
  assert.equal((await handleTripRequest(wrongOrigin, {}, SITES, options)).status, 403);

  const unknownSite = jsonRequest("/api/trips/start", {
    ...validStartBody(),
    siteId: "made-up-coordinate",
  });
  const response = await handleTripRequest(unknownSite, {}, SITES, options);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "invalid_site");
});

test("client trip identities make start, completion, and past-report retries idempotent", async () => {
  const store = new MemoryTripStore();
  const reporterKey = "idempotent-device-key-123456789012";
  const now = () => new Date("2026-07-11T18:00:00.000Z");
  const startBody = validStartBody({
    clientTripId: "trip_20000000-0000-4000-8000-000000000001",
    requestToken: "start-idempotency-token-0000000000000000001",
    startedAt: "2026-07-11T18:00:00.000Z",
    reporterKey,
  });

  const firstStartResponse = await handleTripRequest(
    jsonRequest("/api/trips/start", startBody),
    {},
    SITES,
    { store, now },
  );
  assert.equal(firstStartResponse.status, 201);
  const firstStart = await firstStartResponse.json();
  assert.deepEqual(firstStart.receipt, { operation: "start", tripId: startBody.clientTripId });
  assert.equal(firstStart.token, startBody.requestToken);
  assert.equal(store.trips.size, 1);

  store.rateLimited = true;
  const retryStartResponse = await handleTripRequest(
    jsonRequest("/api/trips/start", { ...startBody, siteId: "crissy-field" }),
    {},
    SITES,
    { store, now },
  );
  assert.equal(retryStartResponse.status, 201);
  const retryStart = await retryStartResponse.json();
  assert.equal(retryStart.trip.id, firstStart.trip.id);
  assert.equal(retryStart.trip.siteId, firstStart.trip.siteId);
  assert.equal(store.trips.size, 1);

  const conflictingStart = await handleTripRequest(
    jsonRequest("/api/trips/start", { ...startBody, requestToken: "wrong-idempotency-token-0000000000000000001" }),
    {},
    SITES,
    { store, now },
  );
  assert.equal(conflictingStart.status, 409);
  assert.equal((await conflictingStart.json()).error.code, "trip_request_conflict");
  const crossAccountStart = await handleTripRequest(
    jsonRequest("/api/trips/start", startBody),
    {},
    SITES,
    { store, now, accountId: "different-account" },
  );
  assert.equal(crossAccountStart.status, 409);

  const completionForm = () => {
    const form = new FormData();
    form.set("token", firstStart.token);
    form.set("reporterKey", reporterKey);
    form.set("keeperCount", "0");
    form.set("shortReleasedCount", "0");
    form.set("otherCatchCount", "0");
    addRequiredCompletionFields(form, { mode: "pier", includeInfluence: false });
    return form;
  };
  let completionCallbacks = 0;
  const firstCompletionResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${firstStart.trip.id}/complete`, completionForm()),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T19:00:00.000Z"), onTripCompleted: () => { completionCallbacks += 1; } },
  );
  assert.equal(firstCompletionResponse.status, 200);
  const firstCompletion = await firstCompletionResponse.json();
  assert.deepEqual(firstCompletion.receipt, { operation: "complete", tripId: firstStart.trip.id });
  assert.equal(store.trips.get(firstStart.trip.id).token_hash, null);

  const retryCompletionResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${firstStart.trip.id}/complete`, completionForm()),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T20:00:00.000Z"), onTripCompleted: () => { completionCallbacks += 1; } },
  );
  assert.equal(retryCompletionResponse.status, 200);
  const retryCompletion = await retryCompletionResponse.json();
  assert.equal(retryCompletion.trip.id, firstCompletion.trip.id);
  assert.equal(retryCompletion.trip.endedAt, firstCompletion.trip.endedAt);
  assert.equal(completionCallbacks, 1);
  const wrongReporterCompletion = completionForm();
  wrongReporterCompletion.set("reporterKey", "different-device-key-12345678901234");
  const deniedCompletionResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${firstStart.trip.id}/complete`, wrongReporterCompletion),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T20:00:00.000Z") },
  );
  assert.equal(deniedCompletionResponse.status, 404);

  store.rateLimited = false;
  const pastRequest = {
    clientTripId: "trip_20000000-0000-4000-8000-000000000002",
    requestToken: "past-idempotency-token-00000000000000000001",
  };
  const pastForm = () => {
    const form = new FormData();
    form.set("siteId", "crissy-field");
    form.set("startedAt", "2026-07-10T15:00:00.000Z");
    form.set("endedAt", "2026-07-10T18:00:00.000Z");
    form.set("keeperCount", "0");
    form.set("shortReleasedCount", "0");
    form.set("otherCatchCount", "0");
    form.set("reporterKey", reporterKey);
    addRequiredCompletionFields(form, { mode: "beach" });
    form.set("clientTripId", pastRequest.clientTripId);
    form.set("requestToken", pastRequest.requestToken);
    return form;
  };
  const firstPastResponse = await handleTripRequest(
    multipartRequest("/api/trips/report", pastForm()),
    {},
    SITES,
    { store, now },
  );
  assert.equal(firstPastResponse.status, 201);
  const firstPast = await firstPastResponse.json();
  assert.deepEqual(firstPast.receipt, { operation: "past", tripId: pastRequest.clientTripId });
  assert.equal(store.trips.size, 2);

  store.rateLimited = true;
  const retryPastResponse = await handleTripRequest(
    multipartRequest("/api/trips/report", pastForm()),
    {},
    SITES,
    { store, now },
  );
  assert.equal(retryPastResponse.status, 201);
  const retryPast = await retryPastResponse.json();
  assert.equal(retryPast.trip.id, firstPast.trip.id);
  assert.equal(store.trips.size, 2);
  const wrongReporterPast = pastForm();
  wrongReporterPast.set("reporterKey", "different-device-key-12345678901234");
  const deniedPastResponse = await handleTripRequest(
    multipartRequest("/api/trips/report", wrongReporterPast),
    {},
    SITES,
    { store, now },
  );
  assert.equal(deniedPastResponse.status, 409);
});

test("start and complete persist privacy-safe validation fields", async () => {
  const store = new MemoryTripStore();
  const reporterKey = "anonymous-device-key-1234567890";
  const startBody = {
    ...validStartBody({ scoreInfluencedChoice: true }),
    startedAt: "2026-07-11T16:00:00.000Z",
    reporterKey,
    method: "bait",
    gear: "Carolina rig",
    anglerCount: 2,
    opportunityWindowId: "oyster-point--20260711T1600Z",
    opportunityScore: 1,
    modelVersion: "client-forged-model",
    referralCode: "bay-area-anglers",
    website: "",
  };
  const forgedAuthority = await handleTripRequest(
    jsonRequest("/api/trips/start", {
      ...startBody,
      forecastImpressionId: "impression_client_forged",
      attestedAt: "2020-01-01T00:00:00.000Z",
      validationProtocolId: "client-forged-protocol",
      activationManifestSha256: "f".repeat(64),
      activatedAt: "2020-01-01T00:00:00.000Z",
      activationScoringSystemSha256: "f".repeat(64),
      participantGroupId: `participant-${"f".repeat(64)}`,
      recruitmentFrameId: "client-forged-frame",
      recruitmentSourceId: "admin-approved-community-prospective",
      recruitmentEventAt: "2020-01-01T00:00:00.000Z",
      recruitmentEventSha256: "f".repeat(64),
      communityApprovalSha256: "f".repeat(64),
    }),
    attestationEnv(),
    SITES,
    { store, now: () => new Date("2026-07-11T16:01:00.000Z") },
  );
  assert.equal(forgedAuthority.status, 422);
  assert.equal((await forgedAuthority.json()).error.code, "unexpected_fields");
  assert.equal(store.trips.size, 0);

  const start = await handleTripRequest(
    jsonRequest("/api/trips/start", startBody),
    attestationEnv(),
    SITES,
    { store, now: () => new Date("2026-07-11T16:01:00.000Z") },
  );

  assert.equal(start.status, 201);
  const started = await start.json();
  assert.match(started.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(started.trip.mode, "pier");
  assert.equal(started.trip.fishingMethod, "bait");
  assert.equal(started.trip.referralCode, "bay-area-anglers");
  assert.equal(started.trip.targetTaxonId, "california-halibut");
  assert.equal(started.trip.contractStatus, null);
  assert.equal(started.trip.observationContractVersion, null);
  assert.equal(started.trip.outcomeClass, null);
  assert.equal("reporterKey" in started.trip, false);

  const storedActive = store.trips.get(started.trip.id);
  assert.notEqual(storedActive.reporter_key_hash, reporterKey);
  assert.equal(storedActive.reporter_key_hash.length, 64);
  assert.equal(storedActive.consent, 1);
  const enrollment = store.validations.get(started.trip.id);
  assert.equal(enrollment.provenance.sourceRole, "context_only");
  assert.equal(enrollment.provenance.validationProtocolId, null);
  assert.equal(enrollment.provenance.evidenceStatus, "context_only");
  assert.equal(enrollment.provenance.scoreInfluencedChoice, true);
  assert.equal(enrollment.provenance.participantGroupId, null);
  assert.equal(enrollment.provenance.recruitmentFrameId, null);
  assert.equal(enrollment.provenance.recruitmentEventSha256, null);
  assert.notEqual(enrollment.impression.id, "impression_client_forged");
  assert.equal(started.trip.startedAt, "2026-07-11T16:01:00.000Z");
  assert.equal(enrollment.impression.attestedAt, "2026-07-11T16:01:00.000Z");
  assert.equal(enrollment.impression.scoringSystemSha256, ATTESTATION_SCORING_SHA);

  const form = new FormData();
  form.set("token", started.token);
  form.set("endedAt", "2026-07-11T18:00:00.000Z");
  form.set("keeperCount", "1");
  form.set("shortReleasedCount", "2");
  form.set("notes", "Three verified encounters.");
  form.set("website", "");
  addRequiredCompletionFields(form, { mode: "pier", includeInfluence: false });

  const completedResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${started.trip.id}/complete`, form),
    attestationEnv(),
    SITES,
    { store, now: () => new Date("2026-07-11T18:01:00.000Z") },
  );
  assert.equal(completedResponse.status, 200);
  const completedPayload = await completedResponse.json();
  const completed = completedPayload.trip;
  assert.equal(completedPayload.forecastAttributionCleared, false);
  assert.equal(completed.opportunityWindowId, "oyster-point--20260711T1600Z");
  assert.equal(completed.opportunityScore, 84);
  assert.equal(completed.modelVersion, `heuristic-california-halibut-${ATTESTATION_SCORING_SHA}`);
  assert.equal(completed.scoreInfluencedChoice, true);
  assert.equal(completed.anglerHours, 4);
  assert.equal(completed.halibutEncounters, 3);
  assert.equal(completed.noCatch, false);
  assert.equal(completed.observationContractVersion, "castingcompass.observation/2.0.0");
  assert.equal(completed.taxonCatalogVersion, "castingcompass.taxa/1.0.0");
  assert.equal(completed.targetTaxonId, "california-halibut");
  assert.equal(completed.contractStatus, "valid");
  assert.equal(completed.outcomeClass, "target_encountered");
  assert.equal(completed.targetEncounterCount, 3);
  assert.equal(completed.anyFishEncounterCount, 3);
  assert.equal(completed.targetIdentificationConfidence, "self_reported");
  assert.deepEqual(completed.taxonObservations, [{
    taxon_id: "california-halibut",
    encounter_count: 3,
    retained_count: 1,
    released_count: 2,
    disposition_unknown_count: 0,
    identification_confidence: "self_reported",
    identification_basis: "angler-report",
  }]);
  assert.equal(completed.moderationStatus, "pending");

  const persisted = store.trips.get(started.trip.id);
  assert.equal(persisted.token_hash, null);
  const completionEvent = store.completionEvents.get(started.trip.id);
  assert.equal(completionEvent.completeAttemptConfirmed, true);
  assert.equal(completionEvent.primaryTargetConfirmed, true);
  assert.equal(completionEvent.consentedAt, "2026-07-11T18:01:00.000Z");
  assert.equal(completionEvent.consentVersion, "castingcompass.trip-validation-consent/1.0.0");
  assert.equal("latitude" in persisted, false);
  assert.equal("ip" in persisted, false);
  assert.equal("social_identity" in persisted, false);
});

test("sealed activation enables observational secondary only, never primary evidence", async () => {
  const store = new MemoryTripStore();
  const windowId = "oyster-point--20260801T1000Z";
  const env = {
    ...attestationEnv({
      windowId,
      start: "2026-08-01T10:00:00Z",
      end: "2026-08-01T12:00:00Z",
    }),
    VALIDATION_OBSERVATIONAL_SECONDARY_ENABLED: "true",
    VALIDATION_PROTOCOL_ID: "california-halibut-site-window-v1",
    VALIDATION_COHORT_ID: "california-halibut-site-window-observational-secondary-v1",
    VALIDATION_ACTIVATION_MANIFEST_SHA256: "d".repeat(64),
    VALIDATION_ACTIVATED_AT: "2026-07-31T23:59:00Z",
    VALIDATION_ACTIVATION_SCORING_SHA256: ATTESTATION_SCORING_SHA,
  };
  const startResponse = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({
      startedAt: "2026-08-01T10:30:00.000Z",
      opportunityWindowId: windowId,
      scoreInfluencedChoice: false,
      anglerCount: 3,
    })),
    env,
    SITES,
    { store, now: () => new Date("2026-08-01T10:31:00.000Z") },
  );
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  assert.equal(started.trip.startedAt, "2026-08-01T10:31:00.000Z");
  const enrollment = store.validations.get(started.trip.id).provenance;
  assert.equal(enrollment.sourceRole, "prospective_secondary");
  assert.equal(enrollment.evidenceStatus, "secondary_pending_review");
  assert.equal(enrollment.validationProtocolId, "california-halibut-site-window-v1");
  assert.equal(enrollment.activationManifestSha256, "d".repeat(64));
  assert.equal(enrollment.activatedAt, "2026-07-31T23:59:00.000Z");
  assert.equal(enrollment.activationScoringSystemSha256, ATTESTATION_SCORING_SHA);
  assert.equal(enrollment.cohortId, "california-halibut-site-window-observational-secondary-v1");
  assert.equal(enrollment.incentivePolicyId, "none-v1");
  assert.match(enrollment.assignmentId, /^assignment-[a-f0-9]{64}$/);
  assert.match(enrollment.sourceRecordSha256, /^[a-f0-9]{64}$/);
  assert.match(enrollment.effortSegmentId, /^effort-[a-f0-9]{64}$/);
  assert.equal(enrollment.effortUnit, "whole-trip-group-attempt");
  assert.equal(enrollment.attemptCount, 1);
  assert.equal(enrollment.targetTaxonId, "california-halibut");
  assert.equal(enrollment.segmentStartAt, "2026-08-01T10:31:00.000Z");
  assert.equal(
    enrollment.sourceRecordSha256,
    createHash("sha256")
      .update(`castingcompass.validation-source-record/1.0.0\u0000${started.trip.id}`)
      .digest("hex"),
  );
  assert.equal(
    enrollment.effortSegmentId,
    `effort-${createHash("sha256")
      .update(`castingcompass.validation-effort-segment/1.0.0\u0000${started.trip.id}`)
      .digest("hex")}`,
  );
  assert.equal(
    enrollment.assignmentId,
    `assignment-${createHash("sha256")
      .update(`castingcompass.validation-assignment/1.0.0\u0000${enrollment.validationProtocolId}\u0000${enrollment.sourceRecordSha256}`)
      .digest("hex")}`,
  );
  assert.equal(enrollment.scoreInfluencedChoice, false);
  assert.match(enrollment.participantGroupId, /^participant-[a-f0-9]{64}$/);
  const reporterHash = store.trips.get(started.trip.id).reporter_key_hash;
  assert.notEqual(enrollment.participantGroupId, reporterHash);
  assert.equal(
    enrollment.participantGroupId,
    `participant-${createHash("sha256")
      .update(`castingcompass.validation-participant/1.0.0\u0000${reporterHash}`)
      .digest("hex")}`,
  );
  assert.equal(enrollment.recruitmentFrameId, "california-halibut-site-window-recruitment-v1");
  assert.equal(enrollment.recruitmentSourceId, "castingcompass-organic-product");
  assert.equal(enrollment.recruitmentEventContractVersion, "castingcompass.recruitment-event/1.0.0");
  assert.equal(enrollment.recruitmentEventAt, "2026-08-01T10:31:00.000Z");
  const recruitmentPayload = JSON.stringify({
    community_approval_sha256: null,
    participant_group_id: enrollment.participantGroupId,
    recruitment_event_at: enrollment.recruitmentEventAt,
    recruitment_frame_id: enrollment.recruitmentFrameId,
    recruitment_source_id: enrollment.recruitmentSourceId,
  });
  assert.equal(
    enrollment.recruitmentEventSha256,
    createHash("sha256").update(recruitmentPayload).digest("hex"),
  );
  assert.notEqual(enrollment.sourceRole, "primary");

  const completion = new FormData();
  completion.set("token", started.token);
  completion.set("endedAt", "2026-08-01T10:45:00.000Z");
  completion.set("keeperCount", "0");
  completion.set("shortReleasedCount", "0");
  addRequiredCompletionFields(completion, { mode: "pier", includeInfluence: false });
  const completedResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${started.trip.id}/complete`, completion),
    env,
    SITES,
    { store, now: () => new Date("2026-08-01T11:31:00.000Z") },
  );
  assert.equal(completedResponse.status, 200);
  const completedTrip = (await completedResponse.json()).trip;
  assert.equal(completedTrip.endedAt, "2026-08-01T11:31:00.000Z");
  const completionEvent = store.completionEvents.get(started.trip.id);
  assert.equal(completionEvent.sourceRole, "prospective_secondary");
  assert.equal(completionEvent.evidenceStatus, "secondary_pending_review");
  assert.equal(completionEvent.completeAttemptConfirmed, true);
  assert.equal(completionEvent.consentedAt, "2026-08-01T11:31:00.000Z");
  assert.equal(completionEvent.participantGroupId, enrollment.participantGroupId);
  assert.equal(completionEvent.recruitmentEventSha256, enrollment.recruitmentEventSha256);
  assert.equal(completionEvent.assignmentId, enrollment.assignmentId);
  assert.equal(completionEvent.sourceRecordSha256, enrollment.sourceRecordSha256);
  assert.equal(completionEvent.effortSegmentId, enrollment.effortSegmentId);
  assert.equal(completionEvent.effortUnit, "whole-trip-group-attempt");
  assert.equal(completionEvent.attemptCount, 1);
  assert.equal(completionEvent.segmentStartAt, "2026-08-01T10:31:00.000Z");
  assert.equal(completionEvent.segmentEndAt, "2026-08-01T11:31:00.000Z");
  assert.equal(completionEvent.modeAtCompletion, "pier");
  assert.equal(completionEvent.anglerCount, 3);
  assert.equal(completionEvent.durationMilliseconds, 3_600_000);
  assert.equal(completionEvent.personMilliseconds, 10_800_000);
  assert.equal(completionEvent.completionEventContractVersion, "castingcompass.validation-completion-event/1.0.0");
  assert.equal(completionEvent.completionEventAt, "2026-08-01T11:31:00.000Z");
  assert.equal(completionEvent.completionConsentVersion, "castingcompass.trip-validation-consent/1.0.0");
  assert.equal(completionEvent.completionConsentedAt, "2026-08-01T11:31:00.000Z");
  assert.equal(completionEvent.completionPrimaryTargetConfirmed, true);
  assert.equal(completionEvent.completionCompleteAttemptConfirmed, true);
  const canonicalCompletionEvent = JSON.stringify({
    activation_manifest_sha256: enrollment.activationManifestSha256,
    angler_count: 3,
    assignment_id: enrollment.assignmentId,
    attempt_count: 1,
    cohort_id: enrollment.cohortId,
    completion_complete_attempt_confirmed: true,
    completion_consent_version: "castingcompass.trip-validation-consent/1.0.0",
    completion_consented_at: "2026-08-01T11:31:00.000Z",
    completion_event_at: "2026-08-01T11:31:00.000Z",
    completion_event_contract_version: "castingcompass.validation-completion-event/1.0.0",
    completion_primary_target_confirmed: true,
    duration_milliseconds: 3_600_000,
    effort_segment_id: enrollment.effortSegmentId,
    effort_unit: "whole-trip-group-attempt",
    incentive_policy_id: "none-v1",
    mode: "pier",
    participant_group_id: enrollment.participantGroupId,
    person_milliseconds: 10_800_000,
    segment_end_at: "2026-08-01T11:31:00.000Z",
    segment_start_at: "2026-08-01T10:31:00.000Z",
    source_record_sha256: enrollment.sourceRecordSha256,
    target_taxon_id: "california-halibut",
  });
  assert.equal(
    completionEvent.completionEventSha256,
    createHash("sha256").update(canonicalCompletionEvent).digest("hex"),
  );
  assert.notEqual(completionEvent.sourceRole, "primary");

  const repeatedStartResponse = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({
      startedAt: "2026-08-01T11:40:00.000Z",
      opportunityWindowId: windowId,
      scoreInfluencedChoice: true,
    })),
    env,
    SITES,
    { store, now: () => new Date("2026-08-01T11:40:00.000Z") },
  );
  assert.equal(repeatedStartResponse.status, 201);
  const repeatedTrip = (await repeatedStartResponse.json()).trip;
  const repeatedEnrollment = store.validations.get(repeatedTrip.id).provenance;
  assert.equal(repeatedEnrollment.sourceRole, "prospective_secondary");
  assert.equal(repeatedEnrollment.participantGroupId, enrollment.participantGroupId);
  assert.equal(repeatedEnrollment.recruitmentEventAt, enrollment.recruitmentEventAt);
  assert.equal(repeatedEnrollment.recruitmentEventSha256, enrollment.recruitmentEventSha256);
});

test("stale live starts are rejected and preactivation context cannot seed recruitment", async () => {
  const store = new MemoryTripStore();
  const reporterKey = "recruitment-gating-device-key-123456";
  const preactivation = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({
      startedAt: "2026-07-31T22:00:00.000Z",
      reporterKey,
    })),
    {},
    SITES,
    { store, now: () => new Date("2026-07-31T22:00:00.000Z") },
  );
  assert.equal(preactivation.status, 201);
  const preactivationTrip = (await preactivation.json()).trip;
  const preactivationEnrollment = store.validations.get(preactivationTrip.id).provenance;
  assert.equal(preactivationEnrollment.sourceRole, "context_only");
  assert.equal(preactivationEnrollment.participantGroupId, null);
  assert.equal(preactivationEnrollment.recruitmentEventSha256, null);

  const windowId = "oyster-point--20260801T1000Z";
  const env = {
    ...attestationEnv({
      windowId,
      start: "2026-08-01T10:00:00Z",
      end: "2026-08-01T12:00:00Z",
    }),
    VALIDATION_OBSERVATIONAL_SECONDARY_ENABLED: "true",
    VALIDATION_PROTOCOL_ID: "california-halibut-site-window-v1",
    VALIDATION_COHORT_ID: "california-halibut-site-window-observational-secondary-v1",
    VALIDATION_ACTIVATION_MANIFEST_SHA256: "d".repeat(64),
    VALIDATION_ACTIVATED_AT: "2026-07-31T23:59:00Z",
    VALIDATION_ACTIVATION_SCORING_SHA256: ATTESTATION_SCORING_SHA,
  };
  const underwayResponse = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({
      startedAt: "2026-08-01T10:25:00.000Z",
      opportunityWindowId: windowId,
      reporterKey,
    })),
    env,
    SITES,
    { store, now: () => new Date("2026-08-01T10:31:00.000Z") },
  );
  assert.equal(underwayResponse.status, 422);
  assert.equal((await underwayResponse.json()).error.code, "live_start_must_be_now");

  const eligibleResponse = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({
      startedAt: "2026-08-01T10:40:00.000Z",
      opportunityWindowId: windowId,
      reporterKey,
    })),
    env,
    SITES,
    { store, now: () => new Date("2026-08-01T10:40:00.000Z") },
  );
  assert.equal(eligibleResponse.status, 201);
  const eligibleTrip = (await eligibleResponse.json()).trip;
  const eligibleEnrollment = store.validations.get(eligibleTrip.id).provenance;
  assert.equal(eligibleEnrollment.sourceRole, "prospective_secondary");
  assert.equal(eligibleEnrollment.recruitmentEventAt, "2026-08-01T10:40:00.000Z");
  assert.match(eligibleEnrollment.participantGroupId, /^participant-[a-f0-9]{64}$/);
  assert.notEqual(
    eligibleEnrollment.participantGroupId,
    store.trips.get(eligibleTrip.id).reporter_key_hash,
  );
});

test("missing, late, or scoring-mismatched activation fails closed to context", async () => {
  const windowId = "oyster-point--20260801T1000Z";
  const baseEnv = {
    ...attestationEnv({
      windowId,
      start: "2026-08-01T10:00:00Z",
      end: "2026-08-01T12:00:00Z",
    }),
    VALIDATION_OBSERVATIONAL_SECONDARY_ENABLED: "true",
    VALIDATION_PROTOCOL_ID: "california-halibut-site-window-v1",
    VALIDATION_COHORT_ID: "california-halibut-site-window-observational-secondary-v1",
    VALIDATION_ACTIVATION_MANIFEST_SHA256: "d".repeat(64),
    VALIDATION_ACTIVATED_AT: "2026-07-31T23:59:00Z",
    VALIDATION_ACTIVATION_SCORING_SHA256: ATTESTATION_SCORING_SHA,
  };
  const variants = [
    { ...baseEnv, VALIDATION_ACTIVATION_MANIFEST_SHA256: undefined },
    { ...baseEnv, VALIDATION_ACTIVATED_AT: "2026-08-01T00:00:01Z" },
    { ...baseEnv, VALIDATION_ACTIVATION_SCORING_SHA256: "e".repeat(64) },
    { ...baseEnv, VALIDATION_COHORT_ID: "organic-score-visible-v1" },
  ];
  for (const [index, env] of variants.entries()) {
    const store = new MemoryTripStore();
    const response = await handleTripRequest(
      jsonRequest("/api/trips/start", validStartBody({
        startedAt: "2026-08-01T10:30:00.000Z",
        opportunityWindowId: windowId,
        reporterKey: `activation-negative-device-key-${index}-123456`,
      })),
      env,
      SITES,
      { store, now: () => new Date("2026-08-01T10:31:00.000Z") },
    );
    assert.equal(response.status, 201);
    const trip = (await response.json()).trip;
    const enrollment = store.validations.get(trip.id).provenance;
    assert.equal(enrollment.sourceRole, "context_only");
    assert.equal(enrollment.evidenceStatus, "context_only");
    assert.equal(enrollment.validationProtocolId, null);
    assert.equal(enrollment.activationManifestSha256, null);
  }
});

test("required confirmations fail closed and pre-trip influence is immutable", async () => {
  const missingInfluence = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({ scoreInfluencedChoice: undefined })),
    {},
    SITES,
    { store: new MemoryTripStore() },
  );
  assert.equal(missingInfluence.status, 422);
  assert.equal((await missingInfluence.json()).error.code, "score_influence_required");

  const store = new MemoryTripStore();
  const start = await handleTripRequest(
    jsonRequest("/api/trips/start", validStartBody({
      startedAt: "2026-07-11T17:59:00.000Z",
      scoreInfluencedChoice: true,
    })),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );
  assert.equal(start.status, 201);
  const started = await start.json();

  const missingConsent = new FormData();
  missingConsent.set("token", started.token);
  missingConsent.set("endedAt", "2026-07-11T18:30:00.000Z");
  missingConsent.set("mode", "pier");
  missingConsent.set("primaryTargetConfirmed", "true");
  missingConsent.set("completeAttempt", "true");
  const missingConsentResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${started.trip.id}/complete`, missingConsent),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:31:00.000Z") },
  );
  assert.equal(missingConsentResponse.status, 422);
  assert.equal((await missingConsentResponse.json()).error.code, "consent_required");

  const changedInfluence = new FormData();
  changedInfluence.set("token", started.token);
  changedInfluence.set("endedAt", "2026-07-11T18:30:00.000Z");
  addRequiredCompletionFields(changedInfluence, { mode: "pier", includeInfluence: false });
  changedInfluence.set("scoreInfluencedChoice", "false");
  const changedInfluenceResponse = await handleTripRequest(
    multipartRequest(`/api/trips/${started.trip.id}/complete`, changedInfluence),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:31:00.000Z") },
  );
  assert.equal(changedInfluenceResponse.status, 422);
  assert.equal((await changedInfluenceResponse.json()).error.code, "score_influence_immutable");
  assert.equal(store.trips.get(started.trip.id).score_influenced_choice, 1);
});

test("non-target catch is not mislabeled as no-fish and remains taxonomically unresolved", async () => {
  const store = new MemoryTripStore();
  const form = new FormData();
  form.set("siteId", "crissy-field");
  form.set("startedAt", "2026-07-10T15:00:00.000Z");
  form.set("endedAt", "2026-07-10T18:00:00.000Z");
  form.set("keeperCount", "0");
  form.set("shortReleasedCount", "0");
  form.set("otherCatchCount", "2");
  form.set("otherSpecies", "surfperch");
  form.set("consent", "true");
  form.set("reporterKey", "non-target-device-key-1234567890");
  form.set("website", "");
  addRequiredCompletionFields(form, { mode: "beach" });

  const response = await handleTripRequest(
    multipartRequest("/api/trips/report", form),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );

  assert.equal(response.status, 201);
  const trip = (await response.json()).trip;
  assert.equal(trip.noCatch, false);
  assert.equal(trip.outcomeClass, "non_target_only");
  assert.equal(trip.targetEncounterCount, 0);
  assert.equal(trip.anyFishEncounterCount, 2);
  assert.equal(trip.targetIdentificationConfidence, "not_observed");
  assert.deepEqual(trip.taxonObservations, [
    {
      taxon_id: "california-halibut",
      encounter_count: 0,
      retained_count: 0,
      released_count: 0,
      disposition_unknown_count: 0,
      identification_confidence: "not_observed",
      identification_basis: "not-observed",
    },
    {
      taxon_id: "unresolved-fish",
      encounter_count: 2,
      retained_count: 0,
      released_count: 0,
      disposition_unknown_count: 2,
      identification_confidence: "unresolved",
      identification_basis: "unresolved",
    },
  ]);
});

test("server controls species target, versions, and structured outcomes", async () => {
  const store = new MemoryTripStore();
  const snakeOverride = await handleTripRequest(
    jsonRequest("/api/trips/start", {
      ...validStartBody(),
      reporterKey: "server-contract-device-key-1234",
      target_taxon_id: "unresolved-fish",
    }),
    {},
    SITES,
    { store },
  );
  assert.equal(snakeOverride.status, 422);
  assert.equal((await snakeOverride.json()).error.code, "observation_contract_override_forbidden");

  const form = new FormData();
  form.set("siteId", "crissy-field");
  form.set("startedAt", "2026-07-10T15:00:00.000Z");
  form.set("endedAt", "2026-07-10T18:00:00.000Z");
  form.set("keeperCount", "0");
  form.set("shortReleasedCount", "0");
  form.set("consent", "true");
  form.set("reporterKey", "server-contract-device-key-5678");
  form.set("taxonObservations", "[]");
  form.set("temporal_precision", "exact");
  addRequiredCompletionFields(form, { mode: "beach" });
  const camelOverride = await handleTripRequest(
    multipartRequest("/api/trips/report", form),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );
  assert.equal(camelOverride.status, 422);
  assert.equal((await camelOverride.json()).error.code, "observation_contract_override_forbidden");

  const nestedSourceOverride = await handleTripRequest(
    jsonRequest("/api/trips/start", {
      ...validStartBody(),
      reporterKey: "server-contract-device-key-9012",
      source: { data_kind: "synthetic-fixture", complete_attempt: true },
    }),
    {},
    SITES,
    { store },
  );
  assert.equal(nestedSourceOverride.status, 422);
  assert.equal((await nestedSourceOverride.json()).error.code, "observation_contract_override_forbidden");
  assert.equal(store.trips.size, 0);
});

test("current reports are bounded and exact precision requires an explicit trusted signal", () => {
  const base = {
    tripId: "trip_00000000-0000-4000-8000-000000000001",
    siteId: "crissy-field",
    startedAt: "2026-07-10T15:00:00.000Z",
    endedAt: "2026-07-10T18:00:00.000Z",
    mode: "beach",
    anglerHours: 3,
    keeperCount: 0,
    shortReleasedCount: 0,
    otherCatchCount: 0,
  };
  assert.equal(buildSpeciesObservationContract(base).temporal_support.precision, "bounded");
  assert.equal(buildSpeciesObservationContract({ ...base, temporalPrecision: "exact" }).temporal_support.precision, "exact");
});

test("past reports re-encode photos and the summary exposes validation totals", async () => {
  const store = new MemoryTripStore();
  const storedObjects = new Map();
  const env = {
    TRIP_PHOTO_UPLOADS_ENABLED: "true",
    IMAGES: {
      input() {
        return {
          transform() {
            return {
              async output() {
                return {
                  response: () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
                };
              },
            };
          },
        };
      },
    },
    TRIP_PHOTOS: {
      async put(key, bytes, options) {
        storedObjects.set(key, { bytes: new Uint8Array(bytes), options });
      },
      async delete(key) {
        storedObjects.delete(key);
      },
    },
  };

  const form = new FormData();
  form.set("siteId", "crissy-field");
  form.set("startedAt", "2026-07-10T15:00:00.000Z");
  form.set("endedAt", "2026-07-10T18:00:00.000Z");
  form.set("keeperCount", "0");
  form.set("shortReleasedCount", "0");
  form.set("consent", "true");
  form.set("reporterKey", "another-anonymous-device-key-1234");
  form.set("contourCastInfluenced", "false");
  form.set("predictionMetadata", JSON.stringify({
    snapshotGeneratedAt: "2026-07-11T17:00:00.000Z",
    forecastStart: "2026-07-11T18:00:00.000Z",
    forecastEnd: "2026-07-11T20:00:00.000Z",
    confidence: "medium",
    latitude: 37.7,
    email: "private@example.com",
    forecastConditions: {
      windMph: 12,
      currentDirection: "SW",
      longitude: -122.4,
      accountId: "private-account",
    },
  }));
  form.set("website", "");
  addRequiredCompletionFields(form, { mode: "beach" });
  form.set(
    "photo",
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "catch.png", {
      type: "image/png",
    }),
  );

  const response = await handleTripRequest(
    multipartRequest("/api/trips/report", form),
    env,
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );
  assert.equal(response.status, 201);
  const reported = (await response.json()).trip;
  assert.equal(reported.noCatch, true);
  assert.equal(reported.outcomeClass, "no_fish");
  assert.equal(reported.targetEncounterCount, 0);
  assert.equal(reported.anyFishEncounterCount, 0);
  assert.equal(reported.targetIdentificationConfidence, "not_observed");
  assert.equal(reported.hasPhoto, true);
  assert.equal(reported.scoreInfluencedChoice, false);
  assert.equal(storedObjects.size, 1);
  const storedPhoto = [...storedObjects.values()][0];
  assert.equal(storedPhoto.options.httpMetadata.contentType, "image/webp");
  assert.equal(storedPhoto.options.customMetadata.privacy, "exif-stripped");
  assert.equal(store.trips.get(reported.id).prediction_metadata_json, null);
  assert.equal(reported.opportunityWindowId, null);
  assert.equal(store.validations.get(reported.id).provenance.sourceRole, "context_only");
  assert.equal(store.validations.get(reported.id).provenance.attestationStatus, "not_applicable_retrospective");

  const summaryResponse = await handleTripRequest(
    new Request(`${ORIGIN}/api/trips/summary`),
    env,
    SITES,
    { store, now: () => new Date("2026-07-11T19:00:00.000Z") },
  );
  assert.deepEqual(await summaryResponse.json(), {
    completedTrips: 1,
    noCatchTrips: 1,
    halibutTrips: 0,
    totalHalibut: 0,
    anglerHours: 3,
    halibutEncounters: 0,
    sitesCovered: 1,
    lastUpdated: "2026-07-11T18:00:00.000Z",
    past24Hours: {
      completedTrips: 1,
      anglerHours: 3,
      halibutEncounters: 0,
      sitesCovered: 1,
    },
  });
});

test("photo uploads fail closed at the Worker even when storage bindings exist", async () => {
  const store = new MemoryTripStore();
  let imageCalls = 0;
  let storageCalls = 0;
  const form = new FormData();
  form.set("siteId", "crissy-field");
  form.set("startedAt", "2026-07-10T15:00:00.000Z");
  form.set("endedAt", "2026-07-10T18:00:00.000Z");
  form.set("keeperCount", "0");
  form.set("shortReleasedCount", "0");
  form.set("consent", "true");
  form.set("reporterKey", "server-photo-gate-device-key-1234");
  form.set("website", "");
  addRequiredCompletionFields(form, { mode: "beach" });
  form.set("photo", new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ], "catch.png", { type: "image/png" }));

  const response = await handleTripRequest(
    multipartRequest("/api/trips/report", form),
    {
      IMAGES: {
        input() {
          imageCalls += 1;
          throw new Error("disabled uploads must not reach image processing");
        },
      },
      TRIP_PHOTOS: {
        async put() { storageCalls += 1; },
        async delete() { storageCalls += 1; },
      },
    },
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "photo_uploads_disabled");
  assert.equal(imageCalls, 0);
  assert.equal(storageCalls, 0);
  assert.equal(store.trips.size, 0);
});

test("past reports ignore client-supplied forecast identity and metadata", async () => {
  const store = new MemoryTripStore();
  const form = new FormData();
  form.set("siteId", "crissy-field");
  form.set("startedAt", "2026-07-10T15:00:00.000Z");
  form.set("endedAt", "2026-07-10T18:00:00.000Z");
  form.set("keeperCount", "0");
  form.set("shortReleasedCount", "0");
  form.set("consent", "true");
  form.set("reporterKey", "oversized-metadata-device-key-1234");
  form.set("predictionMetadata", JSON.stringify({ ignored: "x".repeat(5000) }));
  form.set("opportunityWindowId", "forged-window");
  form.set("opportunityScore", "100");
  form.set("modelVersion", "forged-model");
  form.set("website", "");
  addRequiredCompletionFields(form, { mode: "beach" });

  const response = await handleTripRequest(
    multipartRequest("/api/trips/report", form),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );

  assert.equal(response.status, 201);
  const trip = (await response.json()).trip;
  assert.equal(trip.opportunityWindowId, null);
  assert.equal(trip.opportunityScore, null);
  assert.equal(trip.modelVersion, null);
  assert.equal(store.trips.get(trip.id).prediction_metadata_json, null);
});

test("honeypot submissions are rejected without persistence", async () => {
  const store = new MemoryTripStore();
  const response = await handleTripRequest(
    jsonRequest("/api/trips/start", {
      siteId: "oyster-point",
      consent: true,
      reporterKey: "a".repeat(32),
      website: "https://spam.example",
    }),
    {},
    SITES,
    { store },
  );
  assert.equal(response.status, 422);
  assert.equal(store.trips.size, 0);
});

test("trip mutations reject unknown JSON fields and ambiguous multipart duplicates", async () => {
  const store = new MemoryTripStore();
  const unknown = await handleTripRequest(
    jsonRequest("/api/trips/start", {
      ...validStartBody(),
      admin: true,
    }),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );
  assert.equal(unknown.status, 422);
  assert.equal((await unknown.json()).error.code, "unexpected_fields");
  assert.equal(store.trips.size, 0);

  const coerced = await handleTripRequest(
    jsonRequest("/api/trips/start", {
      ...validStartBody(),
      anglerCount: true,
    }),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );
  assert.equal(coerced.status, 422);
  assert.equal((await coerced.json()).error.code, "invalid_anglerCount");
  assert.equal(store.trips.size, 0);

  const duplicate = new FormData();
  duplicate.set("siteId", "crissy-field");
  duplicate.append("siteId", "oyster-point");
  duplicate.set("startedAt", "2026-07-10T15:00:00.000Z");
  duplicate.set("endedAt", "2026-07-10T18:00:00.000Z");
  duplicate.set("keeperCount", "0");
  duplicate.set("shortReleasedCount", "0");
  duplicate.set("consent", "true");
  duplicate.set("reporterKey", "duplicate-field-device-key-12345");
  duplicate.set("website", "");
  addRequiredCompletionFields(duplicate, { mode: "beach" });
  const ambiguous = await handleTripRequest(
    multipartRequest("/api/trips/report", duplicate),
    {},
    SITES,
    { store, now: () => new Date("2026-07-11T18:00:00.000Z") },
  );
  assert.equal(ambiguous.status, 422);
  assert.equal((await ambiguous.json()).error.code, "duplicate_fields");
  assert.equal(store.trips.size, 0);
});
