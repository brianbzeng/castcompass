import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordHash: text("password_hash").notNull(),
    ageEligibilityConfirmedAt: text("age_eligibility_confirmed_at"),
    termsAcceptedAt: text("terms_accepted_at"),
    termsVersion: text("terms_version"),
    privacyAcceptedAt: text("privacy_accepted_at"),
    privacyVersion: text("privacy_version"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("auth_sessions_user_idx").on(table.userId, table.expiresAt),
    index("auth_sessions_expires_idx").on(table.expiresAt),
  ],
);

export const savedSites = sqliteTable(
  "saved_sites",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    siteId: text("site_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.siteId] }),
    index("saved_sites_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const authAttempts = sqliteTable(
  "auth_attempts",
  {
    id: text("id").primaryKey(),
    emailHash: text("email_hash").notNull(),
    attemptedAt: text("attempted_at").notNull(),
    successful: integer("successful", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("auth_attempts_email_time_idx").on(table.emailHash, table.attemptedAt),
    index("auth_attempts_attempted_idx").on(table.attemptedAt),
  ],
);

export const emailChallenges = sqliteTable(
  "email_challenges",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    email: text("email").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    passwordSalt: text("password_salt"),
    passwordHash: text("password_hash"),
    ageEligibilityConfirmedAt: text("age_eligibility_confirmed_at"),
    termsVersion: text("terms_version"),
    privacyVersion: text("privacy_version"),
    expiresAt: text("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    resendCount: integer("resend_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("email_challenges_kind_check", sql`${table.kind} in ('signup', 'password_reset')`),
    index("email_challenges_email_time_idx").on(table.email, table.createdAt),
    index("email_challenges_expires_idx").on(table.expiresAt),
    index("email_challenges_user_idx").on(table.userId).where(sql`${table.userId} is not null`),
  ],
);

export const signupAgeProofs = sqliteTable(
  "signup_age_proofs",
  {
    tokenHash: text("token_hash").primaryKey(),
    confirmedAt: text("confirmed_at").notNull(),
    gateVersion: text("gate_version").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("signup_age_proofs_expiry_idx").on(table.expiresAt, table.consumedAt),
    index("signup_age_proofs_consumed_idx").on(table.consumedAt).where(sql`${table.consumedAt} is not null`),
  ],
);

export const privacyDeletionJobs = sqliteTable(
  "privacy_deletion_jobs",
  {
    id: text("id").primaryKey(),
    receiptHash: text("receipt_hash").notNull(),
    scope: text("scope").notNull(),
    subjectHash: text("subject_hash").notNull(),
    ownerSubjectHash: text("owner_subject_hash").notNull(),
    state: text("state").notNull(),
    objectsTotal: integer("objects_total").notNull().default(0),
    objectsDeleted: integer("objects_deleted").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    requestedAt: text("requested_at").notNull(),
    activeDataRemovedAt: text("active_data_removed_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("privacy_deletion_jobs_receipt_unique").on(table.receiptHash),
    index("privacy_deletion_jobs_state_updated_idx").on(table.state, table.updatedAt),
    index("privacy_deletion_jobs_owner_state_idx").on(table.ownerSubjectHash, table.state, table.updatedAt),
    index("privacy_deletion_jobs_scope_subject_idx").on(table.scope, table.subjectHash),
    index("privacy_deletion_jobs_state_completed_idx").on(table.state, table.completedAt),
    check("privacy_deletion_jobs_scope_check", sql`${table.scope} in ('account', 'trip')`),
    check(
      "privacy_deletion_jobs_state_check",
      sql`${table.state} in ('active_data_removed', 'purging', 'completed', 'needs_attention')`,
    ),
  ],
);

export const privacyDeletionTasks = sqliteTable(
  "privacy_deletion_tasks",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => privacyDeletionJobs.id, { onDelete: "cascade" }),
    objectKey: text("object_key"),
    objectKeyHash: text("object_key_hash").notNull(),
    state: text("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: text("available_at").notNull(),
    leaseExpiresAt: text("lease_expires_at"),
    leaseToken: text("lease_token"),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("privacy_deletion_tasks_job_object_unique").on(table.jobId, table.objectKeyHash),
    index("privacy_deletion_tasks_retry_idx").on(table.state, table.availableAt, table.leaseExpiresAt),
    check("privacy_deletion_tasks_state_check", sql`${table.state} in ('pending', 'leased', 'completed', 'needs_attention')`),
    check(
      "privacy_deletion_tasks_locator_check",
      sql`((${table.state} = 'completed' and ${table.objectKey} is null) or (${table.state} != 'completed' and ${table.objectKey} is not null))`,
    ),
  ],
);

export const gearProfiles = sqliteTable(
  "gear_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rod: text("rod"),
    reel: text("reel"),
    baitLure: text("bait_lure"),
    rig: text("rig"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("gear_profiles_user_name_unique").on(table.userId, table.name),
    index("gear_profiles_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const trips = sqliteTable(
  "trips",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    source: text("source").notNull(),
    siteId: text("site_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    mode: text("mode").notNull(),
    fishingMethod: text("fishing_method"),
    gear: text("gear"),
    gearProfileId: text("gear_profile_id"),
    rod: text("rod"),
    reel: text("reel"),
    baitLure: text("bait_lure"),
    rig: text("rig"),
    anglerCount: integer("angler_count").notNull(),
    anglerHours: real("angler_hours"),
    keeperCount: integer("keeper_count"),
    shortReleasedCount: integer("short_released_count"),
    halibutEncounters: integer("halibut_encounters"),
    noCatch: integer("no_catch", { mode: "boolean" }),
    otherCatchCount: integer("other_catch_count"),
    otherSpecies: text("other_species"),
    observationsJson: text("observations_json"),
    observationContractVersion: text("observation_contract_version"),
    taxonCatalogVersion: text("taxon_catalog_version"),
    targetTaxonId: text("target_taxon_id").notNull().default("california-halibut"),
    contractStatus: text("contract_status"),
    taxonObservationsJson: text("taxon_observations_json"),
    outcomeClass: text("outcome_class"),
    targetEncounterCount: integer("target_encounter_count"),
    anyFishEncounterCount: integer("any_fish_encounter_count"),
    targetIdentificationConfidence: text("target_identification_confidence"),
    notes: text("notes"),
    consent: integer("consent", { mode: "boolean" }).notNull(),
    consentAt: text("consent_at"),
    moderationStatus: text("moderation_status").notNull(),
    reporterKeyHash: text("reporter_key_hash").notNull(),
    referralCode: text("referral_code"),
    tokenHash: text("token_hash"),
    idempotencyKeyHash: text("idempotency_key_hash"),
    opportunityWindowId: text("opportunity_window_id"),
    opportunityScore: real("opportunity_score"),
    habitatScore: real("habitat_score"),
    seasonalityScore: real("seasonality_score"),
    conditionsScore: real("conditions_score"),
    fishabilityScore: real("fishability_score"),
    modelVersion: text("model_version"),
    scoreInfluencedChoice: integer("score_influenced_choice", { mode: "boolean" }),
    predictionMetadataJson: text("prediction_metadata_json"),
    photoKey: text("photo_key"),
    photoContentType: text("photo_content_type"),
    photoSizeBytes: integer("photo_size_bytes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    aiReviewStatus: text("ai_review_status"),
    aiReviewJson: text("ai_review_json"),
    aiReviewModel: text("ai_review_model"),
    aiReviewedAt: text("ai_reviewed_at"),
  },
  (table) => [
    check("trips_status_check", sql`${table.status} in ('active', 'completed')`),
    check("trips_source_check", sql`${table.source} in ('live', 'past_report')`),
    check(
      "trips_moderation_status_check",
      sql`${table.moderationStatus} in ('pending', 'approved', 'rejected')`,
    ),
    check("trips_angler_count_check", sql`${table.anglerCount} between 1 and 12`),
    check(
      "trips_contract_status_check",
      sql`${table.contractStatus} is null or ${table.contractStatus} in ('valid', 'legacy_unverified', 'rejected')`,
    ),
    check(
      "trips_outcome_class_check",
      sql`${table.outcomeClass} is null or ${table.outcomeClass} in ('target_encountered', 'non_target_only', 'no_fish')`,
    ),
    check(
      "trips_target_encounter_count_check",
      sql`${table.targetEncounterCount} is null or ${table.targetEncounterCount} >= 0`,
    ),
    check(
      "trips_any_fish_encounter_count_check",
      sql`${table.anyFishEncounterCount} is null or ${table.anyFishEncounterCount} >= 0`,
    ),
    check(
      "trips_target_identification_confidence_check",
      sql`${table.targetIdentificationConfidence} is null or ${table.targetIdentificationConfidence} in ('verified', 'self_reported', 'uncertain', 'unresolved', 'not_observed')`,
    ),
    check("trips_target_taxon_check", sql`${table.targetTaxonId} = 'california-halibut'`),
    check(
      "trips_species_contract_coherence_check",
      sql`(
        ${table.status} != 'completed' or ${table.contractStatus} is not null
      ) and (
        ${table.contractStatus} is not null or (
          ${table.observationContractVersion} is null
          and ${table.taxonCatalogVersion} is null
          and ${table.taxonObservationsJson} is null
          and ${table.outcomeClass} is null
          and ${table.targetEncounterCount} is null
          and ${table.anyFishEncounterCount} is null
          and ${table.targetIdentificationConfidence} is null
        )
      ) and (
        ${table.contractStatus} != 'legacy_unverified' or (
          ${table.observationContractVersion} is null
          and ${table.taxonCatalogVersion} is null
          and ${table.taxonObservationsJson} is null
          and ${table.outcomeClass} is null
          and ${table.targetEncounterCount} is null
          and ${table.anyFishEncounterCount} is null
          and ${table.targetIdentificationConfidence} is null
        )
      ) and (
        ${table.contractStatus} != 'valid' or (
          ${table.status} = 'completed'
          and ${table.observationContractVersion} = 'castingcompass.observation/2.0.0'
          and ${table.taxonCatalogVersion} = 'castingcompass.taxa/1.0.0'
          and ${table.targetTaxonId} = 'california-halibut'
          and typeof(${table.anglerCount}) = 'integer'
          and ${table.anglerCount} between 1 and 12
          and typeof(${table.anglerHours}) in ('integer', 'real')
          and ${table.anglerHours} > 0
          and ${table.anglerHours} <= 432
          and typeof(${table.keeperCount}) = 'integer'
          and typeof(${table.shortReleasedCount}) = 'integer'
          and typeof(${table.halibutEncounters}) = 'integer'
          and typeof(${table.noCatch}) = 'integer'
          and typeof(${table.otherCatchCount}) = 'integer'
          and typeof(${table.targetEncounterCount}) = 'integer'
          and typeof(${table.anyFishEncounterCount}) = 'integer'
          and ${table.keeperCount} between 0 and 25
          and ${table.shortReleasedCount} between 0 and 25
          and ${table.keeperCount} + ${table.shortReleasedCount} <= 40
          and ${table.otherCatchCount} between 0 and 100
          and ${table.noCatch} in (0, 1)
          and typeof(${table.mode}) = 'text'
          and ${table.mode} in ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
          and typeof(${table.startedAt}) = 'text'
          and typeof(${table.endedAt}) = 'text'
          and length(${table.startedAt}) = 24
          and length(${table.endedAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.startedAt}) = ${table.startedAt}
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.endedAt}) = ${table.endedAt}
          and julianday(${table.endedAt}) > julianday(${table.startedAt})
          and ${table.taxonObservationsJson} is not null
          and json_valid(${table.taxonObservationsJson}) = 1
          and ${table.outcomeClass} is not null
          and ${table.targetEncounterCount} is not null
          and ${table.anyFishEncounterCount} is not null
          and ${table.targetIdentificationConfidence} is not null
          and ${table.targetEncounterCount} = ${table.keeperCount} + ${table.shortReleasedCount}
          and ${table.halibutEncounters} = ${table.targetEncounterCount}
          and ${table.anyFishEncounterCount} = ${table.targetEncounterCount} + ${table.otherCatchCount}
          and ${table.targetEncounterCount} <= ${table.anyFishEncounterCount}
          and ${table.targetIdentificationConfidence} = case
            when ${table.targetEncounterCount} > 0 then 'self_reported'
            else 'not_observed'
          end
          and ${table.noCatch} = case when ${table.anyFishEncounterCount} = 0 then 1 else 0 end
          and ${table.outcomeClass} = case
            when ${table.targetEncounterCount} > 0 then 'target_encountered'
            when ${table.anyFishEncounterCount} > 0 then 'non_target_only'
            else 'no_fish'
          end
          and ${table.taxonObservationsJson} = case
            when ${table.otherCatchCount} > 0 then json_array(
              json_object(
                'taxon_id', 'california-halibut',
                'encounter_count', ${table.targetEncounterCount},
                'retained_count', ${table.keeperCount},
                'released_count', ${table.shortReleasedCount},
                'disposition_unknown_count', 0,
                'identification_confidence', ${table.targetIdentificationConfidence},
                'identification_basis', case when ${table.targetEncounterCount} > 0 then 'angler-report' else 'not-observed' end
              ),
              json_object(
                'taxon_id', 'unresolved-fish',
                'encounter_count', ${table.otherCatchCount},
                'retained_count', 0,
                'released_count', 0,
                'disposition_unknown_count', ${table.otherCatchCount},
                'identification_confidence', 'unresolved',
                'identification_basis', 'unresolved'
              )
            )
            else json_array(json_object(
              'taxon_id', 'california-halibut',
              'encounter_count', ${table.targetEncounterCount},
              'retained_count', ${table.keeperCount},
              'released_count', ${table.shortReleasedCount},
              'disposition_unknown_count', 0,
              'identification_confidence', ${table.targetIdentificationConfidence},
              'identification_basis', case when ${table.targetEncounterCount} > 0 then 'angler-report' else 'not-observed' end
            ))
          end
        )
      )`,
    ),
    index("trips_status_started_idx").on(table.status, table.startedAt),
    index("trips_site_started_idx").on(table.siteId, table.startedAt),
    index("trips_reporter_created_idx").on(table.reporterKeyHash, table.createdAt),
    index("trips_referral_created_idx").on(table.referralCode, table.createdAt),
    index("trips_user_completed_idx").on(table.userId, table.completedAt),
    index("trips_user_history_idx")
      .on(table.userId, sql`coalesce(${table.completedAt}, ${table.endedAt}, ${table.startedAt})`)
      .where(sql`${table.status} = 'completed' and ${table.userId} is not null`),
    index("trips_user_created_idx")
      .on(table.userId, table.createdAt)
      .where(sql`${table.userId} is not null`),
    index("trips_ai_review_backlog_idx")
      .on(table.status, sql`coalesce(${table.completedAt}, ${table.endedAt}, ${table.startedAt})`)
      .where(sql`${table.aiReviewStatus} is null or ${table.aiReviewStatus} = 'retry'`),
    index("trips_reporter_active_created_idx")
      .on(table.reporterKeyHash, table.createdAt)
      .where(sql`${table.status} = 'active'`),
    index("trips_contract_target_completed_idx").on(
      table.contractStatus,
      table.targetTaxonId,
      table.completedAt,
    ),
  ],
);

export const forecastImpressions = sqliteTable(
  "forecast_impressions",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    attestationIndexVersion: text("attestation_index_version").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    siteCatalogSha256: text("site_catalog_sha256").notNull(),
    targetTaxonId: text("target_taxon_id").notNull(),
    taxonCatalogVersion: text("taxon_catalog_version").notNull(),
    observationContractVersion: text("observation_contract_version").notNull(),
    modelRunContractVersion: text("model_run_contract_version").notNull(),
    opportunityContractVersion: text("opportunity_contract_version").notNull(),
    scoringSystemKind: text("scoring_system_kind").notNull(),
    scoringSystemVersion: text("scoring_system_version").notNull(),
    scoringSystemSha256: text("scoring_system_sha256").notNull(),
    windowId: text("window_id").notNull(),
    siteId: text("site_id").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    opportunityScore: real("opportunity_score").notNull(),
    habitatScore: real("habitat_score").notNull(),
    seasonalityScore: real("seasonality_score").notNull(),
    conditionsScore: real("conditions_score").notNull(),
    fishabilityScore: real("fishability_score").notNull(),
    attestedAt: text("attested_at").notNull(),
  },
  (table) => [
    uniqueIndex("forecast_impressions_trip_unique").on(table.tripId),
    uniqueIndex("forecast_impressions_id_trip_unique").on(table.id, table.tripId),
    index("forecast_impressions_window_idx").on(table.windowId, table.siteId, table.windowStart),
    check(
      "forecast_impressions_hashes_check",
      sql`length(${table.snapshotSha256}) = 64 and ${table.snapshotSha256} not glob '*[^a-f0-9]*'
        and length(${table.siteCatalogSha256}) = 64 and ${table.siteCatalogSha256} not glob '*[^a-f0-9]*'
        and length(${table.scoringSystemSha256}) = 64 and ${table.scoringSystemSha256} not glob '*[^a-f0-9]*'`,
    ),
    check(
      "forecast_impressions_identity_check",
      sql`${table.attestationIndexVersion} = 'castingcompass.opportunity-attestation-index/1.0.0'
        and ${table.targetTaxonId} = 'california-halibut'
        and ${table.taxonCatalogVersion} = 'castingcompass.taxa/1.0.0'
        and ${table.observationContractVersion} = 'castingcompass.observation/2.0.0'
        and ${table.modelRunContractVersion} = 'castingcompass.model-run/2.0.0'
        and ${table.opportunityContractVersion} = 'castingcompass.opportunity/2.0.0'
        and ${table.scoringSystemKind} = 'heuristic-configuration'
        and ${table.scoringSystemVersion} = 'heuristic-' || ${table.targetTaxonId} || '-' || ${table.scoringSystemSha256}`,
    ),
    check(
      "forecast_impressions_scores_check",
      sql`${table.opportunityScore} between 0 and 100
        and ${table.habitatScore} between 0 and 100
        and ${table.seasonalityScore} between 0 and 100
        and ${table.conditionsScore} between 0 and 100
        and ${table.fishabilityScore} between 0 and 100`,
    ),
    check(
      "forecast_impressions_window_check",
      sql`length(${table.windowStart}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.windowStart}) = ${table.windowStart}
        and length(${table.windowEnd}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.windowEnd}) = ${table.windowEnd}
        and length(${table.attestedAt}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.attestedAt}) = ${table.attestedAt}
        and julianday(${table.windowEnd}) > julianday(${table.windowStart})
        and abs((julianday(${table.windowEnd}) - julianday(${table.windowStart})) * 24.0 - 2.0) < 0.000001`,
    ),
  ],
);

export const tripValidationProvenance = sqliteTable(
  "trip_validation_provenance",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    collectionContractVersion: text("collection_contract_version").notNull(),
    validationProtocolId: text("validation_protocol_id"),
    activationManifestSha256: text("activation_manifest_sha256"),
    activatedAt: text("activated_at"),
    activationScoringSystemSha256: text("activation_scoring_system_sha256"),
    cohortId: text("cohort_id").notNull(),
    sourceRole: text("source_role").notNull(),
    participantGroupId: text("participant_group_id"),
    recruitmentFrameId: text("recruitment_frame_id"),
    recruitmentSourceId: text("recruitment_source_id").notNull(),
    recruitmentEventContractVersion: text("recruitment_event_contract_version"),
    recruitmentEventAt: text("recruitment_event_at"),
    recruitmentEventSha256: text("recruitment_event_sha256"),
    communityApprovalSha256: text("community_approval_sha256"),
    assignmentId: text("assignment_id"),
    sourceRecordSha256: text("source_record_sha256"),
    effortSegmentId: text("effort_segment_id"),
    effortUnit: text("effort_unit"),
    attemptCount: integer("attempt_count"),
    targetTaxonId: text("target_taxon_id"),
    segmentStartAt: text("segment_start_at"),
    segmentEndAt: text("segment_end_at"),
    modeAtCompletion: text("mode_at_completion"),
    anglerCount: integer("angler_count"),
    durationMilliseconds: integer("duration_milliseconds"),
    personMilliseconds: integer("person_milliseconds"),
    completionEventContractVersion: text("completion_event_contract_version"),
    completionEventAt: text("completion_event_at"),
    completionConsentVersion: text("completion_consent_version"),
    completionConsentedAt: text("completion_consented_at"),
    completionPrimaryTargetConfirmed: integer("completion_primary_target_confirmed", { mode: "boolean" }),
    completionCompleteAttemptConfirmed: integer("completion_complete_attempt_confirmed", { mode: "boolean" }),
    completionEventSha256: text("completion_event_sha256"),
    incentivePolicyId: text("incentive_policy_id").notNull(),
    selectionMethod: text("selection_method").notNull(),
    targetIntent: text("target_intent").notNull(),
    primaryTargetConfirmed: integer("primary_target_confirmed", { mode: "boolean" }),
    completeAttemptConfirmed: integer("complete_attempt_confirmed", { mode: "boolean" }),
    modeAtEnrollment: text("mode_at_enrollment"),
    consentVersion: text("consent_version"),
    consentedAt: text("consented_at"),
    scoreInfluencedChoice: integer("score_influenced_choice", { mode: "boolean" }),
    attestationStatus: text("attestation_status").notNull(),
    forecastImpressionId: text("forecast_impression_id"),
    completionAttestedAt: text("completion_attested_at"),
    evidenceStatus: text("evidence_status").notNull(),
    exclusionReason: text("exclusion_reason"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.forecastImpressionId, table.tripId],
      foreignColumns: [forecastImpressions.id, forecastImpressions.tripId],
      name: "trip_validation_forecast_impression_trip_fk",
    }).onDelete("cascade"),
    index("trip_validation_provenance_trip_created_idx").on(table.tripId, table.createdAt),
    index("trip_validation_provenance_forecast_trip_idx")
      .on(table.forecastImpressionId, table.tripId)
      .where(sql`${table.forecastImpressionId} is not null`),
    index("trip_validation_provenance_cohort_role_idx").on(
      table.collectionContractVersion,
      table.validationProtocolId,
      table.cohortId,
      table.sourceRole,
      table.evidenceStatus,
    ),
    index("trip_validation_provenance_participant_recruitment_idx").on(
      table.participantGroupId,
      table.recruitmentEventAt,
    ),
    check(
      "trip_validation_event_type_check",
      sql`${table.eventType} in ('enrollment', 'completion', 'retrospective_submission', 'evidence_exclusion', 'legacy_context')`,
    ),
    check("trip_validation_source_role_check", sql`${table.sourceRole} in ('context_only', 'prospective_secondary')`),
    check(
      "trip_validation_selection_method_check",
      sql`${table.selectionMethod} in ('organic_score_visible', 'organic_unverified', 'retrospective_self_report', 'legacy_unknown')`,
    ),
    check(
      "trip_validation_target_intent_check",
      sql`${table.targetIntent} in ('california-halibut-primary-full-trip', 'legacy_unknown')`,
    ),
    check(
      "trip_validation_mode_check",
      sql`${table.modeAtEnrollment} is null or ${table.modeAtEnrollment} in ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')`,
    ),
    check(
      "trip_validation_attestation_check",
      sql`${table.attestationStatus} in ('verified', 'unverified_missing', 'unverified_mismatch', 'unverified_asset', 'not_applicable_retrospective', 'invalidated_after_edit', 'legacy_unverified')`,
    ),
    check(
      "trip_validation_evidence_status_check",
      sql`${table.evidenceStatus} in ('context_only', 'secondary_pending_review')`,
    ),
    check(
      "trip_validation_target_complete_check",
      sql`(${table.primaryTargetConfirmed} is null or ${table.primaryTargetConfirmed} in (0, 1))
        and (${table.completeAttemptConfirmed} is null or ${table.completeAttemptConfirmed} in (0, 1))`,
    ),
    check(
      "trip_validation_score_influence_check",
      sql`${table.scoreInfluencedChoice} is null or ${table.scoreInfluencedChoice} in (0, 1)`,
    ),
    check(
      "trip_validation_verified_impression_check",
      sql`(${table.attestationStatus} = 'verified' and ${table.forecastImpressionId} is not null)
        or (${table.attestationStatus} != 'verified' and ${table.forecastImpressionId} is null)`,
    ),
    check(
      "trip_validation_activation_check",
      sql`(${table.validationProtocolId} is null
          and ${table.activationManifestSha256} is null
          and ${table.activatedAt} is null
          and ${table.activationScoringSystemSha256} is null)
        or (${table.validationProtocolId} = 'california-halibut-site-window-v1'
          and length(${table.activationManifestSha256}) = 64
          and ${table.activationManifestSha256} not glob '*[^a-f0-9]*'
          and length(${table.activatedAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.activatedAt}) = ${table.activatedAt}
          and length(${table.activationScoringSystemSha256}) = 64
          and ${table.activationScoringSystemSha256} not glob '*[^a-f0-9]*'
          and ${table.activatedAt} < '2026-08-01T00:00:00.000Z'
          and julianday(${table.activatedAt}) < julianday(${table.createdAt}))`,
    ),
    check(
      "trip_validation_collection_time_check",
      sql`${table.collectionContractVersion} = 'castingcompass.validation-collection/1.0.0'
        and length(${table.createdAt}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.createdAt}) = ${table.createdAt}
        and (${table.consentedAt} is null or (length(${table.consentedAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.consentedAt}) = ${table.consentedAt}))
        and (${table.completionAttestedAt} is null or (length(${table.completionAttestedAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.completionAttestedAt}) = ${table.completionAttestedAt}))`,
    ),
    check(
      "trip_validation_recruitment_event_check",
      sql`(${table.participantGroupId} is null
          and ${table.recruitmentFrameId} is null
          and ${table.recruitmentEventContractVersion} is null
          and ${table.recruitmentEventAt} is null
          and ${table.recruitmentEventSha256} is null
          and ${table.communityApprovalSha256} is null)
        or (length(${table.participantGroupId}) = 76
          and substr(${table.participantGroupId}, 1, 12) = 'participant-'
          and substr(${table.participantGroupId}, 13) not glob '*[^a-f0-9]*'
          and ${table.recruitmentFrameId} = 'california-halibut-site-window-recruitment-v1'
          and ${table.recruitmentSourceId} in ('castingcompass-organic-product', 'direct-opt-in-research-invite', 'admin-approved-community-prospective')
          and ${table.recruitmentEventContractVersion} = 'castingcompass.recruitment-event/1.0.0'
          and length(${table.recruitmentEventAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.recruitmentEventAt}) = ${table.recruitmentEventAt}
          and julianday(${table.recruitmentEventAt}) <= julianday(${table.createdAt})
          and length(${table.recruitmentEventSha256}) = 64
          and ${table.recruitmentEventSha256} not glob '*[^a-f0-9]*'
          and ((${table.recruitmentSourceId} = 'admin-approved-community-prospective'
              and length(${table.communityApprovalSha256}) = 64
              and ${table.communityApprovalSha256} not glob '*[^a-f0-9]*')
            or (${table.recruitmentSourceId} != 'admin-approved-community-prospective'
              and ${table.communityApprovalSha256} is null)))`,
    ),
    check(
      "trip_validation_collection_identity_check",
      sql`(${table.assignmentId} is null
          and ${table.sourceRecordSha256} is null
          and ${table.effortSegmentId} is null
          and ${table.effortUnit} is null
          and ${table.attemptCount} is null
          and ${table.targetTaxonId} is null
          and ${table.segmentStartAt} is null)
        or (length(${table.assignmentId}) = 75
          and substr(${table.assignmentId}, 1, 11) = 'assignment-'
          and substr(${table.assignmentId}, 12) not glob '*[^a-f0-9]*'
          and length(${table.sourceRecordSha256}) = 64
          and ${table.sourceRecordSha256} not glob '*[^a-f0-9]*'
          and length(${table.effortSegmentId}) = 71
          and substr(${table.effortSegmentId}, 1, 7) = 'effort-'
          and substr(${table.effortSegmentId}, 8) not glob '*[^a-f0-9]*'
          and ${table.effortUnit} = 'whole-trip-group-attempt'
          and ${table.attemptCount} = 1
          and ${table.targetTaxonId} = 'california-halibut'
          and length(${table.segmentStartAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.segmentStartAt}) = ${table.segmentStartAt})`,
    ),
    check(
      "trip_validation_completion_event_check",
      sql`(${table.segmentEndAt} is null
          and ${table.modeAtCompletion} is null
          and ${table.anglerCount} is null
          and ${table.durationMilliseconds} is null
          and ${table.personMilliseconds} is null
          and ${table.completionEventContractVersion} is null
          and ${table.completionEventAt} is null
          and ${table.completionConsentVersion} is null
          and ${table.completionConsentedAt} is null
          and ${table.completionPrimaryTargetConfirmed} is null
          and ${table.completionCompleteAttemptConfirmed} is null
          and ${table.completionEventSha256} is null)
        or (${table.assignmentId} is not null
          and length(${table.segmentEndAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.segmentEndAt}) = ${table.segmentEndAt}
          and julianday(${table.segmentEndAt}) > julianday(${table.segmentStartAt})
          and ${table.modeAtCompletion} in ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
          and ${table.anglerCount} between 1 and 12
          and ${table.durationMilliseconds} between 60000 and 129600000
          and cast(round((julianday(${table.segmentEndAt}) - julianday(${table.segmentStartAt})) * 86400000.0) as integer) = ${table.durationMilliseconds}
          and ${table.personMilliseconds} = ${table.durationMilliseconds} * ${table.anglerCount}
          and ${table.completionEventContractVersion} = 'castingcompass.validation-completion-event/1.0.0'
          and length(${table.completionEventAt}) = 24
          and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.completionEventAt}) = ${table.completionEventAt}
          and julianday(${table.completionEventAt}) >= julianday(${table.segmentEndAt})
          and ${table.completionConsentVersion} = 'castingcompass.trip-validation-consent/1.0.0'
          and ${table.completionConsentedAt} = ${table.completionEventAt}
          and ${table.completionPrimaryTargetConfirmed} = 1
          and ${table.completionCompleteAttemptConfirmed} = 1
          and length(${table.completionEventSha256}) = 64
          and ${table.completionEventSha256} not glob '*[^a-f0-9]*'
          and ${table.completionEventAt} = ${table.completionAttestedAt}
          and ${table.completionConsentVersion} = ${table.consentVersion}
          and ${table.completionConsentedAt} = ${table.consentedAt}
          and ${table.completionPrimaryTargetConfirmed} = ${table.primaryTargetConfirmed}
          and ${table.completionCompleteAttemptConfirmed} = ${table.completeAttemptConfirmed})`,
    ),
    check(
      "trip_validation_role_check",
      sql`(${table.sourceRole} = 'prospective_secondary'
          and ${table.validationProtocolId} is not null
          and ${table.participantGroupId} is not null
          and ${table.recruitmentFrameId} = 'california-halibut-site-window-recruitment-v1'
          and ${table.recruitmentEventContractVersion} = 'castingcompass.recruitment-event/1.0.0'
          and ${table.recruitmentEventSha256} is not null
          and ${table.assignmentId} is not null
          and ${table.sourceRecordSha256} is not null
          and ${table.effortSegmentId} is not null
          and ${table.effortUnit} = 'whole-trip-group-attempt'
          and ${table.attemptCount} = 1
          and ${table.targetTaxonId} = 'california-halibut'
          and ${table.segmentStartAt} is not null
          and ${table.cohortId} = 'california-halibut-site-window-observational-secondary-v1'
          and ${table.incentivePolicyId} = 'none-v1'
          and ${table.selectionMethod} = 'organic_score_visible'
          and ${table.targetIntent} = 'california-halibut-primary-full-trip'
          and ${table.primaryTargetConfirmed} = 1
          and ${table.scoreInfluencedChoice} is not null
          and ${table.modeAtEnrollment} in ('shore', 'beach', 'pier', 'jetty')
          and ${table.attestationStatus} = 'verified'
          and ${table.evidenceStatus} = 'secondary_pending_review')
        or (${table.sourceRole} = 'context_only' and ${table.evidenceStatus} = 'context_only')`,
    ),
    check(
      "trip_validation_context_enrollment_recruitment_check",
      sql`${table.eventType} != 'enrollment' or ${table.sourceRole} != 'context_only' or ${table.participantGroupId} is null`,
    ),
    check(
      "trip_validation_enrollment_completion_fields_check",
      sql`${table.eventType} != 'enrollment' or ${table.segmentEndAt} is null`,
    ),
    check(
      "trip_validation_completion_identity_check",
      sql`${table.eventType} != 'completion' or ${table.assignmentId} is null or ${table.completionEventSha256} is not null`,
    ),
    check(
      "trip_validation_event_coherence_check",
      sql`(${table.eventType} = 'enrollment'
          and ${table.primaryTargetConfirmed} = 1
          and ${table.completeAttemptConfirmed} is null
          and ${table.consentVersion} = 'castingcompass.trip-validation-consent/1.0.0'
          and ${table.consentedAt} is not null
          and ${table.completionAttestedAt} is null)
        or (${table.eventType} = 'completion'
          and ${table.primaryTargetConfirmed} = 1
          and ${table.completeAttemptConfirmed} = 1
          and ${table.consentVersion} = 'castingcompass.trip-validation-consent/1.0.0'
          and ${table.consentedAt} = ${table.createdAt}
          and ${table.completionAttestedAt} = ${table.createdAt})
        or (${table.eventType} = 'retrospective_submission'
          and ${table.validationProtocolId} is null
          and ${table.sourceRole} = 'context_only'
          and ${table.selectionMethod} = 'retrospective_self_report'
          and ${table.primaryTargetConfirmed} = 1
          and ${table.completeAttemptConfirmed} = 1
          and ${table.attestationStatus} = 'not_applicable_retrospective'
          and ${table.consentedAt} = ${table.createdAt}
          and ${table.completionAttestedAt} = ${table.createdAt})
        or (${table.eventType} = 'evidence_exclusion'
          and ${table.validationProtocolId} is null
          and ${table.activationManifestSha256} is null
          and ${table.activatedAt} is null
          and ${table.activationScoringSystemSha256} is null
          and ${table.sourceRole} = 'context_only'
          and ${table.participantGroupId} is null
          and ${table.recruitmentFrameId} is null
          and ${table.recruitmentEventContractVersion} is null
          and ${table.recruitmentEventAt} is null
          and ${table.recruitmentEventSha256} is null
          and ${table.communityApprovalSha256} is null
          and ${table.assignmentId} is null
          and ${table.sourceRecordSha256} is null
          and ${table.effortSegmentId} is null
          and ${table.effortUnit} is null
          and ${table.attemptCount} is null
          and ${table.targetTaxonId} is null
          and ${table.segmentStartAt} is null
          and ${table.segmentEndAt} is null
          and ${table.modeAtCompletion} is null
          and ${table.anglerCount} is null
          and ${table.durationMilliseconds} is null
          and ${table.personMilliseconds} is null
          and ${table.completionEventContractVersion} is null
          and ${table.completionEventAt} is null
          and ${table.completionConsentVersion} is null
          and ${table.completionConsentedAt} is null
          and ${table.completionPrimaryTargetConfirmed} is null
          and ${table.completionCompleteAttemptConfirmed} is null
          and ${table.completionEventSha256} is null
          and ${table.attestationStatus} = 'invalidated_after_edit'
          and ${table.forecastImpressionId} is null
          and ${table.completionAttestedAt} is null
          and ${table.evidenceStatus} = 'context_only'
          and ${table.exclusionReason} in ('post_completion_profile_edit', 'trusted_review_exclusion'))
        or (${table.eventType} = 'legacy_context'
          and ${table.sourceRole} = 'context_only'
          and ${table.evidenceStatus} = 'context_only')`,
    ),
  ],
);

export const validationFeasibilityActivations = sqliteTable(
  "validation_feasibility_activations",
  {
    id: text("id").primaryKey(),
    protocolId: text("protocol_id").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    protocolSha256: text("protocol_sha256").notNull(),
    activationCommitmentSha256: text("activation_commitment_sha256").notNull(),
    activationManifestSha256: text("activation_manifest_sha256").notNull(),
    siteCatalogSha256: text("site_catalog_sha256").notNull(),
    scoringSystemKind: text("scoring_system_kind").notNull(),
    scoringSystemVersion: text("scoring_system_version").notNull(),
    scoringSystemSha256: text("scoring_system_sha256").notNull(),
    workerVersionId: text("worker_version_id").notNull(),
    studyConsentVersion: text("study_consent_version").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    preregisteredAt: text("preregistered_at").notNull(),
    receiptVerifiedAt: text("receipt_verified_at").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("validation_feasibility_activation_commitment_unique").on(table.activationCommitmentSha256),
    uniqueIndex("validation_feasibility_activation_manifest_unique").on(table.activationManifestSha256),
    check(
      "validation_feasibility_activation_protocol_check",
      sql`${table.protocolId} = 'california-halibut-collection-feasibility-v2'
        and ${table.protocolVersion} = '2.0.0'
        and ${table.protocolSha256} = '8ff0d7bd009ed8eb10f328347d58d0b63d0b6c822b08351cc5c2760d41de13ed'
        and ${table.siteCatalogSha256} = 'b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860'`,
    ),
    check(
      "validation_feasibility_activation_status_check",
      sql`${table.status} = 'sealed-before-enrollment'`,
    ),
    check(
      "validation_feasibility_activation_time_check",
      sql`julianday(${table.endAt}) > julianday(${table.startAt})
        and julianday(${table.endAt}) - julianday(${table.startAt}) between 90 and 365
        and julianday(${table.createdAt}) <= julianday(${table.preregisteredAt})
        and julianday(${table.preregisteredAt}) <= julianday(${table.receiptVerifiedAt})
        and julianday(${table.receiptVerifiedAt}) < julianday(${table.startAt})`,
    ),
  ],
);

export const validationFeasibilityEvents = sqliteTable(
  "validation_feasibility_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    eventContractVersion: text("event_contract_version").notNull(),
    sourceRecordSha256: text("source_record_sha256").notNull(),
    participantGroupId: text("participant_group_id").notNull(),
    recruitmentFrameId: text("recruitment_frame_id").notNull(),
    recruitmentSourceId: text("recruitment_source_id").notNull(),
    selectionMethod: text("selection_method").notNull(),
    scoreInfluencedChoice: integer("score_influenced_choice", { mode: "boolean" }).notNull(),
    studyConsentVersion: text("study_consent_version").notNull(),
    studyConsentedAt: text("study_consented_at").notNull(),
    targetTaxonId: text("target_taxon_id").notNull(),
    siteId: text("site_id").notNull(),
    geographicPanel: text("geographic_panel").notNull(),
    mode: text("mode").notNull(),
    segmentStartAt: text("segment_start_at").notNull(),
    segmentEndAt: text("segment_end_at"),
    anglerCount: integer("angler_count").notNull(),
    effortMinutes: real("effort_minutes"),
    targetEncountered: integer("target_encountered", { mode: "boolean" }),
    targetEncounterCount: integer("target_encounter_count"),
    targetRetainedCount: integer("target_retained_count"),
    targetReleasedCount: integer("target_released_count"),
    identificationConfidence: text("identification_confidence"),
    scoringSystemKind: text("scoring_system_kind").notNull(),
    scoringSystemVersion: text("scoring_system_version").notNull(),
    scoringSystemSha256: text("scoring_system_sha256").notNull(),
    opportunityScore: integer("opportunity_score").notNull(),
    opportunityWindowId: text("opportunity_window_id").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    snapshotSuppressionSha256: text("snapshot_suppression_sha256").notNull(),
    terminalReason: text("terminal_reason"),
    previousEventSha256: text("previous_event_sha256"),
    eventAt: text("event_at").notNull(),
    eventSha256: text("event_sha256").notNull(),
  },
  (table) => [
    uniqueIndex("validation_feasibility_event_id_unique").on(table.eventId),
    uniqueIndex("validation_feasibility_event_hash_unique").on(table.eventSha256),
    uniqueIndex("validation_feasibility_trip_event_unique").on(table.tripId, table.eventType),
    index("validation_feasibility_activation_sequence_idx").on(table.activationId, table.sequence),
    index("validation_feasibility_participant_event_idx").on(table.participantGroupId, table.eventAt),
    check(
      "validation_feasibility_event_type_check",
      sql`${table.eventType} in ('started', 'completed', 'safe_canceled')`,
    ),
    check(
      "validation_feasibility_event_population_check",
      sql`${table.targetTaxonId} = 'california-halibut'
        and ${table.mode} in ('shore', 'beach', 'pier', 'jetty')
        and ${table.geographicPanel} in ('north-coast', 'golden-gate-sf-coast', 'north-east-bay', 'central-south-bay', 'san-mateo-coast')
        and ${table.anglerCount} between 1 and 12`,
    ),
  ],
);

export const validationFeasibilityPrivacyRemovals = sqliteTable(
  "validation_feasibility_privacy_removals",
  {
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    removalDay: text("removal_day").notNull(),
    removedEventCount: integer("removed_event_count").notNull().default(0),
    removedStartedAttemptCount: integer("removed_started_attempt_count").notNull().default(0),
    removedCompletedAttemptCount: integer("removed_completed_attempt_count").notNull().default(0),
    removedSafeCanceledAttemptCount: integer("removed_safe_canceled_attempt_count").notNull().default(0),
    firstRemovedAt: text("first_removed_at").notNull(),
    lastRemovedAt: text("last_removed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activationId, table.removalDay] }),
    check(
      "validation_feasibility_privacy_removal_counts_check",
      sql`${table.removedEventCount} = ${table.removedStartedAttemptCount} + ${table.removedCompletedAttemptCount} + ${table.removedSafeCanceledAttemptCount}`,
    ),
  ],
);

export const validationFeasibilityRecruitmentCampaigns = sqliteTable(
  "validation_feasibility_recruitment_campaigns",
  {
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    campaignId: text("campaign_id").notNull(),
    recruitmentSourceId: text("recruitment_source_id").notNull(),
    selectionMethod: text("selection_method").notNull(),
    inviteIssuedAt: text("invite_issued_at").notNull(),
    inviteExpiresAt: text("invite_expires_at").notNull(),
    communityApprovalSha256: text("community_approval_sha256"),
    tokenPayloadSha256: text("token_payload_sha256").notNull(),
    sealedAt: text("sealed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activationId, table.campaignId] }),
    uniqueIndex("validation_feasibility_campaign_payload_unique")
      .on(table.activationId, table.tokenPayloadSha256),
    check(
      "validation_feasibility_campaign_identity_check",
      sql`${table.campaignId} glob 'campaign-[a-z0-9]*'
        and length(${table.campaignId}) between 12 and 88
        and ${table.selectionMethod} = 'direct_precommitment'
        and length(${table.tokenPayloadSha256}) = 64
        and ${table.tokenPayloadSha256} not glob '*[^a-f0-9]*'`,
    ),
    check(
      "validation_feasibility_campaign_source_check",
      sql`(${table.recruitmentSourceId} = 'direct-opt-in-research-invite'
          and ${table.communityApprovalSha256} is null)
        or (${table.recruitmentSourceId} = 'admin-approved-community-prospective'
          and length(${table.communityApprovalSha256}) = 64
          and ${table.communityApprovalSha256} not glob '*[^a-f0-9]*')`,
    ),
    check(
      "validation_feasibility_campaign_time_check",
      sql`length(${table.inviteIssuedAt}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.inviteIssuedAt}) = ${table.inviteIssuedAt}
        and length(${table.inviteExpiresAt}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.inviteExpiresAt}) = ${table.inviteExpiresAt}
        and length(${table.sealedAt}) = 24
        and strftime('%Y-%m-%dT%H:%M:%fZ', ${table.sealedAt}) = ${table.sealedAt}
        and julianday(${table.inviteIssuedAt}) <= julianday(${table.sealedAt})
        and julianday(${table.inviteExpiresAt}) > julianday(${table.sealedAt})`,
    ),
  ],
);

export const validationFeasibilityRecruitmentEvents = sqliteTable(
  "validation_feasibility_recruitment_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    participantGroupId: text("participant_group_id").notNull(),
    eventContractVersion: text("event_contract_version").notNull(),
    recruitmentFrameId: text("recruitment_frame_id").notNull(),
    recruitmentSourceId: text("recruitment_source_id").notNull(),
    selectionMethod: text("selection_method").notNull(),
    recruitedAt: text("recruited_at").notNull(),
    campaignId: text("campaign_id"),
    inviteIssuedAt: text("invite_issued_at"),
    inviteExpiresAt: text("invite_expires_at"),
    communityApprovalSha256: text("community_approval_sha256"),
    snapshotSuppressionSha256: text("snapshot_suppression_sha256").notNull(),
    eventSha256: text("event_sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("validation_feasibility_recruitment_event_id_unique").on(table.eventId),
    uniqueIndex("validation_feasibility_recruitment_event_hash_unique").on(table.eventSha256),
    uniqueIndex("validation_feasibility_recruitment_participant_unique")
      .on(table.activationId, table.participantGroupId),
    uniqueIndex("validation_feasibility_recruitment_user_unique").on(table.activationId, table.userId),
    index("validation_feasibility_recruitment_user_sequence_idx").on(table.userId, table.sequence),
    check(
      "validation_feasibility_recruitment_contract_check",
      sql`${table.eventContractVersion} = 'castingcompass.validation-feasibility-recruitment/2.0.0'
        and ${table.recruitmentFrameId} = 'california-halibut-feasibility-recruitment-v2'`,
    ),
    check(
      "validation_feasibility_recruitment_source_check",
      sql`${table.recruitmentSourceId} in ('castingcompass-organic-product', 'direct-opt-in-research-invite', 'admin-approved-community-prospective')
        and ${table.selectionMethod} in ('organic_score_visible', 'direct_precommitment')`,
    ),
  ],
);

export const validationFeasibilityRecruitmentRemovals = sqliteTable(
  "validation_feasibility_recruitment_removals",
  {
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    removalDay: text("removal_day").notNull(),
    removedRecruitmentCount: integer("removed_recruitment_count").notNull().default(0),
    removedOrganicCount: integer("removed_organic_count").notNull().default(0),
    removedDirectCount: integer("removed_direct_count").notNull().default(0),
    removedCommunityCount: integer("removed_community_count").notNull().default(0),
    firstRemovedAt: text("first_removed_at").notNull(),
    lastRemovedAt: text("last_removed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.activationId, table.removalDay] }),
    check(
      "validation_feasibility_recruitment_removal_counts_check",
      sql`${table.removedRecruitmentCount} = ${table.removedOrganicCount} + ${table.removedDirectCount} + ${table.removedCommunityCount}`,
    ),
  ],
);

export const validationFeasibilityCorrections = sqliteTable(
  "validation_feasibility_corrections",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    correctionId: text("correction_id").notNull(),
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    correctionContractVersion: text("correction_contract_version").notNull(),
    rootCompletionEventSha256: text("root_completion_event_sha256").notNull(),
    previousEventSha256: text("previous_event_sha256").notNull(),
    correctionReason: text("correction_reason").notNull(),
    analyticalStatus: text("analytical_status").notNull(),
    siteId: text("site_id").notNull(),
    geographicPanel: text("geographic_panel").notNull(),
    mode: text("mode").notNull(),
    segmentStartAt: text("segment_start_at").notNull(),
    segmentEndAt: text("segment_end_at").notNull(),
    anglerCount: integer("angler_count").notNull(),
    effortMinutes: real("effort_minutes").notNull(),
    targetEncountered: integer("target_encountered", { mode: "boolean" }).notNull(),
    targetEncounterCount: integer("target_encounter_count").notNull(),
    targetRetainedCount: integer("target_retained_count").notNull(),
    targetReleasedCount: integer("target_released_count").notNull(),
    identificationConfidence: text("identification_confidence").notNull(),
    correctedAt: text("corrected_at").notNull(),
    eventSha256: text("event_sha256").notNull(),
  },
  (table) => [
    uniqueIndex("validation_feasibility_correction_id_unique").on(table.correctionId),
    uniqueIndex("validation_feasibility_correction_hash_unique").on(table.eventSha256),
    index("validation_feasibility_correction_trip_sequence_idx").on(table.tripId, table.sequence),
    index("validation_feasibility_correction_activation_sequence_idx").on(table.activationId, table.sequence),
    check(
      "validation_feasibility_correction_contract_check",
      sql`${table.correctionContractVersion} = 'castingcompass.validation-feasibility-correction/2.0.0'
        and ${table.correctionReason} = 'participant_profile_edit'
        and ${table.analyticalStatus} in ('eligible_corrected_completion', 'excluded_after_identity_correction')`,
    ),
  ],
);

export const validationFeasibilityCorrectionRemovals = sqliteTable(
  "validation_feasibility_correction_removals",
  {
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    removalDay: text("removal_day").notNull(),
    removedCorrectionCount: integer("removed_correction_count").notNull().default(0),
    firstRemovedAt: text("first_removed_at").notNull(),
    lastRemovedAt: text("last_removed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.activationId, table.removalDay] })],
);

export const validationFeasibilitySnapshotSuppressions = sqliteTable(
  "validation_feasibility_snapshot_suppressions",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    suppressionId: text("suppression_id").notNull(),
    activationId: text("activation_id").notNull().references(() => validationFeasibilityActivations.id, { onDelete: "restrict" }),
    suppressionKind: text("suppression_kind").notNull(),
    suppressionSubjectSha256: text("suppression_subject_sha256").notNull(),
    suppressedEventType: text("suppressed_event_type").notNull(),
    sourceEventSha256: text("source_event_sha256").notNull(),
    removedAt: text("removed_at").notNull(),
  },
  (table) => [
    uniqueIndex("validation_feasibility_snapshot_suppression_id_unique").on(table.suppressionId),
    uniqueIndex("validation_feasibility_snapshot_suppression_subject_event_unique").on(
      table.activationId,
      table.suppressionKind,
      table.suppressionSubjectSha256,
      table.suppressedEventType,
    ),
    uniqueIndex("validation_feasibility_snapshot_suppression_source_event_unique").on(
      table.activationId,
      table.suppressionKind,
      table.suppressedEventType,
      table.sourceEventSha256,
    ),
    check(
      "validation_feasibility_snapshot_suppression_identity_check",
      sql`${table.suppressionId} glob 'fsuppress_*'
        and length(${table.suppressionId}) = 42
        and substr(${table.suppressionId}, 11) not glob '*[^a-f0-9]*'
        and length(${table.suppressionSubjectSha256}) = 64
        and ${table.suppressionSubjectSha256} not glob '*[^a-f0-9]*'
        and length(${table.sourceEventSha256}) = 64
        and ${table.sourceEventSha256} not glob '*[^a-f0-9]*'`,
    ),
    check(
      "validation_feasibility_snapshot_suppression_kind_check",
      sql`(${table.suppressionKind} = 'participant' and ${table.suppressedEventType} = 'participant')
        or (${table.suppressionKind} = 'trip'
          and ${table.suppressedEventType} in ('started', 'completed', 'safe_canceled'))`,
    ),
  ],
);

export const siteDiscussionPosts = sqliteTable(
  "site_discussion_posts",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    siteId: text("site_id").notNull(),
    summary: text("summary").notNull(),
    gearSummary: text("gear_summary"),
    techniqueTagsJson: text("technique_tags_json"),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    reviewModel: text("review_model"),
    approvedAt: text("approved_at"),
    approvedBy: text("approved_by"),
    sourceAiReviewedAt: text("source_ai_reviewed_at"),
  },
  (table) => [
    uniqueIndex("site_discussion_posts_trip_unique").on(table.tripId),
    index("site_discussion_posts_site_time_idx").on(table.siteId, table.observedAt),
  ],
);
