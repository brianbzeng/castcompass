import {
  assertObservationContract,
  CALIFORNIA_HALIBUT_TAXON_ID,
  deriveObservationOutcomeClass,
  OBSERVATION_CONTRACT_VERSION,
  TAXON_CATALOG_VERSION,
  UNRESOLVED_FISH_TAXON_ID,
} from "../shared/species-contract.ts";
import {
  DEFAULT_INCENTIVE_POLICY_ID,
  DEFAULT_VALIDATION_COHORT_ID,
  OPPORTUNITY_ATTESTATION_INDEX_VERSION,
  TRIP_VALIDATION_CONSENT_VERSION,
  VALIDATION_COLLECTION_CONTRACT_VERSION,
  verifyOpportunityAttestation,
  type AssetFetcherLike,
  type AttestedOpportunity,
  type OpportunityAttestationStatus,
} from "./validation.ts";
import {
  buildFeasibilityCancellationEvent,
  buildFeasibilityCompletionEvent,
  buildFeasibilityStartEvent,
  feasibilityPilotEnabled,
  feasibilityRecruitmentCampaignReference,
  resolveFeasibilityContext,
  resolveFeasibilityRecruitment,
  type FeasibilityEventRecord,
  type FeasibilityRecruitmentRecord,
  type FeasibilityRuntimeEnv,
  type SafeCancellationReason,
  type StoredFeasibilityActivation,
  type StoredFeasibilityRecruitment,
  type StoredFeasibilityRecruitmentCampaign,
  type StoredFeasibilityStart,
} from "./validation-feasibility.ts";
import { logEvent } from "./observability.ts";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_PHOTO_BYTES + 1024 * 1024;
const REPORTER_COOKIE = "cc_reporter";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_MODES = new Set(["shore", "beach", "pier", "jetty", "kayak", "boat", "other"]);
const TRIP_DETAIL_FIELDS = [
  "gear",
  "gearProfileId",
  "rod",
  "reel",
  "baitLure",
  "rig",
  "otherCatchCount",
  "otherSpecies",
  "shorebreak",
  "wadingDepth",
  "waterClarity",
  "crowding",
  "fishabilityRating",
  "observedWaveHeightFeet",
  "fishabilityNotes",
] as const;
// Previously shipped clients sent these forecast-derived values. They remain
// accepted as inert compatibility fields; only a server-verified opportunity
// attestation can populate forecast attribution.
const LEGACY_CLIENT_FORECAST_FIELDS = [
  "opportunityScore",
  "habitatScore",
  "seasonalityScore",
  "conditionsScore",
  "fishabilityScore",
  "modelVersion",
  "predictionMetadata",
] as const;
const LIVE_START_FIELDS = [
  "clientTripId",
  "requestToken",
  "siteId",
  "startedAt",
  "anglerCount",
  "mode",
  "fishingMethod",
  "method",
  ...TRIP_DETAIL_FIELDS,
  "scoreInfluencedChoice",
  "contourCastInfluenced",
  "primaryTargetConfirmed",
  "reporterKey",
  "consent",
  "website",
  "referralCode",
  "opportunityWindowId",
  ...LEGACY_CLIENT_FORECAST_FIELDS,
  "studyConsent",
  "studyConsentVersion",
  "recruitmentToken",
] as const;
const LIVE_COMPLETION_FIELDS = [
  "token",
  "endedAt",
  "reporterKey",
  "anglerCount",
  "mode",
  "fishingMethod",
  "method",
  ...TRIP_DETAIL_FIELDS,
  "scoreInfluencedChoice",
  "contourCastInfluenced",
  "keeperCount",
  "shortReleasedCount",
  "notes",
  "consent",
  "primaryTargetConfirmed",
  "completeAttempt",
  "website",
  "photo",
  "opportunityWindowId",
  ...LEGACY_CLIENT_FORECAST_FIELDS,
] as const;
const PAST_REPORT_FIELDS = [
  "clientTripId",
  "requestToken",
  "siteId",
  "startedAt",
  "endedAt",
  "anglerCount",
  "mode",
  "fishingMethod",
  "method",
  ...TRIP_DETAIL_FIELDS,
  "scoreInfluencedChoice",
  "contourCastInfluenced",
  "keeperCount",
  "shortReleasedCount",
  "notes",
  "reporterKey",
  "referralCode",
  "consent",
  "primaryTargetConfirmed",
  "completeAttempt",
  "website",
  "photo",
  "opportunityWindowId",
  ...LEGACY_CLIENT_FORECAST_FIELDS,
] as const;
const VALIDATION_ELIGIBLE_MODES = new Set(["shore", "beach", "pier", "jetty"]);
const VALIDATION_PROTOCOL_ID = "california-halibut-site-window-v1";
const VALIDATION_SECONDARY_COHORT_ID =
  "california-halibut-site-window-observational-secondary-v1" as const;
const VALIDATION_ENROLLMENT_START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const VALIDATION_ENROLLMENT_END_EXCLUSIVE_MS = Date.parse("2027-08-01T00:00:00.000Z");
// datetime-local inputs round to a minute; requests within this bound are bound to server receipt time.
const MAX_LIVE_START_CLOCK_SKEW_MS = 90 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRIP_ID_PATTERN = /^trip_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,160}$/;
const CLIENT_REQUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STRICT_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RECRUITMENT_FRAME_ID = "california-halibut-site-window-recruitment-v1" as const;
const RECRUITMENT_EVENT_CONTRACT_VERSION = "castingcompass.recruitment-event/1.0.0" as const;
const ORGANIC_RECRUITMENT_SOURCE_ID = "castingcompass-organic-product" as const;
const VALIDATION_PARTICIPANT_TOKEN_DOMAIN = "castingcompass.validation-participant/1.0.0" as const;
const VALIDATION_SOURCE_RECORD_DOMAIN = "castingcompass.validation-source-record/1.0.0" as const;
const VALIDATION_EFFORT_SEGMENT_DOMAIN = "castingcompass.validation-effort-segment/1.0.0" as const;
const VALIDATION_ASSIGNMENT_DOMAIN = "castingcompass.validation-assignment/1.0.0" as const;
const VALIDATION_COMPLETION_EVENT_CONTRACT_VERSION =
  "castingcompass.validation-completion-event/1.0.0" as const;
const VALIDATION_EFFORT_UNIT = "whole-trip-group-attempt" as const;
const ALLOWED_RECRUITMENT_SOURCE_IDS = new Set([
  ORGANIC_RECRUITMENT_SOURCE_ID,
  "direct-opt-in-research-invite",
  "admin-approved-community-prospective",
]);

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface ImageBindingLike {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
}

export interface TripApiEnv extends FeasibilityRuntimeEnv {
  DB?: D1DatabaseLike;
  ASSETS?: AssetFetcherLike;
  TRIP_PHOTOS?: R2BucketLike;
  IMAGES?: ImageBindingLike;
  TRIP_PHOTO_UPLOADS_ENABLED?: string;
  /** Enables only organic score-visible observational-secondary collection; never primary evidence. */
  VALIDATION_OBSERVATIONAL_SECONDARY_ENABLED?: string;
  VALIDATION_COHORT_ID?: string;
  VALIDATION_PROTOCOL_ID?: string;
  VALIDATION_ACTIVATION_MANIFEST_SHA256?: string;
  VALIDATION_ACTIVATED_AT?: string;
  VALIDATION_ACTIVATION_SCORING_SHA256?: string;
}

export interface CuratedSite {
  id: string;
  type?: string;
}

export interface TripRow {
  id: string;
  user_id: string | null;
  status: "active" | "completed";
  source: "live" | "past_report";
  site_id: string;
  started_at: string;
  ended_at: string | null;
  mode: string;
  fishing_method: string | null;
  gear: string | null;
  gear_profile_id: string | null;
  rod: string | null;
  reel: string | null;
  bait_lure: string | null;
  rig: string | null;
  angler_count: number;
  angler_hours: number | null;
  keeper_count: number | null;
  short_released_count: number | null;
  halibut_encounters: number | null;
  no_catch: number | null;
  other_catch_count: number | null;
  other_species: string | null;
  observations_json: string | null;
  observation_contract_version: string | null;
  taxon_catalog_version: string | null;
  target_taxon_id: string;
  contract_status: "valid" | "legacy_unverified" | "rejected" | null;
  taxon_observations_json: string | null;
  outcome_class: "target_encountered" | "non_target_only" | "no_fish" | null;
  target_encounter_count: number | null;
  any_fish_encounter_count: number | null;
  target_identification_confidence: string | null;
  notes: string | null;
  consent: number;
  consent_at: string | null;
  moderation_status: "pending" | "approved" | "rejected";
  reporter_key_hash: string;
  referral_code: string | null;
  token_hash: string | null;
  idempotency_key_hash: string | null;
  opportunity_window_id: string | null;
  opportunity_score: number | null;
  habitat_score: number | null;
  seasonality_score: number | null;
  conditions_score: number | null;
  fishability_score: number | null;
  model_version: string | null;
  score_influenced_choice: number | null;
  prediction_metadata_json: string | null;
  photo_key: string | null;
  photo_content_type: string | null;
  photo_size_bytes: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  ai_review_status: string | null;
  ai_review_json: string | null;
  ai_review_model: string | null;
  ai_reviewed_at: string | null;
}

interface NewTripRecord {
  id: string;
  userId: string | null;
  status: "active" | "completed";
  source: "live" | "past_report";
  siteId: string;
  startedAt: string;
  endedAt: string | null;
  mode: string;
  fishingMethod: string | null;
  gear: string | null;
  gearProfileId: string | null;
  rod: string | null;
  reel: string | null;
  baitLure: string | null;
  rig: string | null;
  anglerCount: number;
  anglerHours: number | null;
  keeperCount: number | null;
  shortReleasedCount: number | null;
  halibutEncounters: number | null;
  noCatch: boolean | null;
  otherCatchCount: number | null;
  otherSpecies: string | null;
  observationsJson: string | null;
  observationContractVersion: string | null;
  taxonCatalogVersion: string | null;
  targetTaxonId: string;
  contractStatus: "valid" | "legacy_unverified" | "rejected" | null;
  taxonObservationsJson: string | null;
  outcomeClass: "target_encountered" | "non_target_only" | "no_fish" | null;
  targetEncounterCount: number | null;
  anyFishEncounterCount: number | null;
  targetIdentificationConfidence: string | null;
  notes: string | null;
  consent: boolean;
  consentAt: string | null;
  moderationStatus: "pending";
  reporterKeyHash: string;
  referralCode: string | null;
  tokenHash: string | null;
  idempotencyKeyHash: string | null;
  opportunityWindowId: string | null;
  opportunityScore: number | null;
  habitatScore: number | null;
  seasonalityScore: number | null;
  conditionsScore: number | null;
  fishabilityScore: number | null;
  modelVersion: string | null;
  scoreInfluencedChoice: boolean | null;
  predictionMetadataJson: string | null;
  photoKey: string | null;
  photoContentType: string | null;
  photoSizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface CompletionRecord {
  endedAt: string;
  mode: string;
  fishingMethod: string | null;
  gear: string | null;
  gearProfileId: string | null;
  rod: string | null;
  reel: string | null;
  baitLure: string | null;
  rig: string | null;
  anglerCount: number;
  anglerHours: number;
  keeperCount: number;
  shortReleasedCount: number;
  halibutEncounters: number;
  noCatch: boolean;
  otherCatchCount: number;
  otherSpecies: string | null;
  observationsJson: string | null;
  observationContractVersion: string;
  taxonCatalogVersion: string;
  targetTaxonId: string;
  contractStatus: "valid";
  taxonObservationsJson: string;
  outcomeClass: "target_encountered" | "non_target_only" | "no_fish";
  targetEncounterCount: number;
  anyFishEncounterCount: number;
  targetIdentificationConfidence: string;
  notes: string | null;
  consentAt: string;
  photoKey: string | null;
  photoContentType: string | null;
  photoSizeBytes: number | null;
  updatedAt: string;
}

interface TripSummary {
  completedTrips: number;
  noCatchTrips: number;
  halibutTrips: number;
  totalHalibut: number;
  anglerHours: number;
  halibutEncounters: number;
  sitesCovered: number;
  lastUpdated: string | null;
  past24Hours: {
    completedTrips: number;
    anglerHours: number;
    halibutEncounters: number;
    sitesCovered: number;
  };
}

interface ForecastImpressionRecord extends AttestedOpportunity {
  id: string;
  tripId: string;
  attestedAt: string;
}

interface ValidationProvenanceRecord {
  id: string;
  tripId: string;
  eventType: "enrollment" | "completion" | "retrospective_submission" | "evidence_exclusion";
  collectionContractVersion: string;
  validationProtocolId: string | null;
  activationManifestSha256: string | null;
  activatedAt: string | null;
  activationScoringSystemSha256: string | null;
  cohortId: string;
  sourceRole: "context_only" | "prospective_secondary";
  participantGroupId: string | null;
  recruitmentFrameId: string | null;
  recruitmentSourceId: string;
  recruitmentEventContractVersion: string | null;
  recruitmentEventAt: string | null;
  recruitmentEventSha256: string | null;
  communityApprovalSha256: string | null;
  assignmentId: string | null;
  sourceRecordSha256: string | null;
  effortSegmentId: string | null;
  effortUnit: typeof VALIDATION_EFFORT_UNIT | null;
  attemptCount: 1 | null;
  targetTaxonId: typeof CALIFORNIA_HALIBUT_TAXON_ID | null;
  segmentStartAt: string | null;
  segmentEndAt: string | null;
  modeAtCompletion: string | null;
  anglerCount: number | null;
  durationMilliseconds: number | null;
  personMilliseconds: number | null;
  completionEventContractVersion: typeof VALIDATION_COMPLETION_EVENT_CONTRACT_VERSION | null;
  completionEventAt: string | null;
  completionConsentVersion: typeof TRIP_VALIDATION_CONSENT_VERSION | null;
  completionConsentedAt: string | null;
  completionPrimaryTargetConfirmed: boolean | null;
  completionCompleteAttemptConfirmed: boolean | null;
  completionEventSha256: string | null;
  incentivePolicyId: string;
  selectionMethod: "organic_score_visible" | "organic_unverified" | "retrospective_self_report";
  targetIntent: "california-halibut-primary-full-trip";
  primaryTargetConfirmed: boolean;
  completeAttemptConfirmed: boolean | null;
  modeAtEnrollment: string | null;
  consentVersion: string | null;
  consentedAt: string | null;
  scoreInfluencedChoice: boolean | null;
  attestationStatus:
    | OpportunityAttestationStatus
    | "not_applicable_retrospective"
    | "invalidated_after_edit";
  forecastImpressionId: string | null;
  completionAttestedAt: string | null;
  evidenceStatus: "context_only" | "secondary_pending_review";
  exclusionReason: string | null;
  createdAt: string;
}

interface ValidationPersistenceBundle {
  impression: ForecastImpressionRecord | null;
  provenance: ValidationProvenanceRecord;
}

interface StoredValidationEnrollment {
  collection_contract_version: string;
  source_role: "context_only" | "prospective_secondary";
  cohort_id: string;
  validation_protocol_id: string | null;
  activation_manifest_sha256: string | null;
  activated_at: string | null;
  activation_scoring_system_sha256: string | null;
  participant_group_id: string | null;
  recruitment_frame_id: string | null;
  recruitment_source_id: string;
  recruitment_event_contract_version: string | null;
  recruitment_event_at: string | null;
  recruitment_event_sha256: string | null;
  community_approval_sha256: string | null;
  assignment_id: string | null;
  source_record_sha256: string | null;
  effort_segment_id: string | null;
  effort_unit: string | null;
  attempt_count: number | null;
  target_taxon_id: string | null;
  segment_start_at: string | null;
  incentive_policy_id: string;
  selection_method: "organic_score_visible" | "organic_unverified";
  target_intent: "california-halibut-primary-full-trip";
  primary_target_confirmed: number;
  complete_attempt_confirmed: number | null;
  mode_at_enrollment: string | null;
  consent_version: string | null;
  consented_at: string | null;
  score_influenced_choice: number | null;
  forecast_impression_id: string | null;
  attestation_status: string;
}

interface StoredForecastImpression {
  id: string;
  window_start: string;
  window_end: string;
  site_id: string;
}

interface StoredRecruitmentEvent {
  participant_group_id: string;
  recruitment_frame_id: string;
  recruitment_source_id: string;
  recruitment_event_contract_version: string;
  recruitment_event_at: string;
  recruitment_event_sha256: string;
  community_approval_sha256: string | null;
}

interface RecruitmentEventRecord {
  participantGroupId: string;
  recruitmentFrameId: string;
  recruitmentSourceId: string;
  recruitmentEventContractVersion: string;
  recruitmentEventAt: string;
  recruitmentEventSha256: string;
  communityApprovalSha256: string | null;
}

interface ValidationActivationRecord {
  protocolId: string;
  cohortId: string;
  manifestSha256: string;
  activatedAt: string;
  scoringSystemSha256: string;
}

interface ValidationCollectionIdentity {
  assignmentId: string;
  sourceRecordSha256: string;
  effortSegmentId: string;
}

export interface TripStore {
  initialize(): Promise<void>;
  assertSubmissionAllowed(reporterKeyHash: string, now: Date): Promise<void>;
  insertTrip(
    record: NewTripRecord,
    validation?: ValidationPersistenceBundle,
    feasibilityStart?: FeasibilityEventRecord | null,
    feasibilityRecruitment?: FeasibilityRecruitmentRecord | null,
  ): Promise<TripRow>;
  getTrip(id: string): Promise<TripRow | null>;
  getValidationEnrollment?(tripId: string): Promise<StoredValidationEnrollment | null>;
  getForecastImpression?(tripId: string): Promise<StoredForecastImpression | null>;
  getRecruitmentEvent?(
    participantGroupId: string,
    activation: ValidationActivationRecord,
  ): Promise<StoredRecruitmentEvent | null>;
  getFeasibilityActivation?(activationId: string): Promise<StoredFeasibilityActivation | null>;
  getFeasibilityRecruitment?(
    activationId: string,
    participantGroupId: string,
  ): Promise<StoredFeasibilityRecruitment | null>;
  getFeasibilityRecruitmentCampaign?(
    activationId: string,
    campaignId: string,
  ): Promise<StoredFeasibilityRecruitmentCampaign | null>;
  getFeasibilityStart?(tripId: string): Promise<StoredFeasibilityStart | null>;
  completeTrip(
    id: string,
    tokenHash: string,
    completion: CompletionRecord,
    provenance?: ValidationProvenanceRecord,
    feasibilityTerminal?: FeasibilityEventRecord | null,
  ): Promise<TripRow | null>;
  cancelTrip?(
    id: string,
    tokenHash: string,
    timestamp: string,
    feasibilityTerminal: FeasibilityEventRecord | null,
  ): Promise<boolean>;
  getSummary(now: Date): Promise<TripSummary>;
}

export interface TripHandlerOptions {
  store?: TripStore;
  now?: () => Date;
  accountId?: string | null;
  onTripCompleted?: (trip: TripRow) => void;
}

const CREATE_TRIPS_SQL = `CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  site_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT NOT NULL,
  fishing_method TEXT,
  gear TEXT,
  gear_profile_id TEXT,
  rod TEXT,
  reel TEXT,
  bait_lure TEXT,
  rig TEXT,
  angler_count INTEGER NOT NULL,
  angler_hours REAL,
  keeper_count INTEGER,
  short_released_count INTEGER,
  halibut_encounters INTEGER,
  no_catch INTEGER,
  other_catch_count INTEGER,
  other_species TEXT,
  observations_json TEXT,
  observation_contract_version TEXT,
  taxon_catalog_version TEXT,
  target_taxon_id TEXT NOT NULL DEFAULT 'california-halibut',
  contract_status TEXT,
  taxon_observations_json TEXT,
  outcome_class TEXT,
  target_encounter_count INTEGER,
  any_fish_encounter_count INTEGER,
  target_identification_confidence TEXT,
  notes TEXT,
  consent INTEGER NOT NULL,
  consent_at TEXT,
  moderation_status TEXT NOT NULL,
  reporter_key_hash TEXT NOT NULL,
  referral_code TEXT,
  token_hash TEXT,
  idempotency_key_hash TEXT,
  opportunity_window_id TEXT,
  opportunity_score REAL,
  habitat_score REAL,
  seasonality_score REAL,
  conditions_score REAL,
  fishability_score REAL,
  model_version TEXT,
  score_influenced_choice INTEGER,
  prediction_metadata_json TEXT,
  photo_key TEXT,
  photo_content_type TEXT,
  photo_size_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  ai_review_status TEXT,
  ai_review_json TEXT,
  ai_review_model TEXT,
  ai_reviewed_at TEXT,
  CONSTRAINT trips_status_check CHECK (status in ('active', 'completed')),
  CONSTRAINT trips_source_check CHECK (source in ('live', 'past_report')),
  CONSTRAINT trips_moderation_status_check CHECK (moderation_status in ('pending', 'approved', 'rejected')),
  CONSTRAINT trips_angler_count_check CHECK (angler_count between 1 and 12),
  CONSTRAINT trips_contract_status_check CHECK (contract_status IS NULL OR contract_status in ('valid', 'legacy_unverified', 'rejected')),
  CONSTRAINT trips_outcome_class_check CHECK (outcome_class IS NULL OR outcome_class in ('target_encountered', 'non_target_only', 'no_fish')),
  CONSTRAINT trips_target_encounter_count_check CHECK (target_encounter_count IS NULL OR target_encounter_count >= 0),
  CONSTRAINT trips_any_fish_encounter_count_check CHECK (any_fish_encounter_count IS NULL OR any_fish_encounter_count >= 0),
  CONSTRAINT trips_target_identification_confidence_check CHECK (target_identification_confidence IS NULL OR target_identification_confidence in ('verified', 'self_reported', 'uncertain', 'unresolved', 'not_observed')),
  CONSTRAINT trips_target_taxon_check CHECK (target_taxon_id = 'california-halibut'),
  CONSTRAINT trips_species_contract_coherence_check CHECK (
    (status != 'completed' OR contract_status IS NOT NULL)
    AND (contract_status IS NOT NULL OR (
      observation_contract_version IS NULL
      AND taxon_catalog_version IS NULL
      AND taxon_observations_json IS NULL
      AND outcome_class IS NULL
      AND target_encounter_count IS NULL
      AND any_fish_encounter_count IS NULL
      AND target_identification_confidence IS NULL
    ))
    AND (contract_status != 'legacy_unverified' OR (
      observation_contract_version IS NULL
      AND taxon_catalog_version IS NULL
      AND taxon_observations_json IS NULL
      AND outcome_class IS NULL
      AND target_encounter_count IS NULL
      AND any_fish_encounter_count IS NULL
      AND target_identification_confidence IS NULL
    ))
    AND (contract_status != 'valid' OR (
      status = 'completed'
      AND observation_contract_version = 'castingcompass.observation/2.0.0'
      AND taxon_catalog_version = 'castingcompass.taxa/1.0.0'
      AND target_taxon_id = 'california-halibut'
      AND typeof(angler_count) = 'integer'
      AND angler_count BETWEEN 1 AND 12
      AND typeof(angler_hours) IN ('integer', 'real')
      AND angler_hours > 0
      AND angler_hours <= 432
      AND typeof(keeper_count) = 'integer'
      AND typeof(short_released_count) = 'integer'
      AND typeof(halibut_encounters) = 'integer'
      AND typeof(no_catch) = 'integer'
      AND typeof(other_catch_count) = 'integer'
      AND typeof(target_encounter_count) = 'integer'
      AND typeof(any_fish_encounter_count) = 'integer'
      AND keeper_count BETWEEN 0 AND 25
      AND short_released_count BETWEEN 0 AND 25
      AND keeper_count + short_released_count <= 40
      AND other_catch_count BETWEEN 0 AND 100
      AND no_catch IN (0, 1)
      AND typeof(mode) = 'text'
      AND mode IN ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
      AND typeof(started_at) = 'text'
      AND typeof(ended_at) = 'text'
      AND length(started_at) = 24
      AND length(ended_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
      AND strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) = ended_at
      AND julianday(ended_at) > julianday(started_at)
      AND taxon_observations_json IS NOT NULL
      AND json_valid(taxon_observations_json) = 1
      AND outcome_class IS NOT NULL
      AND target_encounter_count IS NOT NULL
      AND any_fish_encounter_count IS NOT NULL
      AND target_identification_confidence IS NOT NULL
      AND target_encounter_count = keeper_count + short_released_count
      AND halibut_encounters = target_encounter_count
      AND any_fish_encounter_count = target_encounter_count + other_catch_count
      AND target_encounter_count <= any_fish_encounter_count
      AND target_identification_confidence = CASE
        WHEN target_encounter_count > 0 THEN 'self_reported'
        ELSE 'not_observed'
      END
      AND no_catch = CASE WHEN any_fish_encounter_count = 0 THEN 1 ELSE 0 END
      AND outcome_class = CASE
        WHEN target_encounter_count > 0 THEN 'target_encountered'
        WHEN any_fish_encounter_count > 0 THEN 'non_target_only'
        ELSE 'no_fish'
      END
      AND taxon_observations_json = CASE
        WHEN other_catch_count > 0 THEN json_array(
          json_object(
            'taxon_id', 'california-halibut',
            'encounter_count', target_encounter_count,
            'retained_count', keeper_count,
            'released_count', short_released_count,
            'disposition_unknown_count', 0,
            'identification_confidence', target_identification_confidence,
            'identification_basis', CASE WHEN target_encounter_count > 0 THEN 'angler-report' ELSE 'not-observed' END
          ),
          json_object(
            'taxon_id', 'unresolved-fish',
            'encounter_count', other_catch_count,
            'retained_count', 0,
            'released_count', 0,
            'disposition_unknown_count', other_catch_count,
            'identification_confidence', 'unresolved',
            'identification_basis', 'unresolved'
          )
        )
        ELSE json_array(json_object(
          'taxon_id', 'california-halibut',
          'encounter_count', target_encounter_count,
          'retained_count', keeper_count,
          'released_count', short_released_count,
          'disposition_unknown_count', 0,
          'identification_confidence', target_identification_confidence,
          'identification_basis', CASE WHEN target_encounter_count > 0 THEN 'angler-report' ELSE 'not-observed' END
        ))
      END
    ))
  ),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
)`;

const CREATE_FORECAST_IMPRESSIONS_SQL = `CREATE TABLE IF NOT EXISTS forecast_impressions (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL UNIQUE,
  attestation_index_version TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  site_catalog_sha256 TEXT NOT NULL,
  target_taxon_id TEXT NOT NULL CHECK (target_taxon_id = 'california-halibut'),
  taxon_catalog_version TEXT NOT NULL,
  observation_contract_version TEXT NOT NULL,
  model_run_contract_version TEXT NOT NULL,
  opportunity_contract_version TEXT NOT NULL,
  scoring_system_kind TEXT NOT NULL,
  scoring_system_version TEXT NOT NULL,
  scoring_system_sha256 TEXT NOT NULL,
  window_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  opportunity_score REAL NOT NULL CHECK (opportunity_score BETWEEN 0 AND 100),
  habitat_score REAL NOT NULL CHECK (habitat_score BETWEEN 0 AND 100),
  seasonality_score REAL NOT NULL CHECK (seasonality_score BETWEEN 0 AND 100),
  conditions_score REAL NOT NULL CHECK (conditions_score BETWEEN 0 AND 100),
  fishability_score REAL NOT NULL CHECK (fishability_score BETWEEN 0 AND 100),
  attested_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  UNIQUE (id, trip_id),
  CHECK (attestation_index_version = 'castingcompass.opportunity-attestation-index/1.0.0'
    AND target_taxon_id = 'california-halibut'
    AND taxon_catalog_version = 'castingcompass.taxa/1.0.0'
    AND observation_contract_version = 'castingcompass.observation/2.0.0'
    AND model_run_contract_version = 'castingcompass.model-run/2.0.0'
    AND opportunity_contract_version = 'castingcompass.opportunity/2.0.0'
    AND scoring_system_kind = 'heuristic-configuration'
    AND scoring_system_version = 'heuristic-' || target_taxon_id || '-' || scoring_system_sha256),
  CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(site_catalog_sha256) = 64 AND site_catalog_sha256 NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(scoring_system_sha256) = 64 AND scoring_system_sha256 NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(window_start) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', window_start) = window_start
    AND length(window_end) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', window_end) = window_end
    AND length(attested_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', attested_at) = attested_at
    AND julianday(window_end) > julianday(window_start)
    AND abs((julianday(window_end) - julianday(window_start)) * 24.0 - 2.0) < 0.000001)
)`;

const CREATE_TRIP_VALIDATION_PROVENANCE_SQL = `CREATE TABLE IF NOT EXISTS trip_validation_provenance (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('enrollment', 'completion', 'retrospective_submission', 'evidence_exclusion', 'legacy_context')),
  collection_contract_version TEXT NOT NULL,
  validation_protocol_id TEXT,
  activation_manifest_sha256 TEXT,
  activated_at TEXT,
  activation_scoring_system_sha256 TEXT,
  cohort_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('context_only', 'prospective_secondary')),
  participant_group_id TEXT,
  recruitment_frame_id TEXT,
  recruitment_source_id TEXT NOT NULL,
  recruitment_event_contract_version TEXT,
  recruitment_event_at TEXT,
  recruitment_event_sha256 TEXT,
  community_approval_sha256 TEXT,
  assignment_id TEXT,
  source_record_sha256 TEXT,
  effort_segment_id TEXT,
  effort_unit TEXT,
  attempt_count INTEGER,
  target_taxon_id TEXT,
  segment_start_at TEXT,
  segment_end_at TEXT,
  mode_at_completion TEXT,
  angler_count INTEGER,
  duration_milliseconds INTEGER,
  person_milliseconds INTEGER,
  completion_event_contract_version TEXT,
  completion_event_at TEXT,
  completion_consent_version TEXT,
  completion_consented_at TEXT,
  completion_primary_target_confirmed INTEGER,
  completion_complete_attempt_confirmed INTEGER,
  completion_event_sha256 TEXT,
  incentive_policy_id TEXT NOT NULL,
  selection_method TEXT NOT NULL CHECK (selection_method IN ('organic_score_visible', 'organic_unverified', 'retrospective_self_report', 'legacy_unknown')),
  target_intent TEXT NOT NULL CHECK (target_intent IN ('california-halibut-primary-full-trip', 'legacy_unknown')),
  primary_target_confirmed INTEGER CHECK (primary_target_confirmed IS NULL OR primary_target_confirmed IN (0, 1)),
  complete_attempt_confirmed INTEGER CHECK (complete_attempt_confirmed IS NULL OR complete_attempt_confirmed IN (0, 1)),
  mode_at_enrollment TEXT CHECK (mode_at_enrollment IS NULL OR mode_at_enrollment IN ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')),
  consent_version TEXT,
  consented_at TEXT,
  score_influenced_choice INTEGER CHECK (score_influenced_choice IS NULL OR score_influenced_choice IN (0, 1)),
  attestation_status TEXT NOT NULL CHECK (attestation_status IN ('verified', 'unverified_missing', 'unverified_mismatch', 'unverified_asset', 'not_applicable_retrospective', 'invalidated_after_edit', 'legacy_unverified')),
  forecast_impression_id TEXT,
  completion_attested_at TEXT,
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('context_only', 'secondary_pending_review')),
  exclusion_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (forecast_impression_id, trip_id) REFERENCES forecast_impressions(id, trip_id) ON DELETE CASCADE,
  CHECK (
    (validation_protocol_id IS NULL
      AND activation_manifest_sha256 IS NULL
      AND activated_at IS NULL
      AND activation_scoring_system_sha256 IS NULL)
    OR
    (validation_protocol_id = 'california-halibut-site-window-v1'
      AND length(activation_manifest_sha256) = 64
      AND activation_manifest_sha256 NOT GLOB '*[^a-f0-9]*'
      AND activated_at IS NOT NULL
      AND length(activated_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) = activated_at
      AND length(activation_scoring_system_sha256) = 64
      AND activation_scoring_system_sha256 NOT GLOB '*[^a-f0-9]*'
      AND activated_at < '2026-08-01T00:00:00.000Z'
      AND julianday(activated_at) < julianday(created_at))
  ),
  CHECK ((attestation_status = 'verified' AND forecast_impression_id IS NOT NULL)
    OR (attestation_status != 'verified' AND forecast_impression_id IS NULL)),
  CHECK (collection_contract_version = 'castingcompass.validation-collection/1.0.0'
    AND length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND (consented_at IS NULL OR (length(consented_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', consented_at) = consented_at))
    AND (completion_attested_at IS NULL OR (length(completion_attested_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completion_attested_at) = completion_attested_at))),
  CHECK ((participant_group_id IS NULL
      AND recruitment_frame_id IS NULL
      AND recruitment_event_contract_version IS NULL
      AND recruitment_event_at IS NULL
      AND recruitment_event_sha256 IS NULL
      AND community_approval_sha256 IS NULL)
    OR (length(participant_group_id) = 76
      AND substr(participant_group_id, 1, 12) = 'participant-'
      AND substr(participant_group_id, 13) NOT GLOB '*[^a-f0-9]*'
      AND recruitment_frame_id = 'california-halibut-site-window-recruitment-v1'
      AND recruitment_source_id IN ('castingcompass-organic-product', 'direct-opt-in-research-invite', 'admin-approved-community-prospective')
      AND recruitment_event_contract_version = 'castingcompass.recruitment-event/1.0.0'
      AND length(recruitment_event_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', recruitment_event_at) = recruitment_event_at
      AND julianday(recruitment_event_at) <= julianday(created_at)
      AND length(recruitment_event_sha256) = 64
      AND recruitment_event_sha256 NOT GLOB '*[^a-f0-9]*'
      AND ((recruitment_source_id = 'admin-approved-community-prospective'
          AND length(community_approval_sha256) = 64
          AND community_approval_sha256 NOT GLOB '*[^a-f0-9]*')
        OR (recruitment_source_id != 'admin-approved-community-prospective'
          AND community_approval_sha256 IS NULL)))),
  CHECK ((assignment_id IS NULL
      AND source_record_sha256 IS NULL
      AND effort_segment_id IS NULL
      AND effort_unit IS NULL
      AND attempt_count IS NULL
      AND target_taxon_id IS NULL
      AND segment_start_at IS NULL)
    OR (length(assignment_id) = 75
      AND substr(assignment_id, 1, 11) = 'assignment-'
      AND substr(assignment_id, 12) NOT GLOB '*[^a-f0-9]*'
      AND length(source_record_sha256) = 64
      AND source_record_sha256 NOT GLOB '*[^a-f0-9]*'
      AND length(effort_segment_id) = 71
      AND substr(effort_segment_id, 1, 7) = 'effort-'
      AND substr(effort_segment_id, 8) NOT GLOB '*[^a-f0-9]*'
      AND effort_unit = 'whole-trip-group-attempt'
      AND attempt_count = 1
      AND target_taxon_id = 'california-halibut'
      AND length(segment_start_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', segment_start_at) = segment_start_at)),
  CHECK ((segment_end_at IS NULL
      AND mode_at_completion IS NULL
      AND angler_count IS NULL
      AND duration_milliseconds IS NULL
      AND person_milliseconds IS NULL
      AND completion_event_contract_version IS NULL
      AND completion_event_at IS NULL
      AND completion_consent_version IS NULL
      AND completion_consented_at IS NULL
      AND completion_primary_target_confirmed IS NULL
      AND completion_complete_attempt_confirmed IS NULL
      AND completion_event_sha256 IS NULL)
    OR (assignment_id IS NOT NULL
      AND length(segment_end_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', segment_end_at) = segment_end_at
      AND julianday(segment_end_at) > julianday(segment_start_at)
      AND mode_at_completion IN ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
      AND angler_count BETWEEN 1 AND 12
      AND duration_milliseconds BETWEEN 60000 AND 129600000
      AND CAST(ROUND((julianday(segment_end_at) - julianday(segment_start_at)) * 86400000.0) AS INTEGER) = duration_milliseconds
      AND person_milliseconds = duration_milliseconds * angler_count
      AND completion_event_contract_version = 'castingcompass.validation-completion-event/1.0.0'
      AND length(completion_event_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completion_event_at) = completion_event_at
      AND julianday(completion_event_at) >= julianday(segment_end_at)
      AND completion_consent_version = 'castingcompass.trip-validation-consent/1.0.0'
      AND completion_consented_at = completion_event_at
      AND completion_primary_target_confirmed = 1
      AND completion_complete_attempt_confirmed = 1
      AND length(completion_event_sha256) = 64
      AND completion_event_sha256 NOT GLOB '*[^a-f0-9]*'
      AND completion_event_at = completion_attested_at
      AND completion_consent_version = consent_version
      AND completion_consented_at = consented_at
      AND completion_primary_target_confirmed = primary_target_confirmed
      AND completion_complete_attempt_confirmed = complete_attempt_confirmed)),
  CHECK ((source_role = 'prospective_secondary'
      AND validation_protocol_id IS NOT NULL
      AND participant_group_id IS NOT NULL
      AND recruitment_frame_id = 'california-halibut-site-window-recruitment-v1'
      AND recruitment_event_contract_version = 'castingcompass.recruitment-event/1.0.0'
      AND recruitment_event_sha256 IS NOT NULL
      AND assignment_id IS NOT NULL
      AND source_record_sha256 IS NOT NULL
      AND effort_segment_id IS NOT NULL
      AND effort_unit = 'whole-trip-group-attempt'
      AND attempt_count = 1
      AND target_taxon_id = 'california-halibut'
      AND segment_start_at IS NOT NULL
      AND cohort_id = 'california-halibut-site-window-observational-secondary-v1'
      AND incentive_policy_id = 'none-v1'
      AND selection_method = 'organic_score_visible'
      AND target_intent = 'california-halibut-primary-full-trip'
      AND primary_target_confirmed = 1
      AND score_influenced_choice IS NOT NULL
      AND mode_at_enrollment IN ('shore', 'beach', 'pier', 'jetty')
      AND attestation_status = 'verified'
      AND evidence_status = 'secondary_pending_review')
    OR (source_role = 'context_only' AND evidence_status = 'context_only')),
  CHECK (event_type != 'enrollment' OR source_role != 'context_only' OR participant_group_id IS NULL),
  CHECK (event_type != 'enrollment' OR segment_end_at IS NULL),
  CHECK (event_type != 'completion' OR assignment_id IS NULL OR completion_event_sha256 IS NOT NULL),
  CHECK ((event_type = 'enrollment'
      AND primary_target_confirmed = 1
      AND complete_attempt_confirmed IS NULL
      AND consent_version = 'castingcompass.trip-validation-consent/1.0.0'
      AND consented_at IS NOT NULL
      AND completion_attested_at IS NULL)
    OR (event_type = 'completion'
      AND primary_target_confirmed = 1
      AND complete_attempt_confirmed = 1
      AND consent_version = 'castingcompass.trip-validation-consent/1.0.0'
      AND consented_at = created_at
      AND completion_attested_at = created_at)
    OR (event_type = 'retrospective_submission'
      AND validation_protocol_id IS NULL
      AND source_role = 'context_only'
      AND selection_method = 'retrospective_self_report'
      AND primary_target_confirmed = 1
      AND complete_attempt_confirmed = 1
      AND attestation_status = 'not_applicable_retrospective'
      AND consented_at = created_at
      AND completion_attested_at = created_at)
    OR (event_type = 'evidence_exclusion'
      AND validation_protocol_id IS NULL
      AND activation_manifest_sha256 IS NULL
      AND activated_at IS NULL
      AND activation_scoring_system_sha256 IS NULL
      AND source_role = 'context_only'
      AND participant_group_id IS NULL
      AND recruitment_frame_id IS NULL
      AND recruitment_event_contract_version IS NULL
      AND recruitment_event_at IS NULL
      AND recruitment_event_sha256 IS NULL
      AND community_approval_sha256 IS NULL
      AND assignment_id IS NULL
      AND source_record_sha256 IS NULL
      AND effort_segment_id IS NULL
      AND effort_unit IS NULL
      AND attempt_count IS NULL
      AND target_taxon_id IS NULL
      AND segment_start_at IS NULL
      AND segment_end_at IS NULL
      AND mode_at_completion IS NULL
      AND angler_count IS NULL
      AND duration_milliseconds IS NULL
      AND person_milliseconds IS NULL
      AND completion_event_contract_version IS NULL
      AND completion_event_at IS NULL
      AND completion_consent_version IS NULL
      AND completion_consented_at IS NULL
      AND completion_primary_target_confirmed IS NULL
      AND completion_complete_attempt_confirmed IS NULL
      AND completion_event_sha256 IS NULL
      AND attestation_status = 'invalidated_after_edit'
      AND forecast_impression_id IS NULL
      AND completion_attested_at IS NULL
      AND evidence_status = 'context_only'
      AND exclusion_reason IN ('post_completion_profile_edit', 'trusted_review_exclusion'))
    OR (event_type = 'legacy_context'
      AND source_role = 'context_only'
      AND evidence_status = 'context_only'))
)`;

const CREATE_INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS trips_status_started_idx ON trips (status, started_at)",
  "CREATE INDEX IF NOT EXISTS trips_site_started_idx ON trips (site_id, started_at)",
  "CREATE INDEX IF NOT EXISTS trips_reporter_created_idx ON trips (reporter_key_hash, created_at)",
  "CREATE INDEX IF NOT EXISTS trips_referral_created_idx ON trips (referral_code, created_at)",
  "CREATE INDEX IF NOT EXISTS trips_user_completed_idx ON trips (user_id, completed_at)",
  `CREATE INDEX IF NOT EXISTS trips_user_history_idx
    ON trips (user_id, COALESCE(completed_at, ended_at, started_at) DESC)
    WHERE status = 'completed' AND user_id IS NOT NULL`,
  "CREATE INDEX IF NOT EXISTS trips_user_created_idx ON trips (user_id, created_at DESC) WHERE user_id IS NOT NULL",
  `CREATE INDEX IF NOT EXISTS trips_ai_review_backlog_idx
    ON trips (status, COALESCE(completed_at, ended_at, started_at))
    WHERE ai_review_status IS NULL OR ai_review_status = 'retry'`,
  "CREATE INDEX IF NOT EXISTS trips_reporter_active_created_idx ON trips (reporter_key_hash, created_at) WHERE status = 'active'",
  "CREATE INDEX IF NOT EXISTS trips_contract_target_completed_idx ON trips (contract_status, target_taxon_id, completed_at)",
  "CREATE INDEX IF NOT EXISTS forecast_impressions_window_idx ON forecast_impressions (window_id, site_id, window_start)",
  "CREATE INDEX IF NOT EXISTS trip_validation_provenance_trip_created_idx ON trip_validation_provenance (trip_id, created_at)",
  `CREATE INDEX IF NOT EXISTS trip_validation_provenance_forecast_trip_idx
    ON trip_validation_provenance (forecast_impression_id, trip_id)
    WHERE forecast_impression_id IS NOT NULL`,
  "CREATE INDEX IF NOT EXISTS trip_validation_provenance_cohort_role_idx ON trip_validation_provenance (collection_contract_version, validation_protocol_id, cohort_id, source_role, evidence_status)",
  "CREATE INDEX IF NOT EXISTS trip_validation_provenance_participant_recruitment_idx ON trip_validation_provenance (participant_group_id, recruitment_event_at)",
  `CREATE TRIGGER IF NOT EXISTS forecast_impressions_append_only_guard
    BEFORE UPDATE ON forecast_impressions
    BEGIN SELECT RAISE(ABORT, 'forecast impressions are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trip_validation_provenance_append_only_guard
    BEFORE UPDATE ON trip_validation_provenance
    BEGIN SELECT RAISE(ABORT, 'trip validation provenance is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trip_validation_recruitment_event_immutable_guard
    BEFORE INSERT ON trip_validation_provenance
    WHEN NEW.participant_group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM trip_validation_provenance AS prior
      WHERE prior.participant_group_id = NEW.participant_group_id
        AND prior.recruitment_event_sha256 IS NOT NULL
        AND (prior.recruitment_frame_id IS NOT NEW.recruitment_frame_id
          OR prior.recruitment_source_id IS NOT NEW.recruitment_source_id
          OR prior.recruitment_event_contract_version IS NOT NEW.recruitment_event_contract_version
          OR prior.recruitment_event_at IS NOT NEW.recruitment_event_at
          OR prior.recruitment_event_sha256 IS NOT NEW.recruitment_event_sha256
          OR prior.community_approval_sha256 IS NOT NEW.community_approval_sha256)
    )
    BEGIN SELECT RAISE(ABORT, 'participant recruitment event is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS forecast_impressions_trip_identity_guard
    BEFORE INSERT ON forecast_impressions
    WHEN NOT EXISTS (
      SELECT 1 FROM trips
      WHERE id = NEW.trip_id AND site_id = NEW.site_id
        AND julianday(started_at) >= julianday(NEW.window_start)
        AND julianday(started_at) < julianday(NEW.window_end)
    )
    BEGIN SELECT RAISE(ABORT, 'forecast impression does not match trip site and start window'); END`,
  `CREATE TRIGGER IF NOT EXISTS trip_validation_activation_identity_guard
    BEFORE INSERT ON trip_validation_provenance
    WHEN NEW.validation_protocol_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM forecast_impressions
      WHERE id = NEW.forecast_impression_id AND trip_id = NEW.trip_id
        AND scoring_system_sha256 = NEW.activation_scoring_system_sha256
    )
    BEGIN SELECT RAISE(ABORT, 'validation activation does not match forecast impression'); END`,
  `CREATE TRIGGER IF NOT EXISTS trip_validation_completion_identity_guard
    BEFORE INSERT ON trip_validation_provenance
    WHEN NEW.event_type = 'completion' AND NEW.assignment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trip_validation_provenance AS enrollment
      WHERE enrollment.trip_id = NEW.trip_id AND enrollment.event_type = 'enrollment'
        AND enrollment.source_role = 'prospective_secondary'
        AND enrollment.assignment_id = NEW.assignment_id
        AND enrollment.source_record_sha256 = NEW.source_record_sha256
        AND enrollment.effort_segment_id = NEW.effort_segment_id
        AND enrollment.participant_group_id = NEW.participant_group_id
        AND enrollment.validation_protocol_id = NEW.validation_protocol_id
        AND enrollment.activation_manifest_sha256 = NEW.activation_manifest_sha256
        AND enrollment.activated_at = NEW.activated_at
        AND enrollment.activation_scoring_system_sha256 = NEW.activation_scoring_system_sha256
        AND enrollment.cohort_id = NEW.cohort_id
        AND enrollment.incentive_policy_id = NEW.incentive_policy_id
        AND enrollment.recruitment_frame_id = NEW.recruitment_frame_id
        AND enrollment.recruitment_source_id = NEW.recruitment_source_id
        AND enrollment.recruitment_event_contract_version = NEW.recruitment_event_contract_version
        AND enrollment.recruitment_event_at = NEW.recruitment_event_at
        AND enrollment.recruitment_event_sha256 = NEW.recruitment_event_sha256
        AND enrollment.community_approval_sha256 IS NEW.community_approval_sha256
        AND enrollment.forecast_impression_id = NEW.forecast_impression_id
        AND enrollment.effort_unit = NEW.effort_unit
        AND enrollment.attempt_count = NEW.attempt_count
        AND enrollment.target_taxon_id = NEW.target_taxon_id
        AND enrollment.segment_start_at = NEW.segment_start_at
        AND enrollment.selection_method = NEW.selection_method
        AND enrollment.target_intent = NEW.target_intent
        AND enrollment.primary_target_confirmed = NEW.primary_target_confirmed
        AND enrollment.mode_at_enrollment = NEW.mode_at_enrollment
        AND enrollment.score_influenced_choice = NEW.score_influenced_choice
    )
    BEGIN SELECT RAISE(ABORT, 'completion event does not match immutable enrollment identity'); END`,
  `CREATE TRIGGER IF NOT EXISTS trip_validation_secondary_eligibility_guard
    BEFORE INSERT ON trip_validation_provenance
    WHEN NEW.source_role = 'prospective_secondary' AND NOT EXISTS (
      SELECT 1 FROM trips AS t
      JOIN forecast_impressions AS f
        ON f.id = NEW.forecast_impression_id AND f.trip_id = t.id
      WHERE t.id = NEW.trip_id
        AND t.started_at >= '2026-08-01T00:00:00.000Z'
        AND t.started_at < '2027-08-01T00:00:00.000Z'
        AND julianday(NEW.activated_at) < julianday(t.started_at)
        AND t.site_id = f.site_id
        AND t.started_at = NEW.segment_start_at
        AND julianday(t.started_at) >= julianday(f.window_start)
        AND julianday(t.started_at) < julianday(f.window_end)
        AND (NEW.event_type != 'completion' OR (
          t.status = 'completed' AND t.mode = NEW.mode_at_enrollment
          AND t.mode = NEW.mode_at_completion
          AND t.ended_at = NEW.segment_end_at
          AND t.angler_count = NEW.angler_count
          AND t.target_taxon_id = NEW.target_taxon_id
          AND julianday(t.ended_at) <= julianday(f.window_end)
        ))
    )
    BEGIN SELECT RAISE(ABORT, 'secondary evidence row is outside its activated site-window envelope'); END`,
  `CREATE TRIGGER IF NOT EXISTS trips_completed_contract_insert_guard
    BEFORE INSERT ON trips
    WHEN NEW.status = 'completed' AND NEW.contract_status IS NULL
    BEGIN SELECT RAISE(ABORT, 'completed trips require an explicit contract status'); END`,
  `CREATE TRIGGER IF NOT EXISTS trips_completed_contract_update_guard
    BEFORE UPDATE OF status, contract_status ON trips
    WHEN NEW.status = 'completed' AND NEW.contract_status IS NULL
    BEGIN SELECT RAISE(ABORT, 'completed trips require an explicit contract status'); END`,
];

const INSERT_TRIP_SQL = `INSERT INTO trips (
  id, user_id, status, source, site_id, started_at, ended_at, mode, fishing_method, gear,
  gear_profile_id, rod, reel, bait_lure, rig,
  angler_count, angler_hours, keeper_count, short_released_count, halibut_encounters,
  no_catch, other_catch_count, other_species, observations_json, observation_contract_version,
  taxon_catalog_version, target_taxon_id, contract_status, taxon_observations_json, outcome_class,
  target_encounter_count, any_fish_encounter_count, target_identification_confidence,
  notes, consent, consent_at, moderation_status, reporter_key_hash, referral_code, token_hash,
  idempotency_key_hash,
  opportunity_window_id, opportunity_score, habitat_score, seasonality_score, conditions_score,
  fishability_score, model_version, score_influenced_choice, prediction_metadata_json, photo_key,
  photo_content_type, photo_size_bytes, created_at, updated_at, completed_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)`;

const INSERT_FORECAST_IMPRESSION_SQL = `INSERT INTO forecast_impressions (
  id, trip_id, attestation_index_version, snapshot_sha256, site_catalog_sha256,
  target_taxon_id, taxon_catalog_version, observation_contract_version,
  model_run_contract_version, opportunity_contract_version, scoring_system_kind,
  scoring_system_version, scoring_system_sha256, window_id, site_id, window_start,
  window_end, opportunity_score, habitat_score, seasonality_score, conditions_score,
  fishability_score, attested_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const VALIDATION_PROVENANCE_COLUMNS = [
  "id", "trip_id", "event_type", "collection_contract_version", "validation_protocol_id",
  "activation_manifest_sha256", "activated_at", "activation_scoring_system_sha256",
  "cohort_id", "source_role", "participant_group_id", "recruitment_frame_id",
  "recruitment_source_id", "recruitment_event_contract_version", "recruitment_event_at",
  "recruitment_event_sha256", "community_approval_sha256",
  "assignment_id", "source_record_sha256", "effort_segment_id", "effort_unit",
  "attempt_count", "target_taxon_id", "segment_start_at", "segment_end_at",
  "mode_at_completion", "angler_count", "duration_milliseconds", "person_milliseconds",
  "completion_event_contract_version", "completion_event_at", "completion_consent_version",
  "completion_consented_at", "completion_primary_target_confirmed",
  "completion_complete_attempt_confirmed", "completion_event_sha256",
  "incentive_policy_id", "selection_method", "target_intent", "primary_target_confirmed",
  "complete_attempt_confirmed", "mode_at_enrollment", "consent_version", "consented_at",
  "score_influenced_choice", "attestation_status", "forecast_impression_id",
  "completion_attested_at", "evidence_status", "exclusion_reason", "created_at",
] as const;

const INSERT_VALIDATION_PROVENANCE_SQL = `INSERT INTO trip_validation_provenance (
  ${VALIDATION_PROVENANCE_COLUMNS.join(", ")}
) VALUES (${VALIDATION_PROVENANCE_COLUMNS.map(() => "?").join(", ")})`;

const FEASIBILITY_EVENT_COLUMNS = [
  "event_id", "activation_id", "trip_id", "event_type", "event_contract_version",
  "source_record_sha256", "participant_group_id", "recruitment_frame_id",
  "recruitment_source_id", "selection_method", "score_influenced_choice",
  "study_consent_version", "study_consented_at", "target_taxon_id", "site_id",
  "geographic_panel", "mode", "segment_start_at", "segment_end_at", "angler_count",
  "effort_minutes", "target_encountered", "target_encounter_count", "target_retained_count",
  "target_released_count", "identification_confidence", "scoring_system_kind",
  "scoring_system_version", "scoring_system_sha256", "opportunity_score",
  "opportunity_window_id", "snapshot_sha256", "terminal_reason", "previous_event_sha256",
  "event_at", "event_sha256", "snapshot_suppression_sha256",
] as const;

const INSERT_FEASIBILITY_EVENT_SQL = `INSERT INTO validation_feasibility_events (
  ${FEASIBILITY_EVENT_COLUMNS.join(", ")}
) VALUES (${FEASIBILITY_EVENT_COLUMNS.map(() => "?").join(", ")})`;

const FEASIBILITY_RECRUITMENT_COLUMNS = [
  "event_id", "activation_id", "user_id", "participant_group_id", "event_contract_version",
  "recruitment_frame_id", "recruitment_source_id", "selection_method", "recruited_at",
  "campaign_id", "invite_issued_at", "invite_expires_at", "community_approval_sha256",
  "event_sha256", "created_at", "snapshot_suppression_sha256",
] as const;

const INSERT_FEASIBILITY_RECRUITMENT_SQL = `INSERT INTO validation_feasibility_recruitment_events (
  ${FEASIBILITY_RECRUITMENT_COLUMNS.join(", ")}
) VALUES (${FEASIBILITY_RECRUITMENT_COLUMNS.map(() => "?").join(", ")})`;

const initializedDatabases = new WeakMap<object, Promise<void>>();

export class RateLimitError extends Error {
  constructor() {
    super("Too many trip submissions. Please try again later.");
    this.name = "RateLimitError";
  }
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const SERVER_CONTROLLED_OBSERVATION_FIELDS = [
  "observationContract",
  "observation_contract",
  "observationContractVersion",
  "observation_contract_version",
  "contractVersion",
  "contract_version",
  "contractStatus",
  "contract_status",
  "taxonCatalogVersion",
  "taxon_catalog_version",
  "targetTaxonId",
  "target_taxon_id",
  "primaryTargetTaxonId",
  "primary_target_taxon_id",
  "targetSpecies",
  "target_species",
  "taxonId",
  "taxon_id",
  "speciesId",
  "species_id",
  "species",
  "target",
  "taxonObservations",
  "taxon_observations",
  "taxonObservationsJson",
  "taxon_observations_json",
  "outcomeClass",
  "outcome_class",
  "targetEncounterCount",
  "target_encounter_count",
  "anyFishEncounterCount",
  "any_fish_encounter_count",
  "targetIdentificationConfidence",
  "target_identification_confidence",
  "identificationConfidence",
  "identification_confidence",
  "identificationBasis",
  "identification_basis",
  "encounterCount",
  "encounter_count",
  "retainedCount",
  "retained_count",
  "releasedCount",
  "released_count",
  "dispositionUnknownCount",
  "disposition_unknown_count",
  "observationId",
  "observation_id",
  "effortSegmentId",
  "effort_segment_id",
  "targetEffort",
  "target_effort",
  "targetEffortValue",
  "target_effort_value",
  "temporalPrecision",
  "temporal_precision",
  "temporalSupport",
  "temporal_support",
  "spatialSupport",
  "spatial_support",
  "supportId",
  "support_id",
  "crs",
  "x",
  "y",
  "source",
  "sourceId",
  "source_id",
  "sourceRecordId",
  "source_record_id",
  "dataKind",
  "data_kind",
  "expandedEstimate",
  "expanded_estimate",
] as const;

export function hasServerControlledObservationFields(source: Record<string, unknown> | FormData) {
  return SERVER_CONTROLLED_OBSERVATION_FIELDS.some((field) =>
    source instanceof FormData
      ? source.has(field)
      : Object.prototype.hasOwnProperty.call(source, field));
}

interface SpeciesObservationInput {
  tripId: string;
  siteId: string;
  startedAt: string;
  endedAt: string;
  mode: string;
  anglerHours: number;
  keeperCount: number;
  shortReleasedCount: number;
  otherCatchCount: number;
  temporalPrecision?: "exact" | "bounded";
}

export function buildSpeciesObservationContract(input: SpeciesObservationInput) {
  const targetEncounterCount = input.keeperCount + input.shortReleasedCount;
  const targetIdentificationConfidence = targetEncounterCount > 0 ? "self_reported" : "not_observed";
  const taxonObservations = [
    {
      taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
      encounter_count: targetEncounterCount,
      retained_count: input.keeperCount,
      released_count: input.shortReleasedCount,
      disposition_unknown_count: 0,
      identification_confidence: targetIdentificationConfidence,
      identification_basis: targetEncounterCount > 0 ? "angler-report" : "not-observed",
    },
    ...(input.otherCatchCount > 0
      ? [{
          taxon_id: UNRESOLVED_FISH_TAXON_ID,
          encounter_count: input.otherCatchCount,
          retained_count: 0,
          released_count: 0,
          disposition_unknown_count: input.otherCatchCount,
          identification_confidence: "unresolved",
          identification_basis: "unresolved",
        }]
      : []),
  ];
  const outcomeClass = deriveObservationOutcomeClass(taxonObservations, CALIFORNIA_HALIBUT_TAXON_ID);
  const observation = {
    contract_version: OBSERVATION_CONTRACT_VERSION,
    taxon_catalog_version: TAXON_CATALOG_VERSION,
    contract_status: "valid",
    observation_id: input.tripId,
    effort_segment_id: `${input.tripId}:full-trip`,
    primary_target_taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
    source: {
      source_id: "castingcompass-trip-log",
      source_record_id: input.tripId,
      data_kind: "complete-effort-segment",
      complete_attempt: true,
      expanded_estimate: false,
    },
    target_effort: {
      value: input.anglerHours,
      unit: "angler-hours",
      mode: input.mode,
    },
    temporal_support: {
      start_at: input.startedAt,
      end_at: input.endedAt,
      precision: input.temporalPrecision ?? "bounded",
    },
    spatial_support: {
      kind: "site",
      support_id: input.siteId,
    },
    taxon_observations: taxonObservations,
    outcome_class: outcomeClass,
  } as const;

  assertObservationContract(observation, { environment: "production" });
  return observation;
}

export function buildSpeciesObservationFields(input: SpeciesObservationInput) {
  const observation = buildSpeciesObservationContract(input);
  const targetObservation = observation.taxon_observations.find(
    (row) => row.taxon_id === CALIFORNIA_HALIBUT_TAXON_ID,
  );
  if (!targetObservation) throw new Error("Validated observation is missing its target row");
  const anyFishEncounterCount = observation.taxon_observations.reduce(
    (total, row) => total + row.encounter_count,
    0,
  );
  return {
    observationContractVersion: OBSERVATION_CONTRACT_VERSION,
    taxonCatalogVersion: TAXON_CATALOG_VERSION,
    targetTaxonId: CALIFORNIA_HALIBUT_TAXON_ID,
    contractStatus: "valid" as const,
    taxonObservationsJson: JSON.stringify(observation.taxon_observations),
    outcomeClass: observation.outcome_class,
    targetEncounterCount: targetObservation.encounter_count,
    anyFishEncounterCount,
    targetIdentificationConfidence: targetObservation.identification_confidence,
  };
}

export function createTripStore(db: D1DatabaseLike): TripStore {
  const initialize = async () => {
    let pending = initializedDatabases.get(db as object);
    if (!pending) {
      pending = (async () => {
        await db.batch([
          db.prepare(CREATE_TRIPS_SQL),
          db.prepare(CREATE_FORECAST_IMPRESSIONS_SQL),
          db.prepare(CREATE_TRIP_VALIDATION_PROVENANCE_SQL),
        ]);
        await db.batch(CREATE_INDEX_STATEMENTS.map((statement) => db.prepare(statement)));
      })().catch((error) => {
        initializedDatabases.delete(db as object);
        throw error;
      });
      initializedDatabases.set(db as object, pending);
    }
    await pending;
  };

  const getTrip = async (id: string) =>
    db.prepare("SELECT * FROM trips WHERE id = ? LIMIT 1").bind(id).first<TripRow>();

  return {
    initialize,

    async assertSubmissionAllowed(reporterKeyHash, now) {
      const hourCutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const dayCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const activeCutoff = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
      const [hour, day, active] = await Promise.all([
        db
          .prepare("SELECT COUNT(*) AS count FROM trips WHERE reporter_key_hash = ? AND created_at >= ?")
          .bind(reporterKeyHash, hourCutoff)
          .first<{ count: number }>(),
        db
          .prepare("SELECT COUNT(*) AS count FROM trips WHERE reporter_key_hash = ? AND created_at >= ?")
          .bind(reporterKeyHash, dayCutoff)
          .first<{ count: number }>(),
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM trips WHERE reporter_key_hash = ? AND status = 'active' AND created_at >= ?",
          )
          .bind(reporterKeyHash, activeCutoff)
          .first<{ count: number }>(),
      ]);

      if (Number(hour?.count ?? 0) >= 8 || Number(day?.count ?? 0) >= 30 || Number(active?.count ?? 0) >= 3) {
        throw new RateLimitError();
      }
    },

    async insertTrip(record, validation, feasibilityStart, feasibilityRecruitment) {
      const statements = [db.prepare(INSERT_TRIP_SQL).bind(
          record.id,
          record.userId,
          record.status,
          record.source,
          record.siteId,
          record.startedAt,
          record.endedAt,
          record.mode,
          record.fishingMethod,
          record.gear,
          record.gearProfileId,
          record.rod,
          record.reel,
          record.baitLure,
          record.rig,
          record.anglerCount,
          record.anglerHours,
          record.keeperCount,
          record.shortReleasedCount,
          record.halibutEncounters,
          record.noCatch === null ? null : Number(record.noCatch),
          record.otherCatchCount,
          record.otherSpecies,
          record.observationsJson,
          record.observationContractVersion,
          record.taxonCatalogVersion,
          record.targetTaxonId,
          record.contractStatus,
          record.taxonObservationsJson,
          record.outcomeClass,
          record.targetEncounterCount,
          record.anyFishEncounterCount,
          record.targetIdentificationConfidence,
          record.notes,
          Number(record.consent),
          record.consentAt,
          record.moderationStatus,
          record.reporterKeyHash,
          record.referralCode,
          record.tokenHash,
          record.idempotencyKeyHash,
          record.opportunityWindowId,
          record.opportunityScore,
          record.habitatScore,
          record.seasonalityScore,
          record.conditionsScore,
          record.fishabilityScore,
          record.modelVersion,
          record.scoreInfluencedChoice === null ? null : Number(record.scoreInfluencedChoice),
          record.predictionMetadataJson,
          record.photoKey,
          record.photoContentType,
          record.photoSizeBytes,
          record.createdAt,
          record.updatedAt,
          record.completedAt,
        )];
      if (validation?.impression) {
        statements.push(prepareForecastImpressionInsert(db, validation.impression));
      }
      if (validation) statements.push(prepareValidationProvenanceInsert(db, validation.provenance));
      if (feasibilityRecruitment) {
        statements.push(prepareFeasibilityRecruitmentInsert(db, feasibilityRecruitment));
      }
      if (feasibilityStart) statements.push(prepareFeasibilityEventInsert(db, feasibilityStart));
      await db.batch(statements);

      const inserted = await getTrip(record.id);
      if (!inserted) throw new Error("Trip insert did not return a record");
      return inserted;
    },

    getTrip,

    async getFeasibilityActivation(activationId) {
      return db.prepare(`SELECT id, protocol_id, protocol_version, protocol_sha256,
          activation_commitment_sha256, activation_manifest_sha256, site_catalog_sha256,
          scoring_system_kind, scoring_system_version, scoring_system_sha256,
          worker_version_id, study_consent_version, start_at, end_at,
          preregistered_at, receipt_verified_at, status
        FROM validation_feasibility_activations WHERE id = ? LIMIT 1`)
        .bind(activationId)
        .first<StoredFeasibilityActivation>();
    },

    async getFeasibilityRecruitment(activationId, participantGroupId) {
      return db.prepare(`SELECT event_id, activation_id, user_id, participant_group_id,
          event_contract_version, recruitment_frame_id, recruitment_source_id,
          selection_method, recruited_at, campaign_id, invite_issued_at, invite_expires_at,
          community_approval_sha256, event_sha256, created_at, snapshot_suppression_sha256
        FROM validation_feasibility_recruitment_events
        WHERE activation_id = ? AND participant_group_id = ? LIMIT 1`)
        .bind(activationId, participantGroupId)
        .first<StoredFeasibilityRecruitment>();
    },

    async getFeasibilityRecruitmentCampaign(activationId, campaignId) {
      return db.prepare(`SELECT activation_id, campaign_id, recruitment_source_id,
          selection_method, invite_issued_at, invite_expires_at,
          community_approval_sha256, token_payload_sha256, sealed_at
        FROM validation_feasibility_recruitment_campaigns
        WHERE activation_id = ? AND campaign_id = ? LIMIT 1`)
        .bind(activationId, campaignId)
        .first<StoredFeasibilityRecruitmentCampaign>();
    },

    async getFeasibilityStart(tripId) {
      return db.prepare(`SELECT activation_id, trip_id, event_sha256, source_record_sha256,
          participant_group_id, recruitment_frame_id, recruitment_source_id, selection_method,
          score_influenced_choice, study_consent_version, study_consented_at, target_taxon_id,
          site_id, geographic_panel, mode, segment_start_at, angler_count,
          scoring_system_kind, scoring_system_version, scoring_system_sha256,
          opportunity_score, opportunity_window_id, snapshot_sha256, snapshot_suppression_sha256
        FROM validation_feasibility_events
        WHERE trip_id = ? AND event_type = 'started' LIMIT 1`)
        .bind(tripId)
        .first<StoredFeasibilityStart>();
    },

    async getValidationEnrollment(tripId) {
      return db.prepare(`SELECT collection_contract_version, source_role, cohort_id,
          validation_protocol_id, activation_manifest_sha256, activated_at,
          activation_scoring_system_sha256, participant_group_id, recruitment_frame_id,
          recruitment_source_id, recruitment_event_contract_version, recruitment_event_at,
          recruitment_event_sha256, community_approval_sha256,
          assignment_id, source_record_sha256, effort_segment_id, effort_unit,
          attempt_count, target_taxon_id, segment_start_at, incentive_policy_id,
          selection_method, target_intent, primary_target_confirmed,
          complete_attempt_confirmed, mode_at_enrollment, consent_version,
          consented_at, score_influenced_choice, forecast_impression_id,
          attestation_status
        FROM trip_validation_provenance
        WHERE trip_id = ? AND event_type = 'enrollment'
        ORDER BY created_at ASC LIMIT 1`)
        .bind(tripId)
        .first<StoredValidationEnrollment>();
    },

    async getRecruitmentEvent(participantGroupId, activation) {
      return db.prepare(`SELECT participant_group_id, recruitment_frame_id,
          recruitment_source_id, recruitment_event_contract_version,
          recruitment_event_at, recruitment_event_sha256, community_approval_sha256
        FROM trip_validation_provenance
        WHERE participant_group_id = ?
          AND event_type = 'enrollment'
          AND source_role = 'prospective_secondary'
          AND validation_protocol_id = ?
          AND activation_manifest_sha256 = ?
          AND activated_at = ?
          AND activation_scoring_system_sha256 = ?
          AND recruitment_frame_id = ?
          AND recruitment_event_sha256 IS NOT NULL
        ORDER BY recruitment_event_at ASC, created_at ASC LIMIT 1`)
        .bind(
          participantGroupId,
          activation.protocolId,
          activation.manifestSha256,
          activation.activatedAt,
          activation.scoringSystemSha256,
          RECRUITMENT_FRAME_ID,
        )
        .first<StoredRecruitmentEvent>();
    },

    async getForecastImpression(tripId) {
      return db.prepare(`SELECT id, window_start, window_end, site_id
        FROM forecast_impressions WHERE trip_id = ? LIMIT 1`)
        .bind(tripId)
        .first<StoredForecastImpression>();
    },

    async completeTrip(id, tokenHash, completion, provenance, feasibilityTerminal) {
      const update = db.prepare(`UPDATE trips SET
          status = 'completed',
          opportunity_window_id = CASE WHEN mode = ? THEN opportunity_window_id ELSE NULL END,
          opportunity_score = CASE WHEN mode = ? THEN opportunity_score ELSE NULL END,
          habitat_score = CASE WHEN mode = ? THEN habitat_score ELSE NULL END,
          seasonality_score = CASE WHEN mode = ? THEN seasonality_score ELSE NULL END,
          conditions_score = CASE WHEN mode = ? THEN conditions_score ELSE NULL END,
          fishability_score = CASE WHEN mode = ? THEN fishability_score ELSE NULL END,
          model_version = CASE WHEN mode = ? THEN model_version ELSE NULL END,
          prediction_metadata_json = CASE WHEN mode = ? THEN prediction_metadata_json ELSE NULL END,
          ended_at = ?, mode = ?, fishing_method = ?, gear = ?,
          gear_profile_id = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?,
          angler_count = ?, angler_hours = ?, keeper_count = ?, short_released_count = ?,
          halibut_encounters = ?, no_catch = ?, other_catch_count = ?, other_species = ?, observations_json = ?,
          observation_contract_version = ?, taxon_catalog_version = ?, target_taxon_id = ?,
          contract_status = ?, taxon_observations_json = ?, outcome_class = ?,
          target_encounter_count = ?, any_fish_encounter_count = ?, target_identification_confidence = ?,
          notes = ?, consent = 1, consent_at = ?,
          moderation_status = 'pending', photo_key = ?,
          photo_content_type = ?, photo_size_bytes = ?, updated_at = ?, completed_at = ?, token_hash = NULL
        WHERE id = ? AND status = 'active' AND token_hash = ?`)
        .bind(
          completion.mode,
          completion.mode,
          completion.mode,
          completion.mode,
          completion.mode,
          completion.mode,
          completion.mode,
          completion.mode,
          completion.endedAt,
          completion.mode,
          completion.fishingMethod,
          completion.gear,
          completion.gearProfileId,
          completion.rod,
          completion.reel,
          completion.baitLure,
          completion.rig,
          completion.anglerCount,
          completion.anglerHours,
          completion.keeperCount,
          completion.shortReleasedCount,
          completion.halibutEncounters,
          Number(completion.noCatch),
          completion.otherCatchCount,
          completion.otherSpecies,
          completion.observationsJson,
          completion.observationContractVersion,
          completion.taxonCatalogVersion,
          completion.targetTaxonId,
          completion.contractStatus,
          completion.taxonObservationsJson,
          completion.outcomeClass,
          completion.targetEncounterCount,
          completion.anyFishEncounterCount,
          completion.targetIdentificationConfidence,
          completion.notes,
          completion.consentAt,
          completion.photoKey,
          completion.photoContentType,
          completion.photoSizeBytes,
          completion.updatedAt,
          completion.updatedAt,
          id,
          tokenHash,
        );

      const terminalStatements = [update];
      if (provenance) {
        terminalStatements.push(
          prepareConditionalCompletionProvenanceInsert(db, provenance, completion.updatedAt),
        );
      }
      if (feasibilityTerminal) {
        terminalStatements.push(
          prepareConditionalFeasibilityEventInsert(
            db,
            feasibilityTerminal,
            "completed",
            completion.updatedAt,
          ),
        );
      }
      const results = terminalStatements.length > 1
        ? await db.batch(terminalStatements)
        : [await update.run()];
      const result = results[0] as { meta?: { changes?: number } } | undefined;

      if (Number(result?.meta?.changes ?? 0) !== 1) return null;
      return getTrip(id);
    },

    async cancelTrip(id, tokenHash, timestamp, feasibilityTerminal) {
      const update = db.prepare(`UPDATE trips SET token_hash = NULL, updated_at = ?
        WHERE id = ? AND status = 'active' AND token_hash = ?`)
        .bind(timestamp, id, tokenHash);
      const results = feasibilityTerminal
        ? await db.batch([
            update,
            prepareConditionalFeasibilityEventInsert(db, feasibilityTerminal, "safe_canceled", timestamp),
          ])
        : [await update.run()];
      const result = results[0] as { meta?: { changes?: number } } | undefined;
      return Number(result?.meta?.changes ?? 0) === 1;
    },

    async getSummary(now) {
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const row = await db
        .prepare(`SELECT
          COUNT(*) AS completed_trips,
          COALESCE(SUM(CASE WHEN no_catch = 1 THEN 1 ELSE 0 END), 0) AS no_catch_trips,
          COALESCE(SUM(CASE WHEN halibut_encounters > 0 THEN 1 ELSE 0 END), 0) AS halibut_trips,
          COALESCE(SUM(angler_hours), 0) AS angler_hours,
          COALESCE(SUM(halibut_encounters), 0) AS halibut_encounters,
          COUNT(DISTINCT site_id) AS sites_covered,
          MAX(updated_at) AS last_updated,
          COALESCE(SUM(CASE WHEN completed_at >= ? THEN 1 ELSE 0 END), 0) AS recent_completed_trips,
          COALESCE(SUM(CASE WHEN completed_at >= ? THEN angler_hours ELSE 0 END), 0) AS recent_angler_hours,
          COALESCE(SUM(CASE WHEN completed_at >= ? THEN halibut_encounters ELSE 0 END), 0) AS recent_halibut_encounters,
          COUNT(DISTINCT CASE WHEN completed_at >= ? THEN site_id END) AS recent_sites_covered
        FROM trips
        WHERE status = 'completed' AND consent = 1 AND moderation_status != 'rejected'
          AND contract_status = 'valid' AND observation_contract_version = ?
          AND taxon_catalog_version = ? AND target_taxon_id = ?`)
        .bind(
          cutoff,
          cutoff,
          cutoff,
          cutoff,
          OBSERVATION_CONTRACT_VERSION,
          TAXON_CATALOG_VERSION,
          CALIFORNIA_HALIBUT_TAXON_ID,
        )
        .first<{
          completed_trips: number;
          no_catch_trips: number;
          halibut_trips: number;
          angler_hours: number;
          halibut_encounters: number;
          sites_covered: number;
          last_updated: string | null;
          recent_completed_trips: number;
          recent_angler_hours: number;
          recent_halibut_encounters: number;
          recent_sites_covered: number;
        }>();

      return {
        completedTrips: Number(row?.completed_trips ?? 0),
        noCatchTrips: Number(row?.no_catch_trips ?? 0),
        halibutTrips: Number(row?.halibut_trips ?? 0),
        totalHalibut: Number(row?.halibut_encounters ?? 0),
        anglerHours: round(Number(row?.angler_hours ?? 0), 2),
        halibutEncounters: Number(row?.halibut_encounters ?? 0),
        sitesCovered: Number(row?.sites_covered ?? 0),
        lastUpdated: row?.last_updated ?? null,
        past24Hours: {
          completedTrips: Number(row?.recent_completed_trips ?? 0),
          anglerHours: round(Number(row?.recent_angler_hours ?? 0), 2),
          halibutEncounters: Number(row?.recent_halibut_encounters ?? 0),
          sitesCovered: Number(row?.recent_sites_covered ?? 0),
        },
      };
    },
  };
}

function prepareForecastImpressionInsert(db: D1DatabaseLike, record: ForecastImpressionRecord) {
  return db.prepare(INSERT_FORECAST_IMPRESSION_SQL).bind(
    record.id,
    record.tripId,
    OPPORTUNITY_ATTESTATION_INDEX_VERSION,
    record.snapshotSha256,
    record.siteCatalogSha256,
    record.targetTaxonId,
    record.taxonCatalogVersion,
    record.observationContractVersion,
    record.modelRunContractVersion,
    record.opportunityContractVersion,
    record.scoringSystemKind,
    record.scoringSystemVersion,
    record.scoringSystemSha256,
    record.windowId,
    record.siteId,
    record.windowStart,
    record.windowEnd,
    record.opportunityScore,
    record.habitatScore,
    record.seasonalityScore,
    record.conditionsScore,
    record.fishabilityScore,
    record.attestedAt,
  );
}

function validationProvenanceBindings(record: ValidationProvenanceRecord) {
  return [
    record.id,
    record.tripId,
    record.eventType,
    record.collectionContractVersion,
    record.validationProtocolId,
    record.activationManifestSha256,
    record.activatedAt,
    record.activationScoringSystemSha256,
    record.cohortId,
    record.sourceRole,
    record.participantGroupId,
    record.recruitmentFrameId,
    record.recruitmentSourceId,
    record.recruitmentEventContractVersion,
    record.recruitmentEventAt,
    record.recruitmentEventSha256,
    record.communityApprovalSha256,
    record.assignmentId,
    record.sourceRecordSha256,
    record.effortSegmentId,
    record.effortUnit,
    record.attemptCount,
    record.targetTaxonId,
    record.segmentStartAt,
    record.segmentEndAt,
    record.modeAtCompletion,
    record.anglerCount,
    record.durationMilliseconds,
    record.personMilliseconds,
    record.completionEventContractVersion,
    record.completionEventAt,
    record.completionConsentVersion,
    record.completionConsentedAt,
    record.completionPrimaryTargetConfirmed === null
      ? null
      : Number(record.completionPrimaryTargetConfirmed),
    record.completionCompleteAttemptConfirmed === null
      ? null
      : Number(record.completionCompleteAttemptConfirmed),
    record.completionEventSha256,
    record.incentivePolicyId,
    record.selectionMethod,
    record.targetIntent,
    Number(record.primaryTargetConfirmed),
    record.completeAttemptConfirmed === null ? null : Number(record.completeAttemptConfirmed),
    record.modeAtEnrollment,
    record.consentVersion,
    record.consentedAt,
    record.scoreInfluencedChoice === null ? null : Number(record.scoreInfluencedChoice),
    record.attestationStatus,
    record.forecastImpressionId,
    record.completionAttestedAt,
    record.evidenceStatus,
    record.exclusionReason,
    record.createdAt,
  ];
}

function prepareValidationProvenanceInsert(db: D1DatabaseLike, record: ValidationProvenanceRecord) {
  return db.prepare(INSERT_VALIDATION_PROVENANCE_SQL).bind(...validationProvenanceBindings(record));
}

function feasibilityEventBindings(record: FeasibilityEventRecord): unknown[] {
  return [
    record.eventId,
    record.activationId,
    record.tripId,
    record.eventType,
    record.eventContractVersion,
    record.sourceRecordSha256,
    record.participantGroupId,
    record.recruitmentFrameId,
    record.recruitmentSourceId,
    record.selectionMethod,
    Number(record.scoreInfluencedChoice),
    record.studyConsentVersion,
    record.studyConsentedAt,
    record.targetTaxonId,
    record.siteId,
    record.geographicPanel,
    record.mode,
    record.segmentStartAt,
    record.segmentEndAt,
    record.anglerCount,
    record.effortMinutes,
    record.targetEncountered === null ? null : Number(record.targetEncountered),
    record.targetEncounterCount,
    record.targetRetainedCount,
    record.targetReleasedCount,
    record.identificationConfidence,
    record.scoringSystemKind,
    record.scoringSystemVersion,
    record.scoringSystemSha256,
    record.opportunityScore,
    record.opportunityWindowId,
    record.snapshotSha256,
    record.terminalReason,
    record.previousEventSha256,
    record.eventAt,
    record.eventSha256,
    record.snapshotSuppressionSha256,
  ];
}

function prepareFeasibilityEventInsert(db: D1DatabaseLike, record: FeasibilityEventRecord) {
  return db.prepare(INSERT_FEASIBILITY_EVENT_SQL).bind(...feasibilityEventBindings(record));
}

function prepareFeasibilityRecruitmentInsert(
  db: D1DatabaseLike,
  record: FeasibilityRecruitmentRecord,
) {
  return db.prepare(INSERT_FEASIBILITY_RECRUITMENT_SQL).bind(
    record.eventId,
    record.activationId,
    record.userId,
    record.participantGroupId,
    record.eventContractVersion,
    record.recruitmentFrameId,
    record.recruitmentSourceId,
    record.selectionMethod,
    record.recruitedAt,
    record.campaignId,
    record.inviteIssuedAt,
    record.inviteExpiresAt,
    record.communityApprovalSha256,
    record.eventSha256,
    record.createdAt,
    record.snapshotSuppressionSha256,
  );
}

function prepareConditionalFeasibilityEventInsert(
  db: D1DatabaseLike,
  record: FeasibilityEventRecord,
  terminalType: "completed" | "safe_canceled",
  timestamp: string,
) {
  const bindings = feasibilityEventBindings(record);
  const completedCondition = terminalType === "completed"
    ? "status = 'completed' AND completed_at = ?"
    : "status = 'active' AND updated_at = ?";
  return db.prepare(`INSERT INTO validation_feasibility_events (
      ${FEASIBILITY_EVENT_COLUMNS.join(", ")}
    ) SELECT ${bindings.map(() => "?").join(", ")}
    WHERE EXISTS (
      SELECT 1 FROM trips WHERE id = ? AND token_hash IS NULL AND ${completedCondition}
    )`).bind(...bindings, record.tripId, timestamp);
}

function prepareConditionalCompletionProvenanceInsert(
  db: D1DatabaseLike,
  record: ValidationProvenanceRecord,
  completedAt: string,
) {
  const placeholders = validationProvenanceBindings(record).map(() => "?").join(", ");
  return db.prepare(`INSERT INTO trip_validation_provenance (
      ${VALIDATION_PROVENANCE_COLUMNS.join(", ")}
    ) SELECT ${placeholders}
    WHERE EXISTS (
      SELECT 1 FROM trips WHERE id = ? AND status = 'completed'
        AND token_hash IS NULL AND completed_at = ?
    )`).bind(...validationProvenanceBindings(record), record.tripId, completedAt);
}

function forecastFieldsFromAttestation(
  opportunity: AttestedOpportunity | null,
  scoreInfluencedChoice: boolean,
) {
  if (!opportunity) {
    return {
      opportunityWindowId: null,
      opportunityScore: null,
      habitatScore: null,
      seasonalityScore: null,
      conditionsScore: null,
      fishabilityScore: null,
      modelVersion: null,
      scoreInfluencedChoice,
      predictionMetadataJson: null,
    };
  }

  return {
    opportunityWindowId: opportunity.windowId,
    opportunityScore: opportunity.opportunityScore,
    habitatScore: opportunity.habitatScore,
    seasonalityScore: opportunity.seasonalityScore,
    conditionsScore: opportunity.conditionsScore,
    fishabilityScore: opportunity.fishabilityScore,
    modelVersion: opportunity.scoringSystemVersion,
    scoreInfluencedChoice,
    predictionMetadataJson: JSON.stringify({
      attestationIndexVersion: OPPORTUNITY_ATTESTATION_INDEX_VERSION,
      attestationGeneratedAt: opportunity.generatedAt,
      snapshotSha256: opportunity.snapshotSha256,
      siteCatalogSha256: opportunity.siteCatalogSha256,
      targetTaxonId: opportunity.targetTaxonId,
      taxonCatalogVersion: opportunity.taxonCatalogVersion,
      observationContractVersion: opportunity.observationContractVersion,
      modelRunContractVersion: opportunity.modelRunContractVersion,
      opportunityContractVersion: opportunity.opportunityContractVersion,
      scoringSystemKind: opportunity.scoringSystemKind,
      scoringSystemVersion: opportunity.scoringSystemVersion,
      scoringSystemSha256: opportunity.scoringSystemSha256,
      windowStart: opportunity.windowStart,
      windowEnd: opportunity.windowEnd,
    }),
  };
}

function strictActivationTimestamp(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate || !STRICT_UTC_TIMESTAMP_PATTERN.test(candidate) || candidate.startsWith("0000-")) return null;
  const date = new Date(candidate);
  const normalizedInput = candidate.includes(".") ? candidate : candidate.replace("Z", ".000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalizedInput) return null;
  return date.toISOString();
}

function recruitmentEventPayload(event: {
  participantGroupId: string;
  recruitmentFrameId: string;
  recruitmentSourceId: string;
  recruitmentEventAt: string;
  communityApprovalSha256: string | null;
}) {
  // Insertion order is the RFC 8785 lexicographic key order. Values are strings/null,
  // so JSON.stringify produces the canonical bytes hashed by this fixed contract.
  return JSON.stringify({
    community_approval_sha256: event.communityApprovalSha256,
    participant_group_id: event.participantGroupId,
    recruitment_event_at: event.recruitmentEventAt,
    recruitment_frame_id: event.recruitmentFrameId,
    recruitment_source_id: event.recruitmentSourceId,
  });
}

async function prepareOrganicRecruitmentEvent(
  store: TripStore,
  participantGroupId: string,
  timestamp: string,
  activation: ValidationActivationRecord,
): Promise<RecruitmentEventRecord | null> {
  const existing = await store.getRecruitmentEvent?.(participantGroupId, activation);
  if (existing) {
    const event: RecruitmentEventRecord = {
      participantGroupId: existing.participant_group_id,
      recruitmentFrameId: existing.recruitment_frame_id,
      recruitmentSourceId: existing.recruitment_source_id,
      recruitmentEventContractVersion: existing.recruitment_event_contract_version,
      recruitmentEventAt: existing.recruitment_event_at,
      recruitmentEventSha256: existing.recruitment_event_sha256,
      communityApprovalSha256: existing.community_approval_sha256,
    };
    const canonicalEventAt = strictActivationTimestamp(event.recruitmentEventAt);
    const communityApprovalValid = event.recruitmentSourceId === "admin-approved-community-prospective"
      ? Boolean(event.communityApprovalSha256 && SHA256_PATTERN.test(event.communityApprovalSha256))
      : event.communityApprovalSha256 === null;
    if (
      event.participantGroupId !== participantGroupId ||
      event.recruitmentFrameId !== RECRUITMENT_FRAME_ID ||
      event.recruitmentEventContractVersion !== RECRUITMENT_EVENT_CONTRACT_VERSION ||
      !ALLOWED_RECRUITMENT_SOURCE_IDS.has(event.recruitmentSourceId) ||
      canonicalEventAt !== event.recruitmentEventAt ||
      Date.parse(event.recruitmentEventAt) > Date.parse(timestamp) ||
      !SHA256_PATTERN.test(event.recruitmentEventSha256) ||
      !communityApprovalValid ||
      await sha256(recruitmentEventPayload(event)) !== event.recruitmentEventSha256
    ) return null;
    return event;
  }

  const event = {
    participantGroupId,
    recruitmentFrameId: RECRUITMENT_FRAME_ID,
    recruitmentSourceId: ORGANIC_RECRUITMENT_SOURCE_ID,
    recruitmentEventContractVersion: RECRUITMENT_EVENT_CONTRACT_VERSION,
    recruitmentEventAt: timestamp,
    communityApprovalSha256: null,
  };
  return {
    ...event,
    recruitmentEventSha256: await sha256(recruitmentEventPayload(event)),
  };
}

async function validationCollectionIdentity(
  tripId: string,
  protocolId: string,
): Promise<ValidationCollectionIdentity> {
  const sourceRecordSha256 = await sha256(`${VALIDATION_SOURCE_RECORD_DOMAIN}\u0000${tripId}`);
  const effortSegmentSha256 = await sha256(`${VALIDATION_EFFORT_SEGMENT_DOMAIN}\u0000${tripId}`);
  const assignmentSha256 = await sha256(
    `${VALIDATION_ASSIGNMENT_DOMAIN}\u0000${protocolId}\u0000${sourceRecordSha256}`,
  );
  return {
    assignmentId: `assignment-${assignmentSha256}`,
    sourceRecordSha256,
    effortSegmentId: `effort-${effortSegmentSha256}`,
  };
}

function canonicalCompletionEventPayload(input: {
  activationManifestSha256: string;
  anglerCount: number;
  assignmentId: string;
  cohortId: string;
  completionEventAt: string;
  durationMilliseconds: number;
  effortSegmentId: string;
  incentivePolicyId: string;
  mode: string;
  participantGroupId: string;
  personMilliseconds: number;
  segmentEndAt: string;
  segmentStartAt: string;
  sourceRecordSha256: string;
}) {
  // Keys are inserted in lexicographic order and every value is ASCII scalar data.
  return JSON.stringify({
    activation_manifest_sha256: input.activationManifestSha256,
    angler_count: input.anglerCount,
    assignment_id: input.assignmentId,
    attempt_count: 1,
    cohort_id: input.cohortId,
    completion_complete_attempt_confirmed: true,
    completion_consent_version: TRIP_VALIDATION_CONSENT_VERSION,
    completion_consented_at: input.completionEventAt,
    completion_event_at: input.completionEventAt,
    completion_event_contract_version: VALIDATION_COMPLETION_EVENT_CONTRACT_VERSION,
    completion_primary_target_confirmed: true,
    duration_milliseconds: input.durationMilliseconds,
    effort_segment_id: input.effortSegmentId,
    effort_unit: VALIDATION_EFFORT_UNIT,
    incentive_policy_id: input.incentivePolicyId,
    mode: input.mode,
    participant_group_id: input.participantGroupId,
    person_milliseconds: input.personMilliseconds,
    segment_end_at: input.segmentEndAt,
    segment_start_at: input.segmentStartAt,
    source_record_sha256: input.sourceRecordSha256,
    target_taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
  });
}

function validationActivation(
  env: TripApiEnv,
  startedAt: string,
  enrolledAt: string,
  opportunity: AttestedOpportunity | null,
): ValidationActivationRecord | null {
  if (env.VALIDATION_OBSERVATIONAL_SECONDARY_ENABLED?.trim().toLowerCase() !== "true") return null;
  if (env.VALIDATION_PROTOCOL_ID?.trim() !== VALIDATION_PROTOCOL_ID) return null;
  const cohortId = env.VALIDATION_COHORT_ID?.trim();
  if (cohortId !== VALIDATION_SECONDARY_COHORT_ID) return null;
  const manifestSha256 = env.VALIDATION_ACTIVATION_MANIFEST_SHA256?.trim();
  const scoringSystemSha256 = env.VALIDATION_ACTIVATION_SCORING_SHA256?.trim();
  const activatedAt = strictActivationTimestamp(env.VALIDATION_ACTIVATED_AT);
  if (
    !opportunity ||
    !manifestSha256 ||
    !SHA256_PATTERN.test(manifestSha256) ||
    !scoringSystemSha256 ||
    !SHA256_PATTERN.test(scoringSystemSha256) ||
    scoringSystemSha256 !== opportunity.scoringSystemSha256 ||
    !activatedAt
  ) return null;
  const startedAtMs = Date.parse(startedAt);
  const enrolledAtMs = Date.parse(enrolledAt);
  const activatedAtMs = Date.parse(activatedAt);
  if (
    startedAtMs < VALIDATION_ENROLLMENT_START_MS ||
    startedAtMs >= VALIDATION_ENROLLMENT_END_EXCLUSIVE_MS ||
    activatedAtMs >= startedAtMs ||
    activatedAtMs >= enrolledAtMs ||
    activatedAtMs >= VALIDATION_ENROLLMENT_START_MS
  ) return null;
  return {
    protocolId: VALIDATION_PROTOCOL_ID,
    cohortId,
    manifestSha256,
    activatedAt,
    scoringSystemSha256,
  };
}

function buildLiveValidationBundle(input: {
  tripId: string;
  mode: string;
  scoreInfluencedChoice: boolean;
  timestamp: string;
  serverBoundLiveStart: boolean;
  activation: ValidationActivationRecord | null;
  recruitmentEvent: RecruitmentEventRecord | null;
  collectionIdentity: ValidationCollectionIdentity | null;
  attestationStatus: OpportunityAttestationStatus;
  opportunity: AttestedOpportunity | null;
}): ValidationPersistenceBundle {
  const impression = input.opportunity
    ? {
        ...input.opportunity,
        id: `impression_${crypto.randomUUID()}`,
        tripId: input.tripId,
        attestedAt: input.timestamp,
      }
    : null;
  const eligibleMode = VALIDATION_ELIGIBLE_MODES.has(input.mode);
  const prospectiveSecondary = Boolean(
    input.activation && impression && input.attestationStatus === "verified" && input.serverBoundLiveStart &&
      input.recruitmentEvent && input.collectionIdentity && eligibleMode,
  );
  const exclusionReason = !input.activation
    ? "prospective_collection_not_active"
    : input.attestationStatus !== "verified" || !impression
      ? `forecast_${input.attestationStatus}`
      : !input.serverBoundLiveStart
        ? "late_start_not_preoutcome"
        : !input.recruitmentEvent
          ? "recruitment_event_unverified"
          : !input.collectionIdentity
            ? "collection_identity_unavailable"
            : !eligibleMode
              ? "unsupported_validation_mode"
              : null;

  return {
    impression,
    provenance: {
      id: `validation_${crypto.randomUUID()}`,
      tripId: input.tripId,
      eventType: "enrollment",
      collectionContractVersion: VALIDATION_COLLECTION_CONTRACT_VERSION,
      validationProtocolId: input.activation?.protocolId ?? null,
      activationManifestSha256: input.activation?.manifestSha256 ?? null,
      activatedAt: input.activation?.activatedAt ?? null,
      activationScoringSystemSha256: input.activation?.scoringSystemSha256 ?? null,
      cohortId: input.activation?.cohortId ?? DEFAULT_VALIDATION_COHORT_ID,
      // Organic score-visible selection can be secondary observational evidence only.
      sourceRole: prospectiveSecondary ? "prospective_secondary" : "context_only",
      participantGroupId: input.recruitmentEvent?.participantGroupId ?? null,
      recruitmentFrameId: input.recruitmentEvent?.recruitmentFrameId ?? null,
      recruitmentSourceId: input.recruitmentEvent?.recruitmentSourceId ?? ORGANIC_RECRUITMENT_SOURCE_ID,
      recruitmentEventContractVersion: input.recruitmentEvent?.recruitmentEventContractVersion ?? null,
      recruitmentEventAt: input.recruitmentEvent?.recruitmentEventAt ?? null,
      recruitmentEventSha256: input.recruitmentEvent?.recruitmentEventSha256 ?? null,
      communityApprovalSha256: input.recruitmentEvent?.communityApprovalSha256 ?? null,
      assignmentId: input.collectionIdentity?.assignmentId ?? null,
      sourceRecordSha256: input.collectionIdentity?.sourceRecordSha256 ?? null,
      effortSegmentId: input.collectionIdentity?.effortSegmentId ?? null,
      effortUnit: input.collectionIdentity ? VALIDATION_EFFORT_UNIT : null,
      attemptCount: input.collectionIdentity ? 1 : null,
      targetTaxonId: input.collectionIdentity ? CALIFORNIA_HALIBUT_TAXON_ID : null,
      segmentStartAt: input.collectionIdentity ? input.timestamp : null,
      segmentEndAt: null,
      modeAtCompletion: null,
      anglerCount: null,
      durationMilliseconds: null,
      personMilliseconds: null,
      completionEventContractVersion: null,
      completionEventAt: null,
      completionConsentVersion: null,
      completionConsentedAt: null,
      completionPrimaryTargetConfirmed: null,
      completionCompleteAttemptConfirmed: null,
      completionEventSha256: null,
      incentivePolicyId: DEFAULT_INCENTIVE_POLICY_ID,
      selectionMethod: impression ? "organic_score_visible" : "organic_unverified",
      targetIntent: "california-halibut-primary-full-trip",
      primaryTargetConfirmed: true,
      completeAttemptConfirmed: null,
      modeAtEnrollment: input.mode,
      consentVersion: TRIP_VALIDATION_CONSENT_VERSION,
      consentedAt: input.timestamp,
      scoreInfluencedChoice: input.scoreInfluencedChoice,
      attestationStatus: input.attestationStatus,
      forecastImpressionId: impression?.id ?? null,
      completionAttestedAt: null,
      evidenceStatus: prospectiveSecondary ? "secondary_pending_review" : "context_only",
      exclusionReason,
      createdAt: input.timestamp,
    },
  };
}

async function buildCompletionProvenance(input: {
  trip: TripRow;
  endedAt: string;
  mode: string;
  anglerCount: number;
  timestamp: string;
  enrollment: StoredValidationEnrollment | null;
  impression: StoredForecastImpression | null;
}): Promise<ValidationProvenanceRecord> {
  const enrollmentImpressionMatches = Boolean(
    input.impression && input.enrollment?.forecast_impression_id === input.impression.id,
  );
  const insideWindow = Boolean(
    input.impression &&
    input.impression.site_id === input.trip.site_id &&
    Date.parse(input.trip.started_at) >= Date.parse(input.impression.window_start) &&
    Date.parse(input.endedAt) <= Date.parse(input.impression.window_end),
  );
  const enrollmentModeMatches = input.enrollment?.mode_at_enrollment === input.mode;
  const eligibleMode = VALIDATION_ELIGIBLE_MODES.has(input.mode);
  const durationMilliseconds = Date.parse(input.endedAt) - Date.parse(input.trip.started_at);
  const completionIdentityAvailable = Boolean(
    input.enrollment?.assignment_id && input.enrollment.source_record_sha256 &&
      input.enrollment.effort_segment_id && input.enrollment.participant_group_id &&
      input.enrollment.activation_manifest_sha256 && input.enrollment.cohort_id &&
      input.enrollment.incentive_policy_id && input.enrollment.segment_start_at &&
      input.enrollment.target_taxon_id === CALIFORNIA_HALIBUT_TAXON_ID &&
      input.enrollment.effort_unit === VALIDATION_EFFORT_UNIT &&
      input.enrollment.attempt_count === 1 && Number.isSafeInteger(durationMilliseconds) &&
      durationMilliseconds >= 60_000 && durationMilliseconds <= 36 * 60 * 60 * 1_000 &&
      Date.parse(input.timestamp) >= Date.parse(input.endedAt),
  );
  const personMilliseconds = completionIdentityAvailable
    ? durationMilliseconds * input.anglerCount
    : null;
  const completionEventSha256 = completionIdentityAvailable && personMilliseconds !== null
    ? await sha256(canonicalCompletionEventPayload({
        activationManifestSha256: input.enrollment!.activation_manifest_sha256!,
        anglerCount: input.anglerCount,
        assignmentId: input.enrollment!.assignment_id!,
        cohortId: input.enrollment!.cohort_id,
        completionEventAt: input.timestamp,
        durationMilliseconds,
        effortSegmentId: input.enrollment!.effort_segment_id!,
        incentivePolicyId: input.enrollment!.incentive_policy_id,
        mode: input.mode,
        participantGroupId: input.enrollment!.participant_group_id!,
        personMilliseconds,
        segmentEndAt: input.endedAt,
        segmentStartAt: input.enrollment!.segment_start_at!,
        sourceRecordSha256: input.enrollment!.source_record_sha256!,
      }))
    : null;
  const remainsProspectiveSecondary = Boolean(
    input.enrollment?.source_role === "prospective_secondary" &&
    enrollmentImpressionMatches &&
    insideWindow &&
    enrollmentModeMatches &&
    eligibleMode &&
    completionEventSha256,
  );
  const exclusionReason = !input.enrollment
    ? "missing_preoutcome_enrollment"
    : !enrollmentImpressionMatches
      ? "missing_authoritative_impression"
      : !enrollmentModeMatches
        ? "mode_changed_after_enrollment"
        : !eligibleMode
          ? "unsupported_validation_mode"
          : !insideWindow
            ? "trip_outside_attested_window"
            : input.enrollment.source_role !== "prospective_secondary"
              ? "enrollment_context_only"
              : !completionEventSha256
                ? "completion_identity_unavailable"
                : null;

  return {
    id: `validation_${crypto.randomUUID()}`,
    tripId: input.trip.id,
    eventType: "completion",
    collectionContractVersion:
      input.enrollment?.collection_contract_version ?? VALIDATION_COLLECTION_CONTRACT_VERSION,
    validationProtocolId: input.enrollment?.validation_protocol_id ?? null,
    activationManifestSha256: input.enrollment?.activation_manifest_sha256 ?? null,
    activatedAt: input.enrollment?.activated_at ?? null,
    activationScoringSystemSha256: input.enrollment?.activation_scoring_system_sha256 ?? null,
    cohortId: input.enrollment?.cohort_id ?? DEFAULT_VALIDATION_COHORT_ID,
    sourceRole: remainsProspectiveSecondary ? "prospective_secondary" : "context_only",
    participantGroupId: input.enrollment?.participant_group_id ?? null,
    recruitmentFrameId: input.enrollment?.recruitment_frame_id ?? null,
    recruitmentSourceId: input.enrollment?.recruitment_source_id ?? "legacy-unknown",
    recruitmentEventContractVersion: input.enrollment?.recruitment_event_contract_version ?? null,
    recruitmentEventAt: input.enrollment?.recruitment_event_at ?? null,
    recruitmentEventSha256: input.enrollment?.recruitment_event_sha256 ?? null,
    communityApprovalSha256: input.enrollment?.community_approval_sha256 ?? null,
    assignmentId: completionIdentityAvailable ? input.enrollment?.assignment_id ?? null : null,
    sourceRecordSha256: completionIdentityAvailable
      ? input.enrollment?.source_record_sha256 ?? null
      : null,
    effortSegmentId: completionIdentityAvailable ? input.enrollment?.effort_segment_id ?? null : null,
    effortUnit: completionIdentityAvailable ? VALIDATION_EFFORT_UNIT : null,
    attemptCount: completionIdentityAvailable ? 1 : null,
    targetTaxonId: completionIdentityAvailable ? CALIFORNIA_HALIBUT_TAXON_ID : null,
    segmentStartAt: completionIdentityAvailable ? input.enrollment?.segment_start_at ?? null : null,
    segmentEndAt: completionIdentityAvailable ? input.endedAt : null,
    modeAtCompletion: completionIdentityAvailable ? input.mode : null,
    anglerCount: completionIdentityAvailable ? input.anglerCount : null,
    durationMilliseconds: completionIdentityAvailable ? durationMilliseconds : null,
    personMilliseconds,
    completionEventContractVersion: completionIdentityAvailable
      ? VALIDATION_COMPLETION_EVENT_CONTRACT_VERSION
      : null,
    completionEventAt: completionIdentityAvailable ? input.timestamp : null,
    completionConsentVersion: completionIdentityAvailable ? TRIP_VALIDATION_CONSENT_VERSION : null,
    completionConsentedAt: completionIdentityAvailable ? input.timestamp : null,
    completionPrimaryTargetConfirmed: completionIdentityAvailable ? true : null,
    completionCompleteAttemptConfirmed: completionIdentityAvailable ? true : null,
    completionEventSha256,
    incentivePolicyId: input.enrollment?.incentive_policy_id ?? DEFAULT_INCENTIVE_POLICY_ID,
    selectionMethod: input.enrollment?.selection_method ?? "organic_unverified",
    targetIntent: "california-halibut-primary-full-trip",
    primaryTargetConfirmed: true,
    completeAttemptConfirmed: true,
    modeAtEnrollment: input.enrollment?.mode_at_enrollment ?? input.trip.mode,
    consentVersion: TRIP_VALIDATION_CONSENT_VERSION,
    consentedAt: input.timestamp,
    scoreInfluencedChoice: input.enrollment
      ? input.enrollment.score_influenced_choice === null
        ? null
        : Boolean(input.enrollment.score_influenced_choice)
      : input.trip.score_influenced_choice === null
        ? null
        : Boolean(input.trip.score_influenced_choice),
    attestationStatus: enrollmentImpressionMatches ? "verified" : "unverified_missing",
    forecastImpressionId: enrollmentImpressionMatches ? input.impression?.id ?? null : null,
    completionAttestedAt: input.timestamp,
    evidenceStatus: remainsProspectiveSecondary ? "secondary_pending_review" : "context_only",
    exclusionReason,
    createdAt: input.timestamp,
  };
}

function buildRetrospectiveValidationBundle(input: {
  tripId: string;
  mode: string;
  scoreInfluencedChoice: boolean;
  timestamp: string;
}): ValidationPersistenceBundle {
  return {
    impression: null,
    provenance: {
      id: `validation_${crypto.randomUUID()}`,
      tripId: input.tripId,
      eventType: "retrospective_submission",
      collectionContractVersion: VALIDATION_COLLECTION_CONTRACT_VERSION,
      validationProtocolId: null,
      activationManifestSha256: null,
      activatedAt: null,
      activationScoringSystemSha256: null,
      cohortId: DEFAULT_VALIDATION_COHORT_ID,
      sourceRole: "context_only",
      participantGroupId: null,
      recruitmentFrameId: null,
      recruitmentSourceId: "retrospective-self-report",
      recruitmentEventContractVersion: null,
      recruitmentEventAt: null,
      recruitmentEventSha256: null,
      communityApprovalSha256: null,
      assignmentId: null,
      sourceRecordSha256: null,
      effortSegmentId: null,
      effortUnit: null,
      attemptCount: null,
      targetTaxonId: null,
      segmentStartAt: null,
      segmentEndAt: null,
      modeAtCompletion: null,
      anglerCount: null,
      durationMilliseconds: null,
      personMilliseconds: null,
      completionEventContractVersion: null,
      completionEventAt: null,
      completionConsentVersion: null,
      completionConsentedAt: null,
      completionPrimaryTargetConfirmed: null,
      completionCompleteAttemptConfirmed: null,
      completionEventSha256: null,
      incentivePolicyId: DEFAULT_INCENTIVE_POLICY_ID,
      selectionMethod: "retrospective_self_report",
      targetIntent: "california-halibut-primary-full-trip",
      primaryTargetConfirmed: true,
      completeAttemptConfirmed: true,
      modeAtEnrollment: input.mode,
      consentVersion: TRIP_VALIDATION_CONSENT_VERSION,
      consentedAt: input.timestamp,
      scoreInfluencedChoice: input.scoreInfluencedChoice,
      attestationStatus: "not_applicable_retrospective",
      forecastImpressionId: null,
      completionAttestedAt: input.timestamp,
      evidenceStatus: "context_only",
      exclusionReason: "retrospective_report_not_preoutcome",
      createdAt: input.timestamp,
    },
  };
}

export async function handleTripRequest(
  request: Request,
  env: TripApiEnv,
  curatedSites: readonly CuratedSite[],
  options: TripHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/trips")) return null;

  const now = options.now?.() ?? new Date();
  const siteMap = new Map(curatedSites.map((site) => [site.id, site]));

  try {
    const store = options.store ?? (env.DB ? createTripStore(env.DB) : null);
    if (!store) throw new ApiError(503, "storage_unavailable", "Trip storage is temporarily unavailable.");
    await store.initialize();

    if (url.pathname === "/api/trips/summary") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse(await store.getSummary(now));
    }

    if (request.method !== "POST") return methodNotAllowed("POST");
    assertSameOrigin(request);

    if (url.pathname === "/api/trips/start") {
      assertContentType(request, "application/json");
      assertBodySize(request, 64 * 1024);
      const body = await readJsonObject(request);
      assertNoObservationContractOverride(body);
      assertOnlyInputFields(body, LIVE_START_FIELDS);
      assertHoneypot(body.website);
      assertConsent(body.consent);
      assertPrimaryTargetConfirmed(body.primaryTargetConfirmed);

      const reporter = await getOrCreateReporter(request, body.reporterKey);
      const id = parseClientTripId(body.clientTripId);
      const token = parseRequestToken(body.requestToken);
      const idempotencyKeyHash = await sha256(token);
      const existingRequest = await store.getTrip(id);
      if (existingRequest) {
        if (isMatchingLiveStart(existingRequest, idempotencyKeyHash, reporter.hash, options.accountId)) {
          return jsonResponse({
            trip: publicTrip(existingRequest),
            token,
            receipt: { operation: "start", tripId: id },
          }, 201, reporter.setCookie);
        }
        throw new ApiError(409, "trip_request_conflict", "This trip request identity cannot be reused.");
      }
      await store.assertSubmissionAllowed(reporter.hash, now);
      const site = getSite(siteMap, body.siteId);
      const submittedStartedAt = parseStartDate(body.startedAt, now, 48);
      const mode = parseRequiredMode(body.mode);
      const scoreInfluencedChoice = requiredScoreInfluence(body);
      const referralCode = parseReferralCode(body.referralCode);
      const timestamp = now.toISOString();
      const serverBoundLiveStart = Math.abs(Date.parse(submittedStartedAt) - now.getTime()) <=
        MAX_LIVE_START_CLOCK_SKEW_MS;
      if (!serverBoundLiveStart) {
        throw new ApiError(
          422,
          "live_start_must_be_now",
          "Live trips start when submitted. Use Log a past trip for an earlier start.",
        );
      }
      const startedAt = timestamp;
      const attestation = await verifyOpportunityAttestation(env.ASSETS, request.url, {
        windowId: body.opportunityWindowId,
        siteId: site.id,
        startedAt,
      });
      let feasibilityStart: FeasibilityEventRecord | null = null;
      let feasibilityRecruitment: FeasibilityRecruitmentRecord | null = null;
      if (feasibilityPilotEnabled(env) && optionalBoolean(body.studyConsent, "studyConsent") === true) {
        const studyConsentVersion = optionalText(body.studyConsentVersion, "studyConsentVersion", 200);
        if (!studyConsentVersion) {
          throw new ApiError(
            422,
            "study_consent_version_required",
            "The active study consent version is required for pilot participation.",
          );
        }
        const activationId = env.VALIDATION_FEASIBILITY_ACTIVATION_ID?.trim();
        if (
          !activationId || !store.getFeasibilityActivation || !store.getFeasibilityRecruitment ||
          !store.getFeasibilityRecruitmentCampaign ||
          !attestation.opportunity || !options.accountId
        ) {
          throw new ApiError(503, "validation_pilot_unavailable", "The validation pilot is not available right now.");
        }
        const storedActivation = await store.getFeasibilityActivation(activationId);
        const context = await resolveFeasibilityContext({
          env,
          activation: storedActivation,
          accountId: options.accountId,
          opportunity: attestation.status === "verified" ? attestation.opportunity : null,
          timestamp,
          studyConsent: true,
          studyConsentVersion,
        });
        if (!context) {
          throw new ApiError(503, "validation_pilot_unavailable", "The validation pilot is not available right now.");
        }
        const existingRecruitment = await store.getFeasibilityRecruitment(
          activationId,
          context.participantGroupId,
        );
        const recruitmentToken = optionalText(body.recruitmentToken, "recruitmentToken", 2_048);
        const campaignReference = recruitmentToken && !existingRecruitment
          ? feasibilityRecruitmentCampaignReference(recruitmentToken)
          : null;
        if (
          recruitmentToken && !existingRecruitment &&
          (!campaignReference || campaignReference.activationId !== activationId)
        ) {
          throw new ApiError(
            422,
            "validation_recruitment_invalid",
            "The validation-pilot recruitment invitation is invalid or expired.",
          );
        }
        const recruitmentCampaign = campaignReference
          ? await store.getFeasibilityRecruitmentCampaign(activationId, campaignReference.campaignId)
          : null;
        const resolvedRecruitment = await resolveFeasibilityRecruitment({
          env,
          activation: context.activation,
          accountId: options.accountId,
          participantGroupId: context.participantGroupId,
          timestamp,
          recruitmentToken,
          campaign: recruitmentCampaign,
          existing: existingRecruitment,
        });
        if (!resolvedRecruitment) {
          throw new ApiError(
            422,
            "validation_recruitment_invalid",
            "The validation-pilot recruitment invitation is invalid or expired.",
          );
        }
        feasibilityRecruitment = resolvedRecruitment.isNew ? resolvedRecruitment.record : null;
        feasibilityStart = await buildFeasibilityStartEvent({
          context,
          recruitment: resolvedRecruitment.record,
          tripId: id,
          opportunity: attestation.opportunity,
          siteId: site.id,
          mode,
          anglerCount: parseInteger(body.anglerCount, "anglerCount", 1, 12, 1),
          scoreInfluencedChoice,
          timestamp,
        });
        if (!feasibilityStart) {
          throw new ApiError(
            422,
            "validation_pilot_ineligible_trip",
            "This trip is outside the active validation pilot contract.",
          );
        }
      }
      const activation = validationActivation(env, startedAt, timestamp, attestation.opportunity);
      const eligibleRecruitmentCandidate = Boolean(
        activation && attestation.status === "verified" && attestation.opportunity &&
          serverBoundLiveStart && VALIDATION_ELIGIBLE_MODES.has(mode),
      );
      const participantGroupId = eligibleRecruitmentCandidate
        ? `participant-${await sha256(`${VALIDATION_PARTICIPANT_TOKEN_DOMAIN}\u0000${reporter.hash}`)}`
        : null;
      const recruitmentEvent = activation && participantGroupId
        ? await prepareOrganicRecruitmentEvent(store, participantGroupId, timestamp, activation)
        : null;
      const collectionIdentity = activation && recruitmentEvent
        ? await validationCollectionIdentity(id, activation.protocolId)
        : null;
      const validation = buildLiveValidationBundle({
        tripId: id,
        mode,
        scoreInfluencedChoice,
        timestamp,
        serverBoundLiveStart,
        activation,
        recruitmentEvent,
        collectionIdentity,
        attestationStatus: attestation.status,
        opportunity: attestation.opportunity,
      });

      let trip: TripRow;
      try {
        trip = await store.insertTrip({
          id,
          userId: options.accountId ?? null,
          status: "active",
          source: "live",
          siteId: site.id,
          startedAt,
          endedAt: null,
          mode,
          fishingMethod: optionalText(body.method ?? body.fishingMethod, "method", 80),
          ...parseTripDetails(body),
          anglerCount: parseInteger(body.anglerCount, "anglerCount", 1, 12, 1),
          anglerHours: null,
          keeperCount: null,
          shortReleasedCount: null,
          halibutEncounters: null,
          noCatch: null,
          observationContractVersion: null,
          taxonCatalogVersion: null,
          targetTaxonId: CALIFORNIA_HALIBUT_TAXON_ID,
          contractStatus: null,
          taxonObservationsJson: null,
          outcomeClass: null,
          targetEncounterCount: null,
          anyFishEncounterCount: null,
          targetIdentificationConfidence: null,
          notes: null,
          consent: true,
          consentAt: timestamp,
          moderationStatus: "pending",
          reporterKeyHash: reporter.hash,
          referralCode,
          tokenHash: idempotencyKeyHash,
          idempotencyKeyHash,
          ...forecastFieldsFromAttestation(attestation.opportunity, scoreInfluencedChoice),
          photoKey: null,
          photoContentType: null,
          photoSizeBytes: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
        }, validation, feasibilityStart, feasibilityRecruitment);
      } catch (error) {
        const racedTrip = await store.getTrip(id);
        if (!racedTrip || !isMatchingLiveStart(racedTrip, idempotencyKeyHash, reporter.hash, options.accountId)) {
          throw error;
        }
        trip = racedTrip;
      }

      return jsonResponse({
        trip: publicTrip(trip),
        token,
        receipt: { operation: "start", tripId: id },
      }, 201, reporter.setCookie);
    }

    const cancellationMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/cancel$/);
    if (cancellationMatch) {
      assertContentType(request, "application/json");
      assertBodySize(request, 16 * 1024);
      const body = await readJsonObject(request);
      assertOnlyInputFields(body, ["token", "reason"]);
      const id = cancellationMatch[1];
      if (!TRIP_ID_PATTERN.test(id)) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }
      const token = requiredText(body.token, "token", 160);
      if (!REQUEST_TOKEN_PATTERN.test(token)) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }
      const reason = parseSafeCancellationReason(body.reason);
      const existing = await store.getTrip(id);
      if (!existing || existing.status !== "active" || !store.cancelTrip) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }
      const timestamp = now.toISOString();
      const feasibilityStart = await (store.getFeasibilityStart?.(id) ?? Promise.resolve(null));
      const feasibilityTerminal = feasibilityStart
        ? await buildFeasibilityCancellationEvent({ start: feasibilityStart, timestamp, reason })
        : null;
      if (feasibilityStart && !feasibilityTerminal) {
        throw new ApiError(409, "validation_pilot_terminal_invalid", "The pilot cancellation could not be reconciled.");
      }
      const canceled = await store.cancelTrip(id, await sha256(token), timestamp, feasibilityTerminal);
      if (!canceled) throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      return jsonResponse({ canceled: true, id, reason });
    }

    const completionMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/complete$/);
    if (completionMatch) {
      assertContentType(request, "multipart/form-data");
      assertBodySize(request, MAX_MULTIPART_BYTES);
      const form = await request.formData();
      assertNoObservationContractOverride(form);
      assertOnlyInputFields(form, LIVE_COMPLETION_FIELDS);
      assertHoneypot(form.get("website"));
      assertConsent(form.get("consent"));
      assertCompleteAttempt(form.get("completeAttempt"));
      assertPrimaryTargetConfirmed(form.get("primaryTargetConfirmed"));
      const id = completionMatch[1];
      if (!TRIP_ID_PATTERN.test(id)) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }
      const token = requiredText(form.get("token"), "token", 160);
      if (!REQUEST_TOKEN_PATTERN.test(token)) {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }

      const existing = await store.getTrip(id);
      const tokenHash = await sha256(token);
      if (
        existing?.status === "completed" && existing.source === "live" &&
        existing.idempotency_key_hash === tokenHash
      ) {
        const reporter = await getOrCreateReporter(request, form.get("reporterKey"));
        if (!sameTripPrincipal(existing, reporter.hash, options.accountId)) {
          throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
        }
        const originalForecastImpression = await (store.getForecastImpression?.(id) ?? Promise.resolve(null));
        return jsonResponse({
          trip: publicTrip(existing),
          forecastAttributionCleared: Boolean(originalForecastImpression) && existing.opportunity_window_id === null,
          receipt: { operation: "complete", tripId: id },
        }, 200, reporter.setCookie);
      }
      if (!existing || existing.status !== "active") {
        throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
      }

      // Active-trip completion is attested at server receipt; client finish times are never authoritative.
      const completionTimestamp = now.toISOString();
      const endedAt = completionTimestamp;
      validateDuration(existing.started_at, endedAt, 36);
      const anglerCount = parseInteger(form.get("anglerCount"), "anglerCount", 1, 12, existing.angler_count);
      const keeperCount = parseInteger(form.get("keeperCount"), "keeperCount", 0, 25, 0);
      const shortReleasedCount = parseInteger(
        form.get("shortReleasedCount"),
        "shortReleasedCount",
        0,
        25,
        0,
      );
      if (keeperCount + shortReleasedCount > 40) {
        throw new ApiError(422, "invalid_counts", "Combined halibut encounters cannot exceed 40.");
      }
      const details = parseTripDetails(form, existing);
      assertOtherSpeciesCountConsistency(details.otherCatchCount, details.otherSpecies);
      const mode = parseRequiredMode(form.get("mode"));
      const forecastAttributionCleared = mode !== existing.mode;
      assertImmutableScoreInfluence(form, existing.score_influenced_choice);
      const anglerHours = (Date.parse(endedAt) - Date.parse(existing.started_at)) * anglerCount / 3_600_000;
      const speciesObservation = buildSpeciesObservationFields({
        tripId: existing.id,
        siteId: existing.site_id,
        startedAt: existing.started_at,
        endedAt,
        mode,
        anglerHours,
        keeperCount,
        shortReleasedCount,
        otherCatchCount: details.otherCatchCount,
      });
      const [validationEnrollment, forecastImpression] = await Promise.all([
        store.getValidationEnrollment?.(id) ?? Promise.resolve(null),
        store.getForecastImpression?.(id) ?? Promise.resolve(null),
      ]);
      const completionProvenance = await buildCompletionProvenance({
        trip: existing,
        endedAt,
        mode,
        anglerCount,
        timestamp: completionTimestamp,
        enrollment: validationEnrollment,
        impression: forecastImpression,
      });
      const feasibilityStart = await (store.getFeasibilityStart?.(id) ?? Promise.resolve(null));
      if (feasibilityStart && mode !== feasibilityStart.mode) {
        throw new ApiError(
          422,
          "validation_pilot_mode_immutable",
          "The fishing mode cannot change after a validation-pilot attempt starts.",
        );
      }
      const feasibilityTerminal = feasibilityStart
        ? await buildFeasibilityCompletionEvent({
            start: feasibilityStart,
            timestamp: completionTimestamp,
            anglerCount,
            targetEncounterCount: speciesObservation.targetEncounterCount,
            targetRetainedCount: keeperCount,
            targetReleasedCount: shortReleasedCount,
          })
        : null;
      if (feasibilityStart && !feasibilityTerminal) {
        throw new ApiError(409, "validation_pilot_terminal_invalid", "The pilot completion could not be reconciled.");
      }
      const uploaded = await processPhoto(form.get("photo"), id, env);

      try {
        const completed = await store.completeTrip(id, tokenHash, {
          endedAt,
          mode,
          fishingMethod:
            optionalText(form.get("method") ?? form.get("fishingMethod"), "method", 80) ??
            existing.fishing_method,
          ...details,
          anglerCount,
          anglerHours,
          keeperCount,
          shortReleasedCount,
          halibutEncounters: keeperCount + shortReleasedCount,
          noCatch: speciesObservation.anyFishEncounterCount === 0,
          ...speciesObservation,
          notes: optionalText(form.get("notes"), "notes", 1000),
          consentAt: completionTimestamp,
          photoKey: uploaded?.key ?? null,
          photoContentType: uploaded?.contentType ?? null,
          photoSizeBytes: uploaded?.size ?? null,
          updatedAt: completionTimestamp,
        }, completionProvenance, feasibilityTerminal);

        if (!completed) {
          const racedTrip = await store.getTrip(id);
          const retryReporter = await getOrCreateReporter(request, form.get("reporterKey"));
          if (
            !racedTrip || racedTrip.status !== "completed" || racedTrip.source !== "live" ||
            racedTrip.idempotency_key_hash !== tokenHash ||
            !sameTripPrincipal(racedTrip, retryReporter.hash, options.accountId)
          ) {
            throw new ApiError(404, "trip_not_found", "The active trip could not be found.");
          }
          if (uploaded && racedTrip.photo_key !== uploaded.key) {
            await env.TRIP_PHOTOS?.delete(uploaded.key).catch(() => undefined);
          }
          const originalForecastImpression = await (store.getForecastImpression?.(id) ?? Promise.resolve(null));
          return jsonResponse({
            trip: publicTrip(racedTrip),
            forecastAttributionCleared: Boolean(originalForecastImpression) && racedTrip.opportunity_window_id === null,
            receipt: { operation: "complete", tripId: id },
          }, 200, retryReporter.setCookie);
        }
        options.onTripCompleted?.(completed);
        return jsonResponse({
          trip: publicTrip(completed),
          forecastAttributionCleared,
          receipt: { operation: "complete", tripId: id },
        });
      } catch (error) {
        let committedTrip: TripRow | null = null;
        if (uploaded) {
          try {
            committedTrip = await store.getTrip(id);
          } catch {
            // A failed reconciliation read cannot prove that the write rolled back.
            // Keep the object for the idempotent retry/deletion ledger to reconcile.
            throw error;
          }
        }
        if (uploaded && committedTrip?.photo_key !== uploaded.key) {
          await env.TRIP_PHOTOS?.delete(uploaded.key).catch(() => undefined);
        }
        throw error;
      }
    }

    if (url.pathname === "/api/trips/report") {
      assertContentType(request, "multipart/form-data");
      assertBodySize(request, MAX_MULTIPART_BYTES);
      const form = await request.formData();
      assertNoObservationContractOverride(form);
      assertOnlyInputFields(form, PAST_REPORT_FIELDS);
      assertHoneypot(form.get("website"));
      assertConsent(form.get("consent"));
      assertCompleteAttempt(form.get("completeAttempt"));
      assertPrimaryTargetConfirmed(form.get("primaryTargetConfirmed"));

      const reporter = await getOrCreateReporter(request, form.get("reporterKey"));
      const id = parseClientTripId(form.get("clientTripId"));
      const requestToken = parseRequestToken(form.get("requestToken"));
      const idempotencyKeyHash = await sha256(requestToken);
      const existingRequest = await store.getTrip(id);
      if (existingRequest) {
        if (isMatchingPastReport(existingRequest, idempotencyKeyHash, reporter.hash, options.accountId)) {
          return jsonResponse({
            trip: publicTrip(existingRequest),
            receipt: { operation: "past", tripId: id },
          }, 201, reporter.setCookie);
        }
        throw new ApiError(409, "trip_request_conflict", "This trip request identity cannot be reused.");
      }
      await store.assertSubmissionAllowed(reporter.hash, now);
      const site = getSite(siteMap, form.get("siteId"));
      const startedAt = parseHistoricalStartDate(form.get("startedAt"), now);
      const endedAt = parseEndDate(form.get("endedAt"), now);
      validateDuration(startedAt, endedAt, 36);
      const anglerCount = parseInteger(form.get("anglerCount"), "anglerCount", 1, 12, 1);
      const keeperCount = parseInteger(form.get("keeperCount"), "keeperCount", 0, 25, 0);
      const shortReleasedCount = parseInteger(
        form.get("shortReleasedCount"),
        "shortReleasedCount",
        0,
        25,
        0,
      );
      if (keeperCount + shortReleasedCount > 40) {
        throw new ApiError(422, "invalid_counts", "Combined halibut encounters cannot exceed 40.");
      }

      const timestamp = now.toISOString();
      const mode = parseRequiredMode(form.get("mode"));
      const scoreInfluencedChoice = requiredScoreInfluence(form);
      const referralCode = parseReferralCode(form.get("referralCode"));
      const details = parseTripDetails(form);
      assertOtherSpeciesCountConsistency(details.otherCatchCount, details.otherSpecies);
      const anglerHours = (Date.parse(endedAt) - Date.parse(startedAt)) * anglerCount / 3_600_000;
      const speciesObservation = buildSpeciesObservationFields({
        tripId: id,
        siteId: site.id,
        startedAt,
        endedAt,
        mode,
        anglerHours,
        keeperCount,
        shortReleasedCount,
        otherCatchCount: details.otherCatchCount,
      });
      const validation = buildRetrospectiveValidationBundle({
        tripId: id,
        mode,
        scoreInfluencedChoice,
        timestamp,
      });
      const uploaded = await processPhoto(form.get("photo"), id, env);

      try {
        const trip = await store.insertTrip({
          id,
          userId: options.accountId ?? null,
          status: "completed",
          source: "past_report",
          siteId: site.id,
          startedAt,
          endedAt,
          mode,
          fishingMethod: optionalText(form.get("method") ?? form.get("fishingMethod"), "method", 80),
          ...details,
          anglerCount,
          anglerHours,
          keeperCount,
          shortReleasedCount,
          halibutEncounters: keeperCount + shortReleasedCount,
          noCatch: speciesObservation.anyFishEncounterCount === 0,
          ...speciesObservation,
          notes: optionalText(form.get("notes"), "notes", 1000),
          consent: true,
          consentAt: timestamp,
          moderationStatus: "pending",
          reporterKeyHash: reporter.hash,
          referralCode,
          tokenHash: null,
          idempotencyKeyHash,
          ...forecastFieldsFromAttestation(null, scoreInfluencedChoice),
          photoKey: uploaded?.key ?? null,
          photoContentType: uploaded?.contentType ?? null,
          photoSizeBytes: uploaded?.size ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        }, validation);
        options.onTripCompleted?.(trip);
        return jsonResponse({
          trip: publicTrip(trip),
          receipt: { operation: "past", tripId: id },
        }, 201, reporter.setCookie);
      } catch (error) {
        const racedTrip = await store.getTrip(id);
        if (racedTrip && isMatchingPastReport(racedTrip, idempotencyKeyHash, reporter.hash, options.accountId)) {
          if (uploaded && racedTrip.photo_key !== uploaded.key) {
            await env.TRIP_PHOTOS?.delete(uploaded.key).catch(() => undefined);
          }
          return jsonResponse({
            trip: publicTrip(racedTrip),
            receipt: { operation: "past", tripId: id },
          }, 201, reporter.setCookie);
        }
        if (uploaded && racedTrip?.photo_key !== uploaded.key) {
          await env.TRIP_PHOTOS?.delete(uploaded.key).catch(() => undefined);
        }
        throw error;
      }
    }

    return jsonResponse({ error: { code: "not_found", message: "API route not found." } }, 404);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonResponse(
        { error: { code: "rate_limited", message: error.message } },
        429,
        undefined,
        { "Retry-After": "3600" },
      );
    }
    if (error instanceof ApiError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    }
    logEvent("error", "trip.request.failed", {
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_code: "trip_request_failed",
    });
    return jsonResponse(
      { error: { code: "internal_error", message: "The trip could not be saved right now." } },
      500,
    );
  }
}

function publicTrip(row: TripRow) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    siteId: row.site_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    mode: row.mode,
    fishingMethod: row.fishing_method,
    gear: row.gear,
    gearProfileId: row.gear_profile_id,
    rod: row.rod,
    reel: row.reel,
    baitLure: row.bait_lure,
    rig: row.rig,
    anglerCount: row.angler_count,
    anglerHours: row.angler_hours,
    keeperCount: row.keeper_count,
    shortReleasedCount: row.short_released_count,
    halibutEncounters: row.halibut_encounters,
    noCatch: row.no_catch === null ? null : Boolean(row.no_catch),
    otherCatchCount: row.other_catch_count,
    otherSpecies: row.other_species,
    observations: safeJsonValue(row.observations_json),
    observationContractVersion: row.observation_contract_version,
    taxonCatalogVersion: row.taxon_catalog_version,
    targetTaxonId: row.target_taxon_id,
    contractStatus: row.contract_status,
    taxonObservations: safeJsonValue(row.taxon_observations_json),
    outcomeClass: row.outcome_class,
    targetEncounterCount: row.target_encounter_count,
    anyFishEncounterCount: row.any_fish_encounter_count,
    targetIdentificationConfidence: row.target_identification_confidence,
    notes: row.notes,
    consent: Boolean(row.consent),
    moderationStatus: row.moderation_status,
    referralCode: row.referral_code,
    opportunityWindowId: row.opportunity_window_id,
    opportunityScore: row.opportunity_score,
    habitatScore: row.habitat_score,
    seasonalityScore: row.seasonality_score,
    conditionsScore: row.conditions_score,
    fishabilityScore: row.fishability_score,
    modelVersion: row.model_version,
    scoreInfluencedChoice:
      row.score_influenced_choice === null ? null : Boolean(row.score_influenced_choice),
    hasPhoto: Boolean(row.photo_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTripDetails(source: Record<string, unknown> | FormData, existing?: TripRow) {
  const value = (key: string) => (source instanceof FormData ? source.get(key) : source[key]);
  const observations = {
    shorebreak: optionalText(value("shorebreak"), "shorebreak", 40),
    wadingDepth: optionalText(value("wadingDepth"), "wadingDepth", 40),
    waterClarity: optionalText(value("waterClarity"), "waterClarity", 40),
    crowding: optionalText(value("crowding"), "crowding", 40),
    fishabilityRating: optionalNumber(value("fishabilityRating"), "fishabilityRating", 1, 5),
    observedWaveHeightFeet: optionalNumber(value("observedWaveHeightFeet"), "observedWaveHeightFeet", 0, 30),
    fishabilityNotes: optionalText(value("fishabilityNotes"), "fishabilityNotes", 500),
  };
  const hasObservations = Object.values(observations).some((entry) => entry !== null);
  return {
    gear: optionalText(value("gear"), "gear", 300) ?? existing?.gear ?? null,
    gearProfileId: optionalText(value("gearProfileId"), "gearProfileId", 80) ?? existing?.gear_profile_id ?? null,
    rod: optionalText(value("rod"), "rod", 160) ?? existing?.rod ?? null,
    reel: optionalText(value("reel"), "reel", 160) ?? existing?.reel ?? null,
    baitLure: optionalText(value("baitLure"), "baitLure", 200) ?? existing?.bait_lure ?? null,
    rig: optionalText(value("rig"), "rig", 200) ?? existing?.rig ?? null,
    otherCatchCount: parseInteger(value("otherCatchCount"), "otherCatchCount", 0, 100, existing?.other_catch_count ?? 0),
    otherSpecies: optionalText(value("otherSpecies"), "otherSpecies", 200) ?? existing?.other_species ?? null,
    observationsJson: hasObservations ? JSON.stringify(observations) : existing?.observations_json ?? null,
  };
}

function safeJsonValue(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function processPhoto(entry: FormDataEntryValue | null, tripId: string, env: TripApiEnv) {
  if (entry === null || entry === "") return null;
  if (env.TRIP_PHOTO_UPLOADS_ENABLED?.trim().toLowerCase() !== "true") {
    throw new ApiError(503, "photo_uploads_disabled", "Photo uploads are not enabled.");
  }
  if (typeof entry === "string") {
    throw new ApiError(422, "invalid_photo", "photo must be an uploaded image.");
  }
  if (entry.size === 0) return null;
  if (entry.size > MAX_PHOTO_BYTES) {
    throw new ApiError(413, "photo_too_large", "Photos must be 5 MB or smaller.");
  }
  if (!ALLOWED_IMAGE_TYPES.has(entry.type)) {
    throw new ApiError(415, "invalid_photo_type", "Photos must be JPEG, PNG, or WebP.");
  }

  const signature = new Uint8Array(await entry.slice(0, 16).arrayBuffer());
  if (!matchesImageSignature(signature, entry.type)) {
    throw new ApiError(415, "invalid_photo_type", "The uploaded file does not match its image type.");
  }
  if (!env.IMAGES || !env.TRIP_PHOTOS) {
    throw new ApiError(503, "photo_storage_unavailable", "Photo uploads are temporarily unavailable.");
  }

  let transformed: Response;
  try {
    const output = await env.IMAGES.input(entry.stream()).transform({
      width: 2048,
      height: 2048,
      fit: "scale-down",
    }).output({ format: "image/webp", quality: 82 });
    transformed = output.response();
  } catch {
    throw new ApiError(422, "photo_processing_failed", "The photo could not be processed.");
  }

  if (!transformed.ok) {
    throw new ApiError(422, "photo_processing_failed", "The photo could not be processed.");
  }
  const bytes = await transformed.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new ApiError(422, "photo_processing_failed", "The processed photo is invalid or too large.");
  }

  const date = new Date();
  const key = `trip-photos/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${tripId}/${crypto.randomUUID()}.webp`;
  await env.TRIP_PHOTOS.put(key, bytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: { tripId, privacy: "exif-stripped" },
  });
  return { key, contentType: "image/webp", size: bytes.byteLength };
}

export function minimizeForecastMetadata(value: unknown) {
  if (!isRecord(value)) return null;

  const minimized: Record<string, unknown> = {};
  addBoundedText(minimized, "snapshotGeneratedAt", value.snapshotGeneratedAt, 40);
  addBoundedText(minimized, "forecastStart", value.forecastStart, 40);
  addBoundedText(minimized, "forecastEnd", value.forecastEnd, 40);
  if (value.confidence === "low" || value.confidence === "medium" || value.confidence === "high") {
    minimized.confidence = value.confidence;
  }

  if (isRecord(value.forecastConditions)) {
    const source = value.forecastConditions;
    const conditions: Record<string, unknown> = {};
    addBoundedText(conditions, "tideStage", source.tideStage, 40);
    addNumber(conditions, "tideChangeFeet", source.tideChangeFeet, -20, 20);
    if (Array.isArray(source.tideLevelsFeet)) {
      const levels = source.tideLevelsFeet
        .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
        .slice(0, 4)
        .map((entry) => Math.max(-20, Math.min(30, entry)));
      if (levels.length) conditions.tideLevelsFeet = levels;
    }
    addNumber(conditions, "currentKnots", source.currentKnots, 0, 20);
    addNumber(conditions, "currentDirectionDegrees", source.currentDirectionDegrees, 0, 360);
    addBoundedText(conditions, "currentDirection", source.currentDirection, 12);
    addNumber(conditions, "windMph", source.windMph, 0, 200);
    addBoundedText(conditions, "windDirection", source.windDirection, 12);
    addNumber(conditions, "swellFeet", source.swellFeet, 0, 100);
    addNumber(conditions, "swellPeriodSeconds", source.swellPeriodSeconds, 0, 60);
    addNumber(conditions, "swellDirectionDegrees", source.swellDirectionDegrees, 0, 360);
    addBoundedText(conditions, "swellDirection", source.swellDirection, 12);
    addNumber(conditions, "wavePowerKwM", source.wavePowerKwM, 0, 1_000);
    addBoundedText(conditions, "breakingIntensity", source.breakingIntensity, 24);
    addNumber(conditions, "breakingWaveHeightFeet", source.breakingWaveHeightFeet, 0, 100);
    addBoundedText(conditions, "fishabilityLabel", source.fishabilityLabel, 30);
    if (Array.isArray(source.fishabilityReasons)) {
      const reasons = source.fishabilityReasons
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().slice(0, 240))
        .filter(Boolean)
        .slice(0, 6);
      if (reasons.length) conditions.fishabilityReasons = reasons;
    }
    addNumber(conditions, "waterTempF", source.waterTempF, -20, 150);
    addBoundedText(conditions, "waterTempSource", source.waterTempSource, 80);
    addNumber(conditions, "ndbcObservedWaterTempF", source.ndbcObservedWaterTempF, -20, 150);
    addBoundedText(conditions, "ndbcObservedAt", source.ndbcObservedAt, 40);
    if (typeof source.daylight === "boolean") conditions.daylight = source.daylight;
    addNumber(conditions, "cloudCoverPct", source.cloudCoverPct, 0, 100);
    addNumber(conditions, "pressureHpa", source.pressureHpa, 800, 1_200);
    addNumber(conditions, "pressureTrendHpa3h", source.pressureTrendHpa3h, -100, 100);
    addBoundedText(conditions, "pressureObservedAt", source.pressureObservedAt, 40);
    addBoundedText(conditions, "moonPhase", source.moonPhase, 40);
    addNumber(conditions, "moonIlluminationPct", source.moonIlluminationPct, 0, 100);
    addBoundedText(conditions, "fishingPressure", source.fishingPressure, 24);
    addNumber(conditions, "fishingPressurePct", source.fishingPressurePct, 0, 100);
    addNumber(conditions, "accessAdjustmentPoints", source.accessAdjustmentPoints, -100, 100);
    addBoundedText(conditions, "fishingPressureBasis", source.fishingPressureBasis, 160);
    addBoundedText(conditions, "summary", source.summary, 300);
    minimized.forecastConditions = conditions;
  }

  return minimized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addBoundedText(target: Record<string, unknown>, key: string, value: unknown, maximum: number) {
  if (typeof value !== "string") return;
  const text = value.trim().slice(0, maximum);
  if (text) target[key] = text;
}

function addNumber(target: Record<string, unknown>, key: string, value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target[key] = Math.max(minimum, Math.min(maximum, value));
}

function matchesImageSignature(bytes: Uint8Array, type: string) {
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  let normalizedOrigin: string;
  try {
    normalizedOrigin = origin ? new URL(origin).origin : "";
  } catch {
    normalizedOrigin = "";
  }
  if (!normalizedOrigin || normalizedOrigin !== new URL(request.url).origin) {
    throw new ApiError(403, "invalid_origin", "Trip submissions must come from CastingCompass.");
  }
}

function assertContentType(request: Request, expected: string) {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(expected)) {
    throw new ApiError(415, "unsupported_media_type", `Expected ${expected}.`);
  }
}

function assertBodySize(request: Request, maximum: number) {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new ApiError(413, "payload_too_large", "The trip submission is too large.");
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function assertHoneypot(value: unknown) {
  if (value !== null && value !== undefined && String(value).trim() !== "") {
    throw new ApiError(422, "invalid_submission", "The trip submission could not be accepted.");
  }
}

function assertNoObservationContractOverride(source: Record<string, unknown> | FormData) {
  if (hasServerControlledObservationFields(source)) {
    throw new ApiError(
      422,
      "observation_contract_override_forbidden",
      "The trip target and observation contract are controlled by CastingCompass.",
    );
  }
}

function assertOnlyInputFields(
  source: Record<string, unknown> | FormData,
  allowed: readonly string[],
) {
  const allowedFields = new Set(allowed);
  if (source instanceof FormData) {
    const counts = new Map<string, number>();
    for (const field of source.keys()) {
      if (!allowedFields.has(field)) {
        throw new ApiError(422, "unexpected_fields", "Send only fields supported by this trip endpoint.");
      }
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count !== 1)) {
      throw new ApiError(422, "duplicate_fields", "Send each trip field at most once.");
    }
    return;
  }
  if (Object.keys(source).some((field) => !allowedFields.has(field))) {
    throw new ApiError(422, "unexpected_fields", "Send only fields supported by this trip endpoint.");
  }
}

function assertOtherSpeciesCountConsistency(otherCatchCount: number, otherSpecies: string | null) {
  if (otherCatchCount === 0 && otherSpecies) {
    throw new ApiError(
      422,
      "invalid_other_species",
      "Enter an other-fish count when describing a non-halibut catch.",
    );
  }
}

function getSite(siteMap: Map<string, CuratedSite>, value: unknown) {
  const id = requiredText(value, "siteId", 120);
  const site = siteMap.get(id);
  if (!site) throw new ApiError(422, "invalid_site", "Choose a current CastingCompass location.");
  return site;
}

function parseRequiredMode(value: unknown) {
  if (value === null || value === undefined || value === "") {
    throw new ApiError(422, "mode_required", "Choose the fishing mode used for the whole trip.");
  }
  const mode = String(value).trim().toLowerCase();
  if (!ALLOWED_MODES.has(mode)) {
    throw new ApiError(422, "invalid_mode", "Choose a supported fishing mode.");
  }
  return mode;
}

function parseStartDate(value: unknown, now: Date, maximumPastHours: number) {
  const date = value === null || value === undefined || value === "" ? now : parseDate(value, "startedAt");
  if (date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "startedAt cannot be in the future.");
  }
  if (date.getTime() < now.getTime() - maximumPastHours * 60 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "Use Log a past trip for an older trip.");
  }
  return date.toISOString();
}

function parseHistoricalStartDate(value: unknown, now: Date) {
  const date = parseDate(value, "startedAt");
  if (date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "startedAt cannot be in the future.");
  }
  if (date.getTime() < now.getTime() - 5 * 365.25 * 24 * 60 * 60 * 1000) {
    throw new ApiError(422, "invalid_started_at", "Past reports are limited to the last five years.");
  }
  return date.toISOString();
}

function parseEndDate(value: unknown, now: Date) {
  const date = value === null || value === undefined || value === "" ? now : parseDate(value, "endedAt");
  if (date.getTime() > now.getTime() + 15 * 60 * 1000) {
    throw new ApiError(422, "invalid_ended_at", "endedAt cannot be in the future.");
  }
  return date.toISOString();
}

function parseDate(value: unknown, field: string) {
  if (typeof value !== "string" || value.length > 80) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be an ISO date and time.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be an ISO date and time.`);
  }
  return date;
}

function validateDuration(startedAt: string, endedAt: string, maximumHours: number) {
  const durationHours = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / (60 * 60 * 1000);
  if (!Number.isFinite(durationHours) || durationHours < 1 / 60 || durationHours > maximumHours) {
    throw new ApiError(422, "invalid_duration", `Trip duration must be between 1 minute and ${maximumHours} hours.`);
  }
  return durationHours;
}

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} is required and must be under ${maximum} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be under ${maximum} characters.`);
  }
  return value.trim() || null;
}

function parseInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ApiError(422, `invalid_${field}`, `${field} must be a whole number from ${minimum} to ${maximum}.`);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return number;
}

function optionalNumber(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ApiError(422, `invalid_${field}`, `${field} must be from ${minimum} to ${maximum}.`);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new ApiError(422, `invalid_${field}`, `${field} must be from ${minimum} to ${maximum}.`);
  }
  return number;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === "on") return true;
  if (value === "false" || value === "0" || value === "off") return false;
  throw new ApiError(422, `invalid_${field}`, `${field} must be true or false.`);
}

function parseSafeCancellationReason(value: unknown): SafeCancellationReason {
  const reason = requiredText(value, "reason", 40);
  if (!["weather", "water_safety", "access", "health", "personal", "other"].includes(reason)) {
    throw new ApiError(
      422,
      "invalid_reason",
      "reason must be weather, water_safety, access, health, personal, or other.",
    );
  }
  return reason as SafeCancellationReason;
}

function assertConsent(value: unknown) {
  if (optionalBoolean(value, "consent") !== true) {
    throw new ApiError(422, "consent_required", "Consent is required to contribute a trip report.");
  }
}

function assertPrimaryTargetConfirmed(value: unknown) {
  if (optionalBoolean(value, "primaryTargetConfirmed") !== true) {
    throw new ApiError(
      422,
      "primary_target_confirmation_required",
      "Confirm that California halibut was the primary target for the whole trip.",
    );
  }
}

function assertCompleteAttempt(value: unknown) {
  if (optionalBoolean(value, "completeAttempt") !== true) {
    throw new ApiError(
      422,
      "complete_attempt_required",
      "Confirm that this report covers the whole fishing attempt, including a no-catch result.",
    );
  }
}

function scoreInfluenceValues(source: Record<string, unknown> | FormData) {
  const values: unknown[] = [];
  for (const key of ["scoreInfluencedChoice", "contourCastInfluenced"]) {
    if (source instanceof FormData) {
      for (const value of source.getAll(key)) {
        if (value !== "") values.push(value);
      }
    } else if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== "") {
      values.push(source[key]);
    }
  }
  return values;
}

function requiredScoreInfluence(source: Record<string, unknown> | FormData) {
  const values = scoreInfluenceValues(source);
  if (values.length === 0) {
    throw new ApiError(
      422,
      "score_influence_required",
      "Answer whether the CastingCompass score influenced this trip choice.",
    );
  }
  const parsed = values.map((value) => optionalBoolean(value, "scoreInfluencedChoice"));
  if (parsed.some((value) => value === null) || parsed.some((value) => value !== parsed[0])) {
    throw new ApiError(
      422,
      "invalid_scoreInfluencedChoice",
      "Provide one consistent answer about whether the score influenced this trip choice.",
    );
  }
  return parsed[0] as boolean;
}

function assertImmutableScoreInfluence(
  source: Record<string, unknown> | FormData,
  storedValue: number | null,
) {
  if (scoreInfluenceValues(source).length === 0) return;
  const submitted = requiredScoreInfluence(source);
  if (storedValue === null || submitted !== Boolean(storedValue)) {
    throw new ApiError(
      422,
      "score_influence_immutable",
      "The pre-trip score-influence answer cannot be changed after the trip starts.",
    );
  }
}

function parseReferralCode(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.trim())) {
    throw new ApiError(
      422,
      "invalid_referral_code",
      "referralCode must be a short link code using letters, numbers, hyphens, or underscores.",
    );
  }
  return value.trim().toLowerCase();
}

async function getOrCreateReporter(request: Request, suppliedKey?: unknown) {
  const cookies = parseCookies(request.headers.get("Cookie") ?? "");
  let raw: string | undefined;
  let setCookie: string | undefined;
  let supplied = false;
  if (suppliedKey !== null && suppliedKey !== undefined && suppliedKey !== "") {
    if (typeof suppliedKey !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(suppliedKey)) {
      throw new ApiError(422, "invalid_reporter_key", "reporterKey is not a valid anonymous device key.");
    }
    raw = suppliedKey;
    supplied = true;
  } else {
    raw = cookies.get(REPORTER_COOKIE);
  }
  if (!supplied && (!raw || !/^[A-Za-z0-9_-]{40,160}$/.test(raw))) {
    raw = randomSecret();
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    setCookie = `${REPORTER_COOKIE}=${raw}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure}`;
  }
  if (!raw) throw new Error("Anonymous reporter key generation failed");
  return { hash: await sha256(raw), setCookie };
}

function parseClientTripId(value: unknown) {
  if (typeof value !== "string" || !TRIP_ID_PATTERN.test(value)) {
    throw new ApiError(422, "invalid_trip_request", "A valid client trip request identity is required.");
  }
  return value;
}

function parseRequestToken(value: unknown) {
  if (typeof value !== "string" || !CLIENT_REQUEST_TOKEN_PATTERN.test(value)) {
    throw new ApiError(422, "invalid_trip_request", "A valid client trip recovery secret is required.");
  }
  return value;
}

function sameTripPrincipal(row: TripRow, reporterKeyHash: string, accountId?: string | null) {
  return row.reporter_key_hash === reporterKeyHash &&
    (row.user_id ?? null) === (accountId ?? null);
}

function isMatchingLiveStart(
  row: TripRow,
  idempotencyKeyHash: string,
  reporterKeyHash: string,
  accountId?: string | null,
) {
  return row.status === "active" && row.source === "live" &&
    sameTripPrincipal(row, reporterKeyHash, accountId) &&
    row.idempotency_key_hash === idempotencyKeyHash &&
    row.token_hash === idempotencyKeyHash;
}

function isMatchingPastReport(
  row: TripRow,
  idempotencyKeyHash: string,
  reporterKeyHash: string,
  accountId?: string | null,
) {
  return row.status === "completed" && row.source === "past_report" &&
    sameTripPrincipal(row, reporterKeyHash, accountId) &&
    row.idempotency_key_hash === idempotencyKeyHash;
}

function parseCookies(header: string) {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function methodNotAllowed(allow: string) {
  return jsonResponse(
    { error: { code: "method_not_allowed", message: `Use ${allow} for this endpoint.` } },
    405,
    undefined,
    { Allow: allow },
  );
}

function jsonResponse(
  body: unknown,
  status = 200,
  setCookie?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}
