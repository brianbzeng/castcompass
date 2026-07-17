import type { AttestedOpportunity } from "./validation.ts";

export const FEASIBILITY_PROTOCOL_ID = "california-halibut-collection-feasibility-v2" as const;
export const FEASIBILITY_PROTOCOL_VERSION = "2.0.0" as const;
export const FEASIBILITY_PROTOCOL_SHA256 =
  "8ff0d7bd009ed8eb10f328347d58d0b63d0b6c822b08351cc5c2760d41de13ed" as const;
export const FEASIBILITY_SITE_CATALOG_SHA256 =
  "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860" as const;
export const FEASIBILITY_EVENT_CONTRACT_VERSION =
  "castingcompass.validation-feasibility-event/2.0.0" as const;
export const FEASIBILITY_CORRECTION_CONTRACT_VERSION =
  "castingcompass.validation-feasibility-correction/2.0.0" as const;
export const FEASIBILITY_RECRUITMENT_FRAME_ID =
  "california-halibut-feasibility-recruitment-v2" as const;
export const FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION =
  "castingcompass.validation-feasibility-recruitment/2.0.0" as const;
export const FEASIBILITY_RECRUITMENT_TOKEN_VERSION =
  "castingcompass.validation-feasibility-recruitment-token/2.0.0" as const;
export const FEASIBILITY_ORGANIC_SOURCE_ID = "castingcompass-organic-product" as const;
export const FEASIBILITY_SELECTION_METHOD = "organic_score_visible" as const;
export const FEASIBILITY_DIRECT_SOURCE_ID = "direct-opt-in-research-invite" as const;
export const FEASIBILITY_COMMUNITY_SOURCE_ID = "admin-approved-community-prospective" as const;
export const FEASIBILITY_DIRECT_SELECTION_METHOD = "direct_precommitment" as const;

const PARTICIPANT_DOMAIN = "castingcompass.validation-feasibility-participant/2.0.0";
const PARTICIPANT_SNAPSHOT_SUPPRESSION_DOMAIN =
  "castingcompass.validation-feasibility-participant-suppression/2.0.0";
const TRIP_SNAPSHOT_SUPPRESSION_DOMAIN =
  "castingcompass.validation-feasibility-trip-suppression/2.0.0";
const SOURCE_RECORD_DOMAIN = "castingcompass.validation-feasibility-source/2.0.0";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PARTICIPANT_PATTERN = /^participant-[a-f0-9]{64}$/;
const CAMPAIGN_ID_PATTERN = /^campaign-[a-z0-9][a-z0-9-]{2,79}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_CANCELLATION_REASONS = new Set<SafeCancellationReason>([
  "weather",
  "water_safety",
  "access",
  "health",
  "personal",
  "other",
]);
const MAX_ATTEMPT_MILLISECONDS = 36 * 60 * 60 * 1_000;

const PANELS = {
  "north-coast": [
    "limantour-beach",
    "drakes-beach",
    "point-reyes-south-beach",
    "bolinas-beach",
    "stinson-beach",
    "muir-beach",
    "rodeo-beach",
  ],
  "golden-gate-sf-coast": [
    "fort-baker-pier",
    "torpedo-wharf",
    "crissy-field-east-beach",
    "baker-beach",
    "china-beach",
    "ocean-beach-north",
    "ocean-beach-south",
  ],
  "north-east-bay": [
    "mcnears-beach-pier",
    "paradise-beach-pier",
    "ferry-point-pier",
    "keller-beach",
    "point-isabel-shoreline",
    "albany-bulb",
    "berkeley-marina-north-basin",
    "cesar-chavez-park",
    "emeryville-marina-pier",
  ],
  "central-south-bay": [
    "pier-7",
    "pier-14",
    "crane-cove-park",
    "herons-head-park-pier",
    "port-view-park-pier",
    "middle-harbor-shoreline",
    "alameda-south-shore-rockwall",
    "crown-memorial-state-beach",
    "oyster-bay-shoreline",
    "san-leandro-marina-shore",
    "dumbarton-pier",
    "coyote-point-jetty",
    "seal-point-park",
    "oyster-point-fishing-pier",
  ],
  "san-mateo-coast": [
    "sharp-park-beach",
    "rockaway-beach",
    "pacifica-state-beach",
    "montara-state-beach",
    "pillar-point-west-jetty",
    "pillar-point-east-jetty",
    "surfers-beach",
    "francis-state-beach",
    "poplar-beach",
  ],
} as const;

export type FeasibilityPanelId = keyof typeof PANELS;
export type FeasibilityEventType = "started" | "completed" | "safe_canceled";
export type SafeCancellationReason = "weather" | "water_safety" | "access" | "health" | "personal" | "other";
export type FeasibilityRecruitmentSourceId =
  | typeof FEASIBILITY_ORGANIC_SOURCE_ID
  | typeof FEASIBILITY_DIRECT_SOURCE_ID
  | typeof FEASIBILITY_COMMUNITY_SOURCE_ID;
export type FeasibilitySelectionMethod =
  | typeof FEASIBILITY_SELECTION_METHOD
  | typeof FEASIBILITY_DIRECT_SELECTION_METHOD;

const PANEL_BY_SITE = new Map<string, FeasibilityPanelId>();
for (const [panel, sites] of Object.entries(PANELS) as [FeasibilityPanelId, readonly string[]][]) {
  for (const site of sites) {
    if (PANEL_BY_SITE.has(site)) throw new Error(`Duplicate feasibility site ${site}`);
    PANEL_BY_SITE.set(site, panel);
  }
}

export interface FeasibilityRuntimeEnv {
  VALIDATION_FEASIBILITY_ENABLED?: string;
  VALIDATION_FEASIBILITY_ACTIVATION_ID?: string;
  VALIDATION_FEASIBILITY_ACTIVATION_MANIFEST_SHA256?: string;
  VALIDATION_FEASIBILITY_COMMITMENT_SHA256?: string;
  VALIDATION_PARTICIPANT_HMAC_SECRET?: string;
  VALIDATION_RECRUITMENT_HMAC_SECRET?: string;
  CF_VERSION_METADATA?: { id?: string };
}

export interface StoredFeasibilityActivation {
  id: string;
  protocol_id: string;
  protocol_version: string;
  protocol_sha256: string;
  activation_commitment_sha256: string;
  activation_manifest_sha256: string;
  site_catalog_sha256: string;
  scoring_system_kind: string;
  scoring_system_version: string;
  scoring_system_sha256: string;
  worker_version_id: string;
  study_consent_version: string;
  start_at: string;
  end_at: string;
  preregistered_at: string;
  receipt_verified_at: string;
  status: string;
}

export interface ActiveFeasibilityContext {
  activation: StoredFeasibilityActivation;
  participantGroupId: string;
}

export interface FeasibilityRecruitmentTokenPayload {
  schema_version: typeof FEASIBILITY_RECRUITMENT_TOKEN_VERSION;
  activation_id: string;
  campaign_id: string;
  recruitment_source_id: Exclude<FeasibilityRecruitmentSourceId, typeof FEASIBILITY_ORGANIC_SOURCE_ID>;
  selection_method: typeof FEASIBILITY_DIRECT_SELECTION_METHOD;
  issued_at: string;
  expires_at: string;
  community_approval_sha256: string | null;
}

export interface FeasibilityRecruitmentCampaignRecord {
  activationId: string;
  campaignId: string;
  recruitmentSourceId: Exclude<FeasibilityRecruitmentSourceId, typeof FEASIBILITY_ORGANIC_SOURCE_ID>;
  selectionMethod: typeof FEASIBILITY_DIRECT_SELECTION_METHOD;
  inviteIssuedAt: string;
  inviteExpiresAt: string;
  communityApprovalSha256: string | null;
  tokenPayloadSha256: string;
  sealedAt: string;
}

export interface StoredFeasibilityRecruitmentCampaign {
  activation_id: string;
  campaign_id: string;
  recruitment_source_id: string;
  selection_method: string;
  invite_issued_at: string;
  invite_expires_at: string;
  community_approval_sha256: string | null;
  token_payload_sha256: string;
  sealed_at: string;
}

export interface FeasibilityRecruitmentRecord {
  eventId: string;
  activationId: string;
  userId: string;
  participantGroupId: string;
  eventContractVersion: typeof FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION;
  recruitmentFrameId: typeof FEASIBILITY_RECRUITMENT_FRAME_ID;
  recruitmentSourceId: FeasibilityRecruitmentSourceId;
  selectionMethod: FeasibilitySelectionMethod;
  recruitedAt: string;
  campaignId: string | null;
  inviteIssuedAt: string | null;
  inviteExpiresAt: string | null;
  communityApprovalSha256: string | null;
  snapshotSuppressionSha256: string;
  eventSha256: string;
  createdAt: string;
}

export interface StoredFeasibilityRecruitment {
  event_id: string;
  activation_id: string;
  user_id: string;
  participant_group_id: string;
  event_contract_version: string;
  recruitment_frame_id: string;
  recruitment_source_id: string;
  selection_method: string;
  recruited_at: string;
  campaign_id: string | null;
  invite_issued_at: string | null;
  invite_expires_at: string | null;
  community_approval_sha256: string | null;
  snapshot_suppression_sha256: string;
  event_sha256: string;
  created_at: string;
}

export interface FeasibilityEventRecord {
  eventId: string;
  activationId: string;
  tripId: string;
  eventType: FeasibilityEventType;
  eventContractVersion: typeof FEASIBILITY_EVENT_CONTRACT_VERSION;
  sourceRecordSha256: string;
  participantGroupId: string;
  recruitmentFrameId: typeof FEASIBILITY_RECRUITMENT_FRAME_ID;
  recruitmentSourceId: FeasibilityRecruitmentSourceId;
  selectionMethod: FeasibilitySelectionMethod;
  scoreInfluencedChoice: boolean;
  studyConsentVersion: string;
  studyConsentedAt: string;
  targetTaxonId: "california-halibut";
  siteId: string;
  geographicPanel: FeasibilityPanelId;
  mode: "shore" | "beach" | "pier" | "jetty";
  segmentStartAt: string;
  segmentEndAt: string | null;
  anglerCount: number;
  effortMinutes: number | null;
  targetEncountered: boolean | null;
  targetEncounterCount: number | null;
  targetRetainedCount: number | null;
  targetReleasedCount: number | null;
  identificationConfidence: "self_reported" | "not_observed" | null;
  scoringSystemKind: "heuristic-configuration";
  scoringSystemVersion: string;
  scoringSystemSha256: string;
  opportunityScore: number;
  opportunityWindowId: string;
  snapshotSha256: string;
  snapshotSuppressionSha256: string;
  terminalReason: SafeCancellationReason | null;
  previousEventSha256: string | null;
  eventAt: string;
  eventSha256: string;
}

export interface StoredFeasibilityStart {
  activation_id: string;
  trip_id: string;
  event_sha256: string;
  source_record_sha256: string;
  participant_group_id: string;
  recruitment_frame_id: typeof FEASIBILITY_RECRUITMENT_FRAME_ID;
  recruitment_source_id: FeasibilityRecruitmentSourceId;
  selection_method: FeasibilitySelectionMethod;
  score_influenced_choice: number;
  study_consent_version: string;
  study_consented_at: string;
  target_taxon_id: "california-halibut";
  site_id: string;
  geographic_panel: FeasibilityPanelId;
  mode: "shore" | "beach" | "pier" | "jetty";
  segment_start_at: string;
  angler_count: number;
  scoring_system_kind: "heuristic-configuration";
  scoring_system_version: string;
  scoring_system_sha256: string;
  opportunity_score: number;
  opportunity_window_id: string;
  snapshot_sha256: string;
  snapshot_suppression_sha256: string;
}

export interface FeasibilityCorrectionRecord {
  correctionId: string;
  activationId: string;
  tripId: string;
  correctionContractVersion: typeof FEASIBILITY_CORRECTION_CONTRACT_VERSION;
  rootCompletionEventSha256: string;
  previousEventSha256: string;
  correctionReason: "participant_profile_edit";
  analyticalStatus: "eligible_corrected_completion" | "excluded_after_identity_correction";
  siteId: string;
  geographicPanel: FeasibilityPanelId;
  mode: "shore" | "beach" | "pier" | "jetty" | "kayak" | "boat" | "other";
  segmentStartAt: string;
  segmentEndAt: string;
  anglerCount: number;
  effortMinutes: number;
  targetEncountered: boolean;
  targetEncounterCount: number;
  targetRetainedCount: number;
  targetReleasedCount: number;
  identificationConfidence: "self_reported" | "not_observed";
  correctedAt: string;
  eventSha256: string;
}

export interface FeasibilityReconciliationResult {
  status: "collection-feasibility-demonstrated" | "collection-feasibility-not-demonstrated";
  startedAttempts: number;
  retainedStartedAttempts: number;
  completedAttempts: number;
  safeCanceledAttempts: number;
  correctionEvents: number;
  identityCorrectionExclusions: number;
  unreconciledAttempts: number;
  reconciliationRate: number;
  completionRateExcludingSafeCancellations: number;
  uniqueParticipantGroups: number;
  targetEncounters: number;
  nonEncounters: number;
  maximumSingleParticipantShare: number;
  geographicPanelsWithAttempts: number;
  recruitmentSourcesWithAttempts: number;
  removedStartedAttempts: number;
  removedCompletedAttempts: number;
  removedSafeCanceledAttempts: number;
  requiredFieldMissingness: number;
  snapshotAndRestorePassed: boolean;
  failedGates: string[];
  candidatePerformanceComputed: false;
}

export interface FeasibilityPrivacyRemovalSummary {
  removedStartedAttempts: number;
  removedCompletedAttempts: number;
  removedSafeCanceledAttempts: number;
}

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(value: string) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Feasibility event contains an unsupported value");
  return serialized;
}

function strictTimestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : null;
}

function recruitmentSecretBytes(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  return bytes.byteLength >= 32 && bytes.byteLength <= 512 ? bytes : null;
}

async function recruitmentHmacKey(secret: string) {
  const bytes = recruitmentSecretBytes(secret);
  if (!bytes) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function validRecruitmentTokenShape(value: unknown): value is FeasibilityRecruitmentTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const expectedKeys = [
    "activation_id",
    "campaign_id",
    "community_approval_sha256",
    "expires_at",
    "issued_at",
    "recruitment_source_id",
    "schema_version",
    "selection_method",
  ];
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)) return false;
  if (
    payload.schema_version !== FEASIBILITY_RECRUITMENT_TOKEN_VERSION ||
    typeof payload.activation_id !== "string" || !payload.activation_id || payload.activation_id.length > 200 ||
    typeof payload.campaign_id !== "string" || !CAMPAIGN_ID_PATTERN.test(payload.campaign_id) ||
    payload.selection_method !== FEASIBILITY_DIRECT_SELECTION_METHOD ||
    (payload.recruitment_source_id !== FEASIBILITY_DIRECT_SOURCE_ID &&
      payload.recruitment_source_id !== FEASIBILITY_COMMUNITY_SOURCE_ID) ||
    typeof payload.issued_at !== "string" || strictTimestamp(payload.issued_at) === null ||
    typeof payload.expires_at !== "string" || strictTimestamp(payload.expires_at) === null
  ) return false;
  return payload.recruitment_source_id === FEASIBILITY_COMMUNITY_SOURCE_ID
    ? typeof payload.community_approval_sha256 === "string" && SHA256_PATTERN.test(payload.community_approval_sha256)
    : payload.community_approval_sha256 === null;
}

export async function createFeasibilityRecruitmentToken(
  secret: string,
  payload: FeasibilityRecruitmentTokenPayload,
) {
  const key = await recruitmentHmacKey(secret);
  if (!key || !validRecruitmentTokenShape(payload)) return null;
  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(canonicalJson(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${bytesToBase64Url(signature)}`;
}

export function feasibilityRecruitmentCampaignReference(token: string) {
  if (token.length > 2_048) return null;
  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length) return null;
  const payloadBytes = base64UrlToBytes(encodedPayload);
  if (!payloadBytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    return validRecruitmentTokenShape(parsed)
      ? { activationId: parsed.activation_id, campaignId: parsed.campaign_id }
      : null;
  } catch {
    return null;
  }
}

export async function buildFeasibilityRecruitmentCampaign(
  payload: FeasibilityRecruitmentTokenPayload,
  sealedAt: string,
): Promise<FeasibilityRecruitmentCampaignRecord | null> {
  if (!validRecruitmentTokenShape(payload)) return null;
  const issued = strictTimestamp(payload.issued_at);
  const expires = strictTimestamp(payload.expires_at);
  const sealed = strictTimestamp(sealedAt);
  if (issued === null || expires === null || sealed === null || issued > sealed || expires <= sealed) return null;
  return {
    activationId: payload.activation_id,
    campaignId: payload.campaign_id,
    recruitmentSourceId: payload.recruitment_source_id,
    selectionMethod: payload.selection_method,
    inviteIssuedAt: payload.issued_at,
    inviteExpiresAt: payload.expires_at,
    communityApprovalSha256: payload.community_approval_sha256,
    tokenPayloadSha256: await sha256(canonicalJson(payload)),
    sealedAt,
  };
}

async function verifyFeasibilityRecruitmentToken(input: {
  secret: string;
  token: string;
  activation: StoredFeasibilityActivation;
  campaign: StoredFeasibilityRecruitmentCampaign;
  timestamp: string;
}) {
  if (input.token.length > 2_048) return null;
  const [encodedPayload, encodedSignature, ...extra] = input.token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length) return null;
  const key = await recruitmentHmacKey(input.secret);
  const payloadBytes = base64UrlToBytes(encodedPayload);
  const signatureBytes = base64UrlToBytes(encodedSignature);
  if (!key || !payloadBytes || !signatureBytes || signatureBytes.byteLength !== 32) return null;
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(encodedPayload),
  );
  if (!verified) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!validRecruitmentTokenShape(parsed)) return null;
  if (bytesToBase64Url(new TextEncoder().encode(canonicalJson(parsed))) !== encodedPayload) return null;
  const now = strictTimestamp(input.timestamp);
  const activationStart = strictTimestamp(input.activation.start_at);
  const activationEnd = strictTimestamp(input.activation.end_at);
  const issued = strictTimestamp(parsed.issued_at);
  const expires = strictTimestamp(parsed.expires_at);
  if (
    parsed.activation_id !== input.activation.id || now === null || activationStart === null ||
    activationEnd === null || issued === null || expires === null || issued >= activationStart ||
    expires <= now || expires > activationEnd || issued >= expires
  ) return null;
  const campaign = input.campaign;
  if (
    campaign.activation_id !== parsed.activation_id || campaign.campaign_id !== parsed.campaign_id ||
    campaign.recruitment_source_id !== parsed.recruitment_source_id ||
    campaign.selection_method !== parsed.selection_method || campaign.invite_issued_at !== parsed.issued_at ||
    campaign.invite_expires_at !== parsed.expires_at ||
    campaign.community_approval_sha256 !== parsed.community_approval_sha256 ||
    campaign.token_payload_sha256 !== await sha256(canonicalJson(parsed)) ||
    !SHA256_PATTERN.test(campaign.token_payload_sha256) ||
    strictTimestamp(campaign.sealed_at) === null || strictTimestamp(campaign.sealed_at)! >= activationStart
  ) return null;
  return parsed;
}

function recruitmentEventPayload(record: Omit<FeasibilityRecruitmentRecord, "eventSha256" | "userId">) {
  return {
    activation_id: record.activationId,
    campaign_id: record.campaignId,
    community_approval_sha256: record.communityApprovalSha256,
    created_at: record.createdAt,
    event_contract_version: record.eventContractVersion,
    event_id: record.eventId,
    invite_expires_at: record.inviteExpiresAt,
    invite_issued_at: record.inviteIssuedAt,
    participant_group_id: record.participantGroupId,
    recruited_at: record.recruitedAt,
    recruitment_frame_id: record.recruitmentFrameId,
    recruitment_source_id: record.recruitmentSourceId,
    selection_method: record.selectionMethod,
  };
}

async function recruitmentEventSha256(record: Omit<FeasibilityRecruitmentRecord, "eventSha256">) {
  return sha256(canonicalJson(recruitmentEventPayload(record)));
}

export async function verifyFeasibilityRecruitmentHash(
  record: Omit<FeasibilityRecruitmentRecord, "userId">,
) {
  const { eventSha256, ...unsigned } = record;
  return SHA256_PATTERN.test(eventSha256) &&
    await sha256(canonicalJson(recruitmentEventPayload(unsigned))) === eventSha256;
}

async function storedRecruitmentRecord(
  row: StoredFeasibilityRecruitment,
  accountId: string,
  activationId: string,
  participantGroupId: string,
) {
  if (
    row.user_id !== accountId || row.activation_id !== activationId ||
    row.participant_group_id !== participantGroupId ||
    row.event_contract_version !== FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION ||
    row.recruitment_frame_id !== FEASIBILITY_RECRUITMENT_FRAME_ID ||
    !PARTICIPANT_PATTERN.test(row.participant_group_id) || !SHA256_PATTERN.test(row.event_sha256) ||
    !SHA256_PATTERN.test(row.snapshot_suppression_sha256) ||
    ![FEASIBILITY_ORGANIC_SOURCE_ID, FEASIBILITY_DIRECT_SOURCE_ID, FEASIBILITY_COMMUNITY_SOURCE_ID]
      .includes(row.recruitment_source_id as FeasibilityRecruitmentSourceId) ||
    ![FEASIBILITY_SELECTION_METHOD, FEASIBILITY_DIRECT_SELECTION_METHOD]
      .includes(row.selection_method as FeasibilitySelectionMethod)
  ) return null;
  const record: FeasibilityRecruitmentRecord = {
    eventId: row.event_id,
    activationId: row.activation_id,
    userId: row.user_id,
    participantGroupId: row.participant_group_id,
    eventContractVersion: FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION,
    recruitmentFrameId: FEASIBILITY_RECRUITMENT_FRAME_ID,
    recruitmentSourceId: row.recruitment_source_id as FeasibilityRecruitmentSourceId,
    selectionMethod: row.selection_method as FeasibilitySelectionMethod,
    recruitedAt: row.recruited_at,
    campaignId: row.campaign_id,
    inviteIssuedAt: row.invite_issued_at,
    inviteExpiresAt: row.invite_expires_at,
    communityApprovalSha256: row.community_approval_sha256,
    snapshotSuppressionSha256: row.snapshot_suppression_sha256,
    eventSha256: row.event_sha256,
    createdAt: row.created_at,
  };
  const { eventSha256, ...unsigned } = record;
  return await recruitmentEventSha256(unsigned) === eventSha256 ? record : null;
}

export async function resolveFeasibilityRecruitment(input: {
  env: FeasibilityRuntimeEnv;
  activation: StoredFeasibilityActivation;
  accountId: string;
  participantGroupId: string;
  timestamp: string;
  recruitmentToken: string | null;
  campaign: StoredFeasibilityRecruitmentCampaign | null;
  existing: StoredFeasibilityRecruitment | null;
}): Promise<{ record: FeasibilityRecruitmentRecord; isNew: boolean } | null> {
  if (input.existing) {
    const record = await storedRecruitmentRecord(
      input.existing,
      input.accountId,
      input.activation.id,
      input.participantGroupId,
    );
    return record ? { record, isNew: false } : null;
  }
  if (input.recruitmentToken && !input.campaign) return null;
  const tokenPayload = input.recruitmentToken
    ? await verifyFeasibilityRecruitmentToken({
        secret: input.env.VALIDATION_RECRUITMENT_HMAC_SECRET ?? "",
        token: input.recruitmentToken,
        activation: input.activation,
        campaign: input.campaign!,
        timestamp: input.timestamp,
      })
    : null;
  if (input.recruitmentToken && !tokenPayload) return null;
  const eventId = `frecruit_${crypto.randomUUID()}`;
  const unsigned: Omit<FeasibilityRecruitmentRecord, "eventSha256"> = {
    eventId,
    activationId: input.activation.id,
    userId: input.accountId,
    participantGroupId: input.participantGroupId,
    eventContractVersion: FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION,
    recruitmentFrameId: FEASIBILITY_RECRUITMENT_FRAME_ID,
    recruitmentSourceId: tokenPayload?.recruitment_source_id ?? FEASIBILITY_ORGANIC_SOURCE_ID,
    selectionMethod: tokenPayload?.selection_method ?? FEASIBILITY_SELECTION_METHOD,
    recruitedAt: input.timestamp,
    campaignId: tokenPayload?.campaign_id ?? null,
    inviteIssuedAt: tokenPayload?.issued_at ?? null,
    inviteExpiresAt: tokenPayload?.expires_at ?? null,
    communityApprovalSha256: tokenPayload?.community_approval_sha256 ?? null,
    snapshotSuppressionSha256: await sha256(
      `${PARTICIPANT_SNAPSHOT_SUPPRESSION_DOMAIN}\u0000${input.activation.id}\u0000${input.participantGroupId}\u0000${eventId}`,
    ),
    createdAt: input.timestamp,
  };
  return {
    record: { ...unsigned, eventSha256: await recruitmentEventSha256(unsigned) },
    isNew: true,
  };
}

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export function feasibilityPilotEnabled(env: FeasibilityRuntimeEnv) {
  return enabled(env.VALIDATION_FEASIBILITY_ENABLED);
}

export function feasibilityPanelForSite(siteId: string): FeasibilityPanelId | null {
  return PANEL_BY_SITE.get(siteId) ?? null;
}

export function feasibilitySitePanelEntries() {
  return [...PANEL_BY_SITE.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export async function feasibilityParticipantGroupId(
  secret: string,
  activationId: string,
  accountId: string,
) {
  const secretBytes = new TextEncoder().encode(secret);
  if (secretBytes.byteLength < 32 || secretBytes.byteLength > 512) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${PARTICIPANT_DOMAIN}\u0000${activationId}\u0000${accountId}`;
  const digest = bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `participant-${digest}`;
}

export async function resolveFeasibilityContext(input: {
  env: FeasibilityRuntimeEnv;
  activation: StoredFeasibilityActivation | null;
  accountId: string | null;
  opportunity: AttestedOpportunity | null;
  timestamp: string;
  studyConsent: boolean;
  studyConsentVersion: string | null;
}): Promise<ActiveFeasibilityContext | null> {
  const { env, activation, opportunity } = input;
  if (!enabled(env.VALIDATION_FEASIBILITY_ENABLED) || !activation || !input.accountId || !opportunity) return null;
  if (
    activation.protocol_id !== FEASIBILITY_PROTOCOL_ID ||
    activation.protocol_version !== FEASIBILITY_PROTOCOL_VERSION ||
    activation.protocol_sha256 !== FEASIBILITY_PROTOCOL_SHA256 ||
    activation.site_catalog_sha256 !== FEASIBILITY_SITE_CATALOG_SHA256
  ) return null;
  if (activation.status !== "sealed-before-enrollment") return null;
  if (env.VALIDATION_FEASIBILITY_ACTIVATION_ID?.trim() !== activation.id) return null;
  if (
    !SHA256_PATTERN.test(activation.activation_manifest_sha256) ||
    env.VALIDATION_FEASIBILITY_ACTIVATION_MANIFEST_SHA256?.trim() !== activation.activation_manifest_sha256
  ) return null;
  if (
    !SHA256_PATTERN.test(activation.activation_commitment_sha256) ||
    env.VALIDATION_FEASIBILITY_COMMITMENT_SHA256?.trim() !== activation.activation_commitment_sha256
  ) return null;
  if (!input.studyConsent || input.studyConsentVersion !== activation.study_consent_version) return null;
  if (!env.CF_VERSION_METADATA?.id || env.CF_VERSION_METADATA.id !== activation.worker_version_id) return null;
  const now = strictTimestamp(input.timestamp);
  const start = strictTimestamp(activation.start_at);
  const end = strictTimestamp(activation.end_at);
  const preregistered = strictTimestamp(activation.preregistered_at);
  const receiptVerified = strictTimestamp(activation.receipt_verified_at);
  if (
    now === null || start === null || end === null || preregistered === null || receiptVerified === null ||
    now < start || now >= end || preregistered >= start || receiptVerified < preregistered || receiptVerified >= start
  ) return null;
  if (
    activation.site_catalog_sha256 !== opportunity.siteCatalogSha256 ||
    activation.scoring_system_kind !== opportunity.scoringSystemKind ||
    activation.scoring_system_version !== opportunity.scoringSystemVersion ||
    activation.scoring_system_sha256 !== opportunity.scoringSystemSha256
  ) return null;
  const participantGroupId = await feasibilityParticipantGroupId(
    env.VALIDATION_PARTICIPANT_HMAC_SECRET ?? "",
    activation.id,
    input.accountId,
  );
  return participantGroupId ? { activation, participantGroupId } : null;
}

function eventPayload(record: Omit<FeasibilityEventRecord, "eventSha256">) {
  return {
    activation_id: record.activationId,
    angler_count: record.anglerCount,
    effort_minutes: record.effortMinutes,
    event_at: record.eventAt,
    event_contract_version: record.eventContractVersion,
    event_id: record.eventId,
    event_type: record.eventType,
    geographic_panel: record.geographicPanel,
    identification_confidence: record.identificationConfidence,
    mode: record.mode,
    opportunity_score: record.opportunityScore,
    opportunity_window_id: record.opportunityWindowId,
    participant_group_id: record.participantGroupId,
    previous_event_sha256: record.previousEventSha256,
    recruitment_frame_id: record.recruitmentFrameId,
    recruitment_source_id: record.recruitmentSourceId,
    score_influenced_choice: record.scoreInfluencedChoice,
    scoring_system_kind: record.scoringSystemKind,
    scoring_system_sha256: record.scoringSystemSha256,
    scoring_system_version: record.scoringSystemVersion,
    segment_end_at: record.segmentEndAt,
    segment_start_at: record.segmentStartAt,
    selection_method: record.selectionMethod,
    site_id: record.siteId,
    snapshot_sha256: record.snapshotSha256,
    source_record_sha256: record.sourceRecordSha256,
    study_consent_version: record.studyConsentVersion,
    study_consented_at: record.studyConsentedAt,
    target_encounter_count: record.targetEncounterCount,
    target_encountered: record.targetEncountered,
    target_released_count: record.targetReleasedCount,
    target_retained_count: record.targetRetainedCount,
    target_taxon_id: record.targetTaxonId,
    terminal_reason: record.terminalReason,
    trip_id: record.tripId,
  };
}

async function finishEvent(record: Omit<FeasibilityEventRecord, "eventSha256">): Promise<FeasibilityEventRecord> {
  return {
    ...record,
    eventSha256: await sha256(canonicalJson(eventPayload(record))),
  };
}

export async function buildFeasibilityStartEvent(input: {
  context: ActiveFeasibilityContext;
  recruitment: FeasibilityRecruitmentRecord;
  tripId: string;
  opportunity: AttestedOpportunity;
  siteId: string;
  mode: string;
  anglerCount: number;
  scoreInfluencedChoice: boolean;
  timestamp: string;
}): Promise<FeasibilityEventRecord | null> {
  const panel = feasibilityPanelForSite(input.siteId);
  if (!panel || !["shore", "beach", "pier", "jetty"].includes(input.mode)) return null;
  if (
    input.recruitment.activationId !== input.context.activation.id ||
    input.recruitment.participantGroupId !== input.context.participantGroupId
  ) return null;
  if (
    !Number.isInteger(input.opportunity.opportunityScore) ||
    input.opportunity.opportunityScore < 0 || input.opportunity.opportunityScore > 100 ||
    !Number.isInteger(input.anglerCount) || input.anglerCount < 1 || input.anglerCount > 12 ||
    strictTimestamp(input.timestamp) === null
  ) return null;
  const sourceRecordSha256 = await sha256(`${SOURCE_RECORD_DOMAIN}\u0000${input.context.activation.id}\u0000${input.tripId}`);
  const eventId = `fevent_${crypto.randomUUID()}`;
  return finishEvent({
    eventId,
    activationId: input.context.activation.id,
    tripId: input.tripId,
    eventType: "started",
    eventContractVersion: FEASIBILITY_EVENT_CONTRACT_VERSION,
    sourceRecordSha256,
    participantGroupId: input.context.participantGroupId,
    recruitmentFrameId: FEASIBILITY_RECRUITMENT_FRAME_ID,
    recruitmentSourceId: input.recruitment.recruitmentSourceId,
    selectionMethod: input.recruitment.selectionMethod,
    scoreInfluencedChoice: input.scoreInfluencedChoice,
    studyConsentVersion: input.context.activation.study_consent_version,
    studyConsentedAt: input.timestamp,
    targetTaxonId: "california-halibut",
    siteId: input.siteId,
    geographicPanel: panel,
    mode: input.mode as FeasibilityEventRecord["mode"],
    segmentStartAt: input.timestamp,
    segmentEndAt: null,
    anglerCount: input.anglerCount,
    effortMinutes: null,
    targetEncountered: null,
    targetEncounterCount: null,
    targetRetainedCount: null,
    targetReleasedCount: null,
    identificationConfidence: null,
    scoringSystemKind: "heuristic-configuration",
    scoringSystemVersion: input.opportunity.scoringSystemVersion,
    scoringSystemSha256: input.opportunity.scoringSystemSha256,
    opportunityScore: input.opportunity.opportunityScore,
    opportunityWindowId: input.opportunity.windowId,
    snapshotSha256: input.opportunity.snapshotSha256,
    snapshotSuppressionSha256: await sha256(
      `${TRIP_SNAPSHOT_SUPPRESSION_DOMAIN}\u0000${input.context.activation.id}\u0000${input.tripId}\u0000${eventId}`,
    ),
    terminalReason: null,
    previousEventSha256: null,
    eventAt: input.timestamp,
  });
}

function storedStartIdentity(start: StoredFeasibilityStart) {
  if (
    !PARTICIPANT_PATTERN.test(start.participant_group_id) ||
    !SHA256_PATTERN.test(start.event_sha256) ||
    !SHA256_PATTERN.test(start.source_record_sha256) ||
    !SHA256_PATTERN.test(start.scoring_system_sha256) ||
    !SHA256_PATTERN.test(start.snapshot_sha256) ||
    !SHA256_PATTERN.test(start.snapshot_suppression_sha256)
  ) return null;
  return {
    activationId: start.activation_id,
    tripId: start.trip_id,
    sourceRecordSha256: start.source_record_sha256,
    participantGroupId: start.participant_group_id,
    recruitmentFrameId: start.recruitment_frame_id,
    recruitmentSourceId: start.recruitment_source_id,
    selectionMethod: start.selection_method,
    scoreInfluencedChoice: Boolean(start.score_influenced_choice),
    studyConsentVersion: start.study_consent_version,
    studyConsentedAt: start.study_consented_at,
    targetTaxonId: start.target_taxon_id,
    siteId: start.site_id,
    geographicPanel: start.geographic_panel,
    mode: start.mode,
    segmentStartAt: start.segment_start_at,
    anglerCount: start.angler_count,
    scoringSystemKind: start.scoring_system_kind,
    scoringSystemVersion: start.scoring_system_version,
    scoringSystemSha256: start.scoring_system_sha256,
    opportunityScore: start.opportunity_score,
    opportunityWindowId: start.opportunity_window_id,
    snapshotSha256: start.snapshot_sha256,
    snapshotSuppressionSha256: start.snapshot_suppression_sha256,
    previousEventSha256: start.event_sha256,
  } as const;
}

export async function buildFeasibilityCompletionEvent(input: {
  start: StoredFeasibilityStart;
  timestamp: string;
  anglerCount: number;
  targetEncounterCount: number;
  targetRetainedCount: number;
  targetReleasedCount: number;
}): Promise<FeasibilityEventRecord | null> {
  const identity = storedStartIdentity(input.start);
  const startMs = strictTimestamp(input.start.segment_start_at);
  const endMs = strictTimestamp(input.timestamp);
  if (
    !identity || startMs === null || endMs === null || endMs <= startMs ||
    endMs - startMs > MAX_ATTEMPT_MILLISECONDS
  ) return null;
  if (
    input.anglerCount !== input.start.angler_count ||
    !Number.isInteger(input.targetEncounterCount) || input.targetEncounterCount < 0 || input.targetEncounterCount > 40 ||
    !Number.isInteger(input.targetRetainedCount) || input.targetRetainedCount < 0 || input.targetRetainedCount > 25 ||
    !Number.isInteger(input.targetReleasedCount) || input.targetReleasedCount < 0 || input.targetReleasedCount > 25 ||
    input.targetEncounterCount !== input.targetRetainedCount + input.targetReleasedCount
  ) return null;
  return finishEvent({
    ...identity,
    eventId: `fevent_${crypto.randomUUID()}`,
    eventType: "completed",
    eventContractVersion: FEASIBILITY_EVENT_CONTRACT_VERSION,
    segmentEndAt: input.timestamp,
    effortMinutes: (endMs - startMs) / 60_000,
    targetEncountered: input.targetEncounterCount > 0,
    targetEncounterCount: input.targetEncounterCount,
    targetRetainedCount: input.targetRetainedCount,
    targetReleasedCount: input.targetReleasedCount,
    identificationConfidence: input.targetEncounterCount > 0 ? "self_reported" : "not_observed",
    terminalReason: null,
    eventAt: input.timestamp,
  });
}

export async function buildFeasibilityCancellationEvent(input: {
  start: StoredFeasibilityStart;
  timestamp: string;
  reason: SafeCancellationReason;
}): Promise<FeasibilityEventRecord | null> {
  const identity = storedStartIdentity(input.start);
  const startMs = strictTimestamp(input.start.segment_start_at);
  const endMs = strictTimestamp(input.timestamp);
  if (
    !identity || startMs === null || endMs === null || endMs < startMs ||
    endMs - startMs > MAX_ATTEMPT_MILLISECONDS || !SAFE_CANCELLATION_REASONS.has(input.reason)
  ) return null;
  return finishEvent({
    ...identity,
    eventId: `fevent_${crypto.randomUUID()}`,
    eventType: "safe_canceled",
    eventContractVersion: FEASIBILITY_EVENT_CONTRACT_VERSION,
    segmentEndAt: input.timestamp,
    effortMinutes: (endMs - startMs) / 60_000,
    targetEncountered: null,
    targetEncounterCount: null,
    targetRetainedCount: null,
    targetReleasedCount: null,
    identificationConfidence: null,
    terminalReason: input.reason,
    eventAt: input.timestamp,
  });
}

function correctionPayload(record: Omit<FeasibilityCorrectionRecord, "eventSha256">) {
  return {
    activation_id: record.activationId,
    analytical_status: record.analyticalStatus,
    angler_count: record.anglerCount,
    corrected_at: record.correctedAt,
    correction_contract_version: record.correctionContractVersion,
    correction_id: record.correctionId,
    correction_reason: record.correctionReason,
    effort_minutes: record.effortMinutes,
    geographic_panel: record.geographicPanel,
    identification_confidence: record.identificationConfidence,
    mode: record.mode,
    previous_event_sha256: record.previousEventSha256,
    root_completion_event_sha256: record.rootCompletionEventSha256,
    segment_end_at: record.segmentEndAt,
    segment_start_at: record.segmentStartAt,
    site_id: record.siteId,
    target_encounter_count: record.targetEncounterCount,
    target_encountered: record.targetEncountered,
    target_released_count: record.targetReleasedCount,
    target_retained_count: record.targetRetainedCount,
    trip_id: record.tripId,
  };
}

export async function buildFeasibilityCorrectionEvent(input: {
  start: StoredFeasibilityStart;
  rootCompletionEventSha256: string;
  previousEventSha256: string;
  siteId: string;
  mode: string;
  segmentStartAt: string;
  segmentEndAt: string;
  anglerCount: number;
  targetEncounterCount: number;
  targetRetainedCount: number;
  targetReleasedCount: number;
  correctedAt: string;
}): Promise<FeasibilityCorrectionRecord | null> {
  const panel = feasibilityPanelForSite(input.siteId);
  const startMs = strictTimestamp(input.segmentStartAt);
  const endMs = strictTimestamp(input.segmentEndAt);
  const correctedMs = strictTimestamp(input.correctedAt);
  if (
    !panel || !["shore", "beach", "pier", "jetty", "kayak", "boat", "other"].includes(input.mode) ||
    !SHA256_PATTERN.test(input.rootCompletionEventSha256) ||
    !SHA256_PATTERN.test(input.previousEventSha256) ||
    startMs === null || endMs === null || correctedMs === null || endMs <= startMs ||
    endMs - startMs > MAX_ATTEMPT_MILLISECONDS || correctedMs < endMs ||
    !Number.isInteger(input.anglerCount) || input.anglerCount < 1 || input.anglerCount > 12 ||
    !Number.isInteger(input.targetEncounterCount) || input.targetEncounterCount < 0 || input.targetEncounterCount > 40 ||
    !Number.isInteger(input.targetRetainedCount) || input.targetRetainedCount < 0 || input.targetRetainedCount > 25 ||
    !Number.isInteger(input.targetReleasedCount) || input.targetReleasedCount < 0 || input.targetReleasedCount > 25 ||
    input.targetEncounterCount !== input.targetRetainedCount + input.targetReleasedCount
  ) return null;
  const identityStillEligible = input.siteId === input.start.site_id && panel === input.start.geographic_panel &&
    input.mode === input.start.mode && input.segmentStartAt === input.start.segment_start_at &&
    input.anglerCount === input.start.angler_count;
  const unsigned: Omit<FeasibilityCorrectionRecord, "eventSha256"> = {
    correctionId: `fcorrect_${crypto.randomUUID()}`,
    activationId: input.start.activation_id,
    tripId: input.start.trip_id,
    correctionContractVersion: FEASIBILITY_CORRECTION_CONTRACT_VERSION,
    rootCompletionEventSha256: input.rootCompletionEventSha256,
    previousEventSha256: input.previousEventSha256,
    correctionReason: "participant_profile_edit",
    analyticalStatus: identityStillEligible
      ? "eligible_corrected_completion"
      : "excluded_after_identity_correction",
    siteId: input.siteId,
    geographicPanel: panel,
    mode: input.mode as FeasibilityCorrectionRecord["mode"],
    segmentStartAt: input.segmentStartAt,
    segmentEndAt: input.segmentEndAt,
    anglerCount: input.anglerCount,
    effortMinutes: (endMs - startMs) / 60_000,
    targetEncountered: input.targetEncounterCount > 0,
    targetEncounterCount: input.targetEncounterCount,
    targetRetainedCount: input.targetRetainedCount,
    targetReleasedCount: input.targetReleasedCount,
    identificationConfidence: input.targetEncounterCount > 0 ? "self_reported" : "not_observed",
    correctedAt: input.correctedAt,
  };
  return { ...unsigned, eventSha256: await sha256(canonicalJson(correctionPayload(unsigned))) };
}

export async function verifyFeasibilityCorrectionHash(correction: FeasibilityCorrectionRecord) {
  const { eventSha256, ...record } = correction;
  return SHA256_PATTERN.test(eventSha256) &&
    await sha256(canonicalJson(correctionPayload(record))) === eventSha256;
}

export async function verifyFeasibilityEventHash(event: FeasibilityEventRecord) {
  const { eventSha256, ...record } = event;
  return SHA256_PATTERN.test(eventSha256) && await sha256(canonicalJson(eventPayload(record))) === eventSha256;
}

export async function reconcileFeasibilityEvents(input: {
  events: FeasibilityEventRecord[];
  corrections?: FeasibilityCorrectionRecord[];
  privacyRemovals?: FeasibilityPrivacyRemovalSummary;
  snapshotAndRestorePassed: boolean;
}): Promise<FeasibilityReconciliationResult> {
  const starts = new Map<string, FeasibilityEventRecord>();
  const terminals = new Map<string, FeasibilityEventRecord>();
  const integrityFailures = new Set<string>();
  for (const event of input.events) {
    if (!await verifyFeasibilityEventHash(event)) integrityFailures.add("invalid_event_hash");
    if (event.eventType === "started") {
      if (starts.has(event.tripId)) integrityFailures.add("duplicate_start_event");
      else starts.set(event.tripId, event);
    } else {
      if (terminals.has(event.tripId)) integrityFailures.add("duplicate_terminal_event");
      else terminals.set(event.tripId, event);
    }
  }

  for (const [tripId, terminal] of terminals) {
    const start = starts.get(tripId);
    if (!start) {
      integrityFailures.add("orphan_terminal_event");
      continue;
    }
    if (
      terminal.activationId !== start.activationId ||
      terminal.previousEventSha256 !== start.eventSha256 ||
      terminal.sourceRecordSha256 !== start.sourceRecordSha256 ||
      terminal.participantGroupId !== start.participantGroupId ||
      terminal.segmentStartAt !== start.segmentStartAt
    ) integrityFailures.add("terminal_identity_mismatch");
  }

  const rawCompleted = [...terminals.values()].filter((event) => event.eventType === "completed");
  const safeCanceled = [...terminals.values()].filter((event) => event.eventType === "safe_canceled");
  const rawCompletionByTrip = new Map(rawCompleted.map((event) => [event.tripId, event]));
  const latestCorrections = new Map<string, FeasibilityCorrectionRecord>();
  for (const correction of input.corrections ?? []) {
    if (!await verifyFeasibilityCorrectionHash(correction)) {
      integrityFailures.add("invalid_correction_hash");
      continue;
    }
    const completion = rawCompletionByTrip.get(correction.tripId);
    const previous = latestCorrections.get(correction.tripId);
    if (
      !completion || correction.activationId !== completion.activationId ||
      correction.rootCompletionEventSha256 !== completion.eventSha256 ||
      correction.previousEventSha256 !== (previous?.eventSha256 ?? completion.eventSha256)
    ) {
      integrityFailures.add("invalid_correction_chain");
      continue;
    }
    latestCorrections.set(correction.tripId, correction);
  }
  const identityCorrectionExclusions = [...latestCorrections.values()]
    .filter((correction) => correction.analyticalStatus === "excluded_after_identity_correction").length;
  const completed = rawCompleted.flatMap((event) => {
    const correction = latestCorrections.get(event.tripId);
    if (!correction) return [event];
    if (correction.analyticalStatus === "excluded_after_identity_correction") return [];
    return [{
      ...event,
      siteId: correction.siteId,
      geographicPanel: correction.geographicPanel,
      mode: correction.mode as FeasibilityEventRecord["mode"],
      segmentStartAt: correction.segmentStartAt,
      segmentEndAt: correction.segmentEndAt,
      anglerCount: correction.anglerCount,
      effortMinutes: correction.effortMinutes,
      targetEncountered: correction.targetEncountered,
      targetEncounterCount: correction.targetEncounterCount,
      targetRetainedCount: correction.targetRetainedCount,
      targetReleasedCount: correction.targetReleasedCount,
      identificationConfidence: correction.identificationConfidence,
    }];
  });
  const retainedReconciled = [...starts.keys()].filter((tripId) => terminals.has(tripId)).length;
  const unreconciled = starts.size - retainedReconciled;
  const privacyRemovals = input.privacyRemovals ?? {
    removedStartedAttempts: 0,
    removedCompletedAttempts: 0,
    removedSafeCanceledAttempts: 0,
  };
  const validPrivacyRemovalLedger = [
    privacyRemovals.removedStartedAttempts,
    privacyRemovals.removedCompletedAttempts,
    privacyRemovals.removedSafeCanceledAttempts,
  ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    privacyRemovals.removedCompletedAttempts + privacyRemovals.removedSafeCanceledAttempts <=
      privacyRemovals.removedStartedAttempts;
  const removedStarts = validPrivacyRemovalLedger ? privacyRemovals.removedStartedAttempts : 0;
  const totalStarts = starts.size + removedStarts;
  const eligibleCompletionDenominator = starts.size - safeCanceled.length;
  const completionRate = eligibleCompletionDenominator > 0 ? completed.length / eligibleCompletionDenominator : 0;
  const reconciliationRate = totalStarts > 0 ? (retainedReconciled + removedStarts) / totalStarts : 0;
  const participantCounts = new Map<string, number>();
  for (const event of completed) {
    participantCounts.set(event.participantGroupId, (participantCounts.get(event.participantGroupId) ?? 0) + 1);
  }
  const maximumParticipantAttempts = Math.max(0, ...participantCounts.values());
  const maxShare = completed.length > 0 ? maximumParticipantAttempts / completed.length : 0;
  const targetEncounters = completed.filter((event) => event.targetEncountered === true).length;
  const nonEncounters = completed.filter((event) => event.targetEncountered === false).length;
  const panels = new Set(completed.map((event) => event.geographicPanel));
  const sources = new Set(completed.map((event) => event.recruitmentSourceId));
  let missingRequired = 0;
  let requiredChecks = 0;
  for (const event of completed) {
    for (const value of [
      event.participantGroupId,
      event.targetTaxonId,
      event.siteId,
      event.mode,
      event.segmentStartAt,
      event.segmentEndAt,
      event.anglerCount,
      event.effortMinutes,
      event.targetEncountered,
      event.targetEncounterCount,
      event.targetRetainedCount,
      event.targetReleasedCount,
      event.identificationConfidence,
      event.scoreInfluencedChoice,
      event.selectionMethod,
      event.recruitmentSourceId,
      event.studyConsentVersion,
      event.studyConsentedAt,
      event.scoringSystemKind,
      event.scoringSystemVersion,
      event.scoringSystemSha256,
      event.opportunityScore,
      event.opportunityWindowId,
      event.snapshotSha256,
      event.sourceRecordSha256,
    ]) {
      requiredChecks += 1;
      if (value === null || value === undefined || value === "") missingRequired += 1;
    }
  }
  const missingness = requiredChecks > 0 ? missingRequired / requiredChecks : 1;
  const failedGates: string[] = [...integrityFailures].sort();
  if (!validPrivacyRemovalLedger) failedGates.push("privacy_removal_ledger_invalid");
  if (completed.length < 100) failedGates.push("minimum_complete_attempts");
  if (participantCounts.size < 50) failedGates.push("minimum_unique_participant_groups");
  if (targetEncounters < 10) failedGates.push("minimum_target_encounters");
  if (nonEncounters < 50) failedGates.push("minimum_non_encounters");
  if (completionRate < 0.8) failedGates.push("minimum_completion_rate");
  if (reconciliationRate < 1) failedGates.push("minimum_reconciliation_rate");
  if (missingness > 0.02) failedGates.push("maximum_required_field_missingness");
  if (maxShare > 0.1) failedGates.push("maximum_single_participant_share");
  if (panels.size < 3) failedGates.push("minimum_geographic_panels_with_attempts");
  if (sources.size < 2) failedGates.push("minimum_recruitment_sources_with_attempts");
  if (!input.snapshotAndRestorePassed) failedGates.push("snapshot_and_restore_success");

  return {
    status: failedGates.length === 0
      ? "collection-feasibility-demonstrated"
      : "collection-feasibility-not-demonstrated",
    startedAttempts: totalStarts,
    retainedStartedAttempts: starts.size,
    completedAttempts: completed.length,
    safeCanceledAttempts: safeCanceled.length,
    correctionEvents: input.corrections?.length ?? 0,
    identityCorrectionExclusions,
    unreconciledAttempts: unreconciled,
    reconciliationRate,
    completionRateExcludingSafeCancellations: completionRate,
    uniqueParticipantGroups: participantCounts.size,
    targetEncounters,
    nonEncounters,
    maximumSingleParticipantShare: maxShare,
    geographicPanelsWithAttempts: panels.size,
    recruitmentSourcesWithAttempts: sources.size,
    removedStartedAttempts: privacyRemovals.removedStartedAttempts,
    removedCompletedAttempts: privacyRemovals.removedCompletedAttempts,
    removedSafeCanceledAttempts: privacyRemovals.removedSafeCanceledAttempts,
    requiredFieldMissingness: missingness,
    snapshotAndRestorePassed: input.snapshotAndRestorePassed,
    failedGates,
    candidatePerformanceComputed: false,
  };
}
