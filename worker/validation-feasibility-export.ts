import {
  FEASIBILITY_CORRECTION_CONTRACT_VERSION,
  FEASIBILITY_EVENT_CONTRACT_VERSION,
  reconcileFeasibilityEvents,
  type FeasibilityCorrectionRecord,
  type FeasibilityEventRecord,
} from "./validation-feasibility.ts";

interface PreparedStatementLike {
  bind(...values: unknown[]): PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface FeasibilityExportDatabaseLike {
  prepare(query: string): PreparedStatementLike;
}

interface StoredEventProjection extends Omit<FeasibilityEventRecord,
  "scoreInfluencedChoice" | "targetEncountered" | "eventContractVersion"> {
  scoreInfluencedChoice: number;
  targetEncountered: number | null;
  eventContractVersion: string;
}

interface RemovalTotals {
  removedStartedAttempts: number;
  removedCompletedAttempts: number;
  removedSafeCanceledAttempts: number;
}

interface StoredCorrectionProjection extends Omit<FeasibilityCorrectionRecord,
  "correctionContractVersion" | "targetEncountered"> {
  correctionContractVersion: string;
  targetEncountered: number;
}

export const FEASIBILITY_RECONCILIATION_EXPORT_VERSION =
  "castingcompass.validation-feasibility-reconciliation/2.0.0" as const;

const EVENT_EXPORT_SQL = `SELECT
  event_id AS eventId,
  activation_id AS activationId,
  trip_id AS tripId,
  event_type AS eventType,
  event_contract_version AS eventContractVersion,
  source_record_sha256 AS sourceRecordSha256,
  participant_group_id AS participantGroupId,
  recruitment_frame_id AS recruitmentFrameId,
  recruitment_source_id AS recruitmentSourceId,
  selection_method AS selectionMethod,
  score_influenced_choice AS scoreInfluencedChoice,
  study_consent_version AS studyConsentVersion,
  study_consented_at AS studyConsentedAt,
  target_taxon_id AS targetTaxonId,
  site_id AS siteId,
  geographic_panel AS geographicPanel,
  mode,
  segment_start_at AS segmentStartAt,
  segment_end_at AS segmentEndAt,
  angler_count AS anglerCount,
  effort_minutes AS effortMinutes,
  target_encountered AS targetEncountered,
  target_encounter_count AS targetEncounterCount,
  target_retained_count AS targetRetainedCount,
  target_released_count AS targetReleasedCount,
  identification_confidence AS identificationConfidence,
  scoring_system_kind AS scoringSystemKind,
  scoring_system_version AS scoringSystemVersion,
  scoring_system_sha256 AS scoringSystemSha256,
  opportunity_score AS opportunityScore,
  opportunity_window_id AS opportunityWindowId,
  snapshot_sha256 AS snapshotSha256,
  snapshot_suppression_sha256 AS snapshotSuppressionSha256,
  terminal_reason AS terminalReason,
  previous_event_sha256 AS previousEventSha256,
  event_at AS eventAt,
  event_sha256 AS eventSha256
FROM validation_feasibility_events
WHERE activation_id = ?
ORDER BY sequence ASC`;

const CORRECTION_EXPORT_SQL = `SELECT
  correction_id AS correctionId,
  activation_id AS activationId,
  trip_id AS tripId,
  correction_contract_version AS correctionContractVersion,
  root_completion_event_sha256 AS rootCompletionEventSha256,
  previous_event_sha256 AS previousEventSha256,
  correction_reason AS correctionReason,
  analytical_status AS analyticalStatus,
  site_id AS siteId,
  geographic_panel AS geographicPanel,
  mode,
  segment_start_at AS segmentStartAt,
  segment_end_at AS segmentEndAt,
  angler_count AS anglerCount,
  effort_minutes AS effortMinutes,
  target_encountered AS targetEncountered,
  target_encounter_count AS targetEncounterCount,
  target_retained_count AS targetRetainedCount,
  target_released_count AS targetReleasedCount,
  identification_confidence AS identificationConfidence,
  corrected_at AS correctedAt,
  event_sha256 AS eventSha256
FROM validation_feasibility_corrections
WHERE activation_id = ?
ORDER BY sequence ASC`;

function normalizeEvent(row: StoredEventProjection): FeasibilityEventRecord {
  if (row.eventContractVersion !== FEASIBILITY_EVENT_CONTRACT_VERSION) {
    throw new Error("Unexpected feasibility event contract version");
  }
  return {
    ...row,
    eventContractVersion: FEASIBILITY_EVENT_CONTRACT_VERSION,
    scoreInfluencedChoice: Boolean(row.scoreInfluencedChoice),
    targetEncountered: row.targetEncountered === null ? null : Boolean(row.targetEncountered),
  };
}

function normalizeCorrection(row: StoredCorrectionProjection): FeasibilityCorrectionRecord {
  if (row.correctionContractVersion !== FEASIBILITY_CORRECTION_CONTRACT_VERSION) {
    throw new Error("Unexpected feasibility correction contract version");
  }
  return {
    ...row,
    correctionContractVersion: FEASIBILITY_CORRECTION_CONTRACT_VERSION,
    targetEncountered: Boolean(row.targetEncountered),
  };
}

export async function buildFeasibilityReconciliationExport(input: {
  db: FeasibilityExportDatabaseLike;
  activationId: string;
  snapshotAndRestorePassed: boolean;
  exportedAt?: string;
}) {
  if (!input.activationId || input.activationId.length > 200) throw new Error("Invalid feasibility activation ID");
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  if (new Date(exportedAt).toISOString() !== exportedAt) throw new Error("Invalid reconciliation export timestamp");
  const [storedEvents, storedCorrections, removalTotals] = await Promise.all([
    input.db.prepare(EVENT_EXPORT_SQL).bind(input.activationId).all<StoredEventProjection>(),
    input.db.prepare(CORRECTION_EXPORT_SQL).bind(input.activationId).all<StoredCorrectionProjection>(),
    input.db.prepare(`SELECT
        COALESCE(SUM(removed_started_attempt_count), 0) AS removedStartedAttempts,
        COALESCE(SUM(removed_completed_attempt_count), 0) AS removedCompletedAttempts,
        COALESCE(SUM(removed_safe_canceled_attempt_count), 0) AS removedSafeCanceledAttempts
      FROM validation_feasibility_privacy_removals WHERE activation_id = ?`)
      .bind(input.activationId)
      .first<RemovalTotals>(),
  ]);
  const events = (storedEvents.results ?? []).map(normalizeEvent);
  const corrections = (storedCorrections.results ?? []).map(normalizeCorrection);
  if (events.some((event) => event.activationId !== input.activationId)) {
    throw new Error("Feasibility export crossed activation boundaries");
  }
  if (corrections.some((correction) => correction.activationId !== input.activationId)) {
    throw new Error("Feasibility correction export crossed activation boundaries");
  }
  const privacyRemovals = removalTotals ?? {
    removedStartedAttempts: 0,
    removedCompletedAttempts: 0,
    removedSafeCanceledAttempts: 0,
  };
  const reconciliation = await reconcileFeasibilityEvents({
    events,
    corrections,
    privacyRemovals,
    snapshotAndRestorePassed: input.snapshotAndRestorePassed,
  });
  return {
    schemaVersion: FEASIBILITY_RECONCILIATION_EXPORT_VERSION,
    activationId: input.activationId,
    exportedAt,
    privateRawRowsPublished: false as const,
    candidatePerformanceComputed: false as const,
    eventCount: events.length,
    reconciliation,
  };
}
