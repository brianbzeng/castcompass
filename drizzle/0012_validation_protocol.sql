CREATE TABLE IF NOT EXISTS `forecast_impressions` (
  `id` text PRIMARY KEY NOT NULL,
  `trip_id` text NOT NULL,
  `attestation_index_version` text NOT NULL,
  `snapshot_sha256` text NOT NULL,
  `site_catalog_sha256` text NOT NULL,
  `target_taxon_id` text NOT NULL,
  `taxon_catalog_version` text NOT NULL,
  `observation_contract_version` text NOT NULL,
  `model_run_contract_version` text NOT NULL,
  `opportunity_contract_version` text NOT NULL,
  `scoring_system_kind` text NOT NULL,
  `scoring_system_version` text NOT NULL,
  `scoring_system_sha256` text NOT NULL,
  `window_id` text NOT NULL,
  `site_id` text NOT NULL,
  `window_start` text NOT NULL,
  `window_end` text NOT NULL,
  `opportunity_score` real NOT NULL,
  `habitat_score` real NOT NULL,
  `seasonality_score` real NOT NULL,
  `conditions_score` real NOT NULL,
  `fishability_score` real NOT NULL,
  `attested_at` text NOT NULL,
  FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON DELETE cascade,
  CONSTRAINT `forecast_impressions_trip_unique` UNIQUE (`trip_id`),
  CONSTRAINT `forecast_impressions_id_trip_unique` UNIQUE (`id`, `trip_id`),
  CONSTRAINT `forecast_impressions_hashes_check` CHECK (
    length(`snapshot_sha256`) = 64 AND `snapshot_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`site_catalog_sha256`) = 64 AND `site_catalog_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`scoring_system_sha256`) = 64 AND `scoring_system_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `forecast_impressions_identity_check` CHECK (
    `attestation_index_version` = 'castingcompass.opportunity-attestation-index/1.0.0'
    AND `target_taxon_id` = 'california-halibut'
    AND `taxon_catalog_version` = 'castingcompass.taxa/1.0.0'
    AND `observation_contract_version` = 'castingcompass.observation/2.0.0'
    AND `model_run_contract_version` = 'castingcompass.model-run/2.0.0'
    AND `opportunity_contract_version` = 'castingcompass.opportunity/2.0.0'
    AND `scoring_system_kind` = 'heuristic-configuration'
    AND `scoring_system_version` = 'heuristic-' || `target_taxon_id` || '-' || `scoring_system_sha256`
  ),
  CONSTRAINT `forecast_impressions_scores_check` CHECK (
    `opportunity_score` BETWEEN 0 AND 100
    AND `habitat_score` BETWEEN 0 AND 100
    AND `seasonality_score` BETWEEN 0 AND 100
    AND `conditions_score` BETWEEN 0 AND 100
    AND `fishability_score` BETWEEN 0 AND 100
  ),
  CONSTRAINT `forecast_impressions_window_check` CHECK (
    length(`window_start`) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', `window_start`) = `window_start`
    AND length(`window_end`) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', `window_end`) = `window_end`
    AND length(`attested_at`) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', `attested_at`) = `attested_at`
    AND julianday(`window_end`) > julianday(`window_start`)
    AND abs((julianday(`window_end`) - julianday(`window_start`)) * 24.0 - 2.0) < 0.000001
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forecast_impressions_window_idx`
  ON `forecast_impressions` (`window_id`, `site_id`, `window_start`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `trip_validation_provenance` (
  `id` text PRIMARY KEY NOT NULL,
  `trip_id` text NOT NULL,
  `event_type` text NOT NULL,
  `collection_contract_version` text NOT NULL,
  `validation_protocol_id` text,
  `activation_manifest_sha256` text,
  `activated_at` text,
  `activation_scoring_system_sha256` text,
  `cohort_id` text NOT NULL,
  `source_role` text NOT NULL,
  `participant_group_id` text,
  `recruitment_frame_id` text,
  `recruitment_source_id` text NOT NULL,
  `recruitment_event_contract_version` text,
  `recruitment_event_at` text,
  `recruitment_event_sha256` text,
  `community_approval_sha256` text,
  `assignment_id` text,
  `source_record_sha256` text,
  `effort_segment_id` text,
  `effort_unit` text,
  `attempt_count` integer,
  `target_taxon_id` text,
  `segment_start_at` text,
  `segment_end_at` text,
  `mode_at_completion` text,
  `angler_count` integer,
  `duration_milliseconds` integer,
  `person_milliseconds` integer,
  `completion_event_contract_version` text,
  `completion_event_at` text,
  `completion_consent_version` text,
  `completion_consented_at` text,
  `completion_primary_target_confirmed` integer,
  `completion_complete_attempt_confirmed` integer,
  `completion_event_sha256` text,
  `incentive_policy_id` text NOT NULL,
  `selection_method` text NOT NULL,
  `target_intent` text NOT NULL,
  `primary_target_confirmed` integer,
  `complete_attempt_confirmed` integer,
  `mode_at_enrollment` text,
  `consent_version` text,
  `consented_at` text,
  `score_influenced_choice` integer,
  `attestation_status` text NOT NULL,
  `forecast_impression_id` text,
  `completion_attested_at` text,
  `evidence_status` text NOT NULL,
  `exclusion_reason` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON DELETE cascade,
  FOREIGN KEY (`forecast_impression_id`, `trip_id`) REFERENCES `forecast_impressions`(`id`, `trip_id`) ON DELETE cascade,
  CONSTRAINT `trip_validation_event_type_check` CHECK (`event_type` IN (
    'enrollment', 'completion', 'retrospective_submission', 'evidence_exclusion', 'legacy_context'
  )),
  CONSTRAINT `trip_validation_source_role_check` CHECK (`source_role` IN ('context_only', 'prospective_secondary')),
  CONSTRAINT `trip_validation_selection_method_check` CHECK (`selection_method` IN (
    'organic_score_visible', 'organic_unverified', 'retrospective_self_report', 'legacy_unknown'
  )),
  CONSTRAINT `trip_validation_target_intent_check` CHECK (`target_intent` IN (
    'california-halibut-primary-full-trip', 'legacy_unknown'
  )),
  CONSTRAINT `trip_validation_target_complete_check` CHECK (
    (`primary_target_confirmed` IS NULL OR `primary_target_confirmed` IN (0, 1))
    AND (`complete_attempt_confirmed` IS NULL OR `complete_attempt_confirmed` IN (0, 1))
  ),
  CONSTRAINT `trip_validation_mode_check` CHECK (`mode_at_enrollment` IS NULL OR `mode_at_enrollment` IN (
    'shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other'
  )),
  CONSTRAINT `trip_validation_score_influence_check` CHECK (
    `score_influenced_choice` IS NULL OR `score_influenced_choice` IN (0, 1)
  ),
  CONSTRAINT `trip_validation_attestation_check` CHECK (`attestation_status` IN (
    'verified', 'unverified_missing', 'unverified_mismatch', 'unverified_asset',
    'not_applicable_retrospective', 'invalidated_after_edit', 'legacy_unverified'
  )),
  CONSTRAINT `trip_validation_evidence_status_check` CHECK (`evidence_status` IN (
    'context_only', 'secondary_pending_review'
  )),
  CONSTRAINT `trip_validation_verified_impression_check` CHECK (
    (`attestation_status` = 'verified' AND `forecast_impression_id` IS NOT NULL)
    OR (`attestation_status` != 'verified' AND `forecast_impression_id` IS NULL)
  ),
  CONSTRAINT `trip_validation_activation_check` CHECK (
    (`validation_protocol_id` IS NULL
      AND `activation_manifest_sha256` IS NULL
      AND `activated_at` IS NULL
      AND `activation_scoring_system_sha256` IS NULL)
    OR
    (`validation_protocol_id` = 'california-halibut-site-window-v1'
      AND length(`activation_manifest_sha256`) = 64
      AND `activation_manifest_sha256` NOT GLOB '*[^a-f0-9]*'
      AND length(`activated_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `activated_at`) = `activated_at`
      AND length(`activation_scoring_system_sha256`) = 64
      AND `activation_scoring_system_sha256` NOT GLOB '*[^a-f0-9]*'
      AND `activated_at` < '2026-08-01T00:00:00.000Z'
      AND julianday(`activated_at`) < julianday(`created_at`))
  ),
  CONSTRAINT `trip_validation_collection_time_check` CHECK (
    `collection_contract_version` = 'castingcompass.validation-collection/1.0.0'
    AND length(`created_at`) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', `created_at`) = `created_at`
    AND (`consented_at` IS NULL OR (
      length(`consented_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `consented_at`) = `consented_at`))
    AND (`completion_attested_at` IS NULL OR (
      length(`completion_attested_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `completion_attested_at`) = `completion_attested_at`))
  ),
  CONSTRAINT `trip_validation_recruitment_event_check` CHECK (
    (`participant_group_id` IS NULL
      AND `recruitment_frame_id` IS NULL
      AND `recruitment_event_contract_version` IS NULL
      AND `recruitment_event_at` IS NULL
      AND `recruitment_event_sha256` IS NULL
      AND `community_approval_sha256` IS NULL)
    OR
    (length(`participant_group_id`) = 76
      AND substr(`participant_group_id`, 1, 12) = 'participant-'
      AND substr(`participant_group_id`, 13) NOT GLOB '*[^a-f0-9]*'
      AND `recruitment_frame_id` = 'california-halibut-site-window-recruitment-v1'
      AND `recruitment_source_id` IN (
        'castingcompass-organic-product',
        'direct-opt-in-research-invite',
        'admin-approved-community-prospective'
      )
      AND `recruitment_event_contract_version` = 'castingcompass.recruitment-event/1.0.0'
      AND length(`recruitment_event_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `recruitment_event_at`) = `recruitment_event_at`
      AND julianday(`recruitment_event_at`) <= julianday(`created_at`)
      AND length(`recruitment_event_sha256`) = 64
      AND `recruitment_event_sha256` NOT GLOB '*[^a-f0-9]*'
      AND ((`recruitment_source_id` = 'admin-approved-community-prospective'
          AND length(`community_approval_sha256`) = 64
          AND `community_approval_sha256` NOT GLOB '*[^a-f0-9]*')
        OR (`recruitment_source_id` != 'admin-approved-community-prospective'
          AND `community_approval_sha256` IS NULL)))
  ),
  CONSTRAINT `trip_validation_collection_identity_check` CHECK (
    (`assignment_id` IS NULL
      AND `source_record_sha256` IS NULL
      AND `effort_segment_id` IS NULL
      AND `effort_unit` IS NULL
      AND `attempt_count` IS NULL
      AND `target_taxon_id` IS NULL
      AND `segment_start_at` IS NULL)
    OR
    (length(`assignment_id`) = 75
      AND substr(`assignment_id`, 1, 11) = 'assignment-'
      AND substr(`assignment_id`, 12) NOT GLOB '*[^a-f0-9]*'
      AND length(`source_record_sha256`) = 64
      AND `source_record_sha256` NOT GLOB '*[^a-f0-9]*'
      AND length(`effort_segment_id`) = 71
      AND substr(`effort_segment_id`, 1, 7) = 'effort-'
      AND substr(`effort_segment_id`, 8) NOT GLOB '*[^a-f0-9]*'
      AND `effort_unit` = 'whole-trip-group-attempt'
      AND `attempt_count` = 1
      AND `target_taxon_id` = 'california-halibut'
      AND length(`segment_start_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `segment_start_at`) = `segment_start_at`)
  ),
  CONSTRAINT `trip_validation_completion_event_check` CHECK (
    (`segment_end_at` IS NULL
      AND `mode_at_completion` IS NULL
      AND `angler_count` IS NULL
      AND `duration_milliseconds` IS NULL
      AND `person_milliseconds` IS NULL
      AND `completion_event_contract_version` IS NULL
      AND `completion_event_at` IS NULL
      AND `completion_consent_version` IS NULL
      AND `completion_consented_at` IS NULL
      AND `completion_primary_target_confirmed` IS NULL
      AND `completion_complete_attempt_confirmed` IS NULL
      AND `completion_event_sha256` IS NULL)
    OR
    (`assignment_id` IS NOT NULL
      AND length(`segment_end_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `segment_end_at`) = `segment_end_at`
      AND julianday(`segment_end_at`) > julianday(`segment_start_at`)
      AND `mode_at_completion` IN ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
      AND `angler_count` BETWEEN 1 AND 12
      AND `duration_milliseconds` BETWEEN 60000 AND 129600000
      AND CAST(ROUND((julianday(`segment_end_at`) - julianday(`segment_start_at`)) * 86400000.0) AS INTEGER) = `duration_milliseconds`
      AND `person_milliseconds` = `duration_milliseconds` * `angler_count`
      AND `completion_event_contract_version` = 'castingcompass.validation-completion-event/1.0.0'
      AND length(`completion_event_at`) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', `completion_event_at`) = `completion_event_at`
      AND julianday(`completion_event_at`) >= julianday(`segment_end_at`)
      AND `completion_consent_version` = 'castingcompass.trip-validation-consent/1.0.0'
      AND `completion_consented_at` = `completion_event_at`
      AND `completion_primary_target_confirmed` = 1
      AND `completion_complete_attempt_confirmed` = 1
      AND length(`completion_event_sha256`) = 64
      AND `completion_event_sha256` NOT GLOB '*[^a-f0-9]*'
      AND `completion_event_at` = `completion_attested_at`
      AND `completion_consent_version` = `consent_version`
      AND `completion_consented_at` = `consented_at`
      AND `completion_primary_target_confirmed` = `primary_target_confirmed`
      AND `completion_complete_attempt_confirmed` = `complete_attempt_confirmed`)
  ),
  CONSTRAINT `trip_validation_role_check` CHECK (
    (`source_role` = 'prospective_secondary'
      AND `validation_protocol_id` IS NOT NULL
      AND `participant_group_id` IS NOT NULL
      AND `recruitment_frame_id` = 'california-halibut-site-window-recruitment-v1'
      AND `recruitment_event_contract_version` = 'castingcompass.recruitment-event/1.0.0'
      AND `recruitment_event_sha256` IS NOT NULL
      AND `assignment_id` IS NOT NULL
      AND `source_record_sha256` IS NOT NULL
      AND `effort_segment_id` IS NOT NULL
      AND `effort_unit` = 'whole-trip-group-attempt'
      AND `attempt_count` = 1
      AND `target_taxon_id` = 'california-halibut'
      AND `segment_start_at` IS NOT NULL
      AND `cohort_id` = 'california-halibut-site-window-observational-secondary-v1'
      AND `incentive_policy_id` = 'none-v1'
      AND `selection_method` = 'organic_score_visible'
      AND `target_intent` = 'california-halibut-primary-full-trip'
      AND `primary_target_confirmed` = 1
      AND `score_influenced_choice` IS NOT NULL
      AND `mode_at_enrollment` IN ('shore', 'beach', 'pier', 'jetty')
      AND `attestation_status` = 'verified'
      AND `evidence_status` = 'secondary_pending_review')
    OR
    (`source_role` = 'context_only' AND `evidence_status` = 'context_only')
  ),
  CONSTRAINT `trip_validation_context_enrollment_recruitment_check` CHECK (
    `event_type` != 'enrollment' OR `source_role` != 'context_only' OR `participant_group_id` IS NULL
  ),
  CONSTRAINT `trip_validation_enrollment_completion_fields_check` CHECK (
    `event_type` != 'enrollment' OR `segment_end_at` IS NULL
  ),
  CONSTRAINT `trip_validation_completion_identity_check` CHECK (
    `event_type` != 'completion' OR `assignment_id` IS NULL OR `completion_event_sha256` IS NOT NULL
  ),
  CONSTRAINT `trip_validation_event_coherence_check` CHECK (
    (`event_type` = 'enrollment'
      AND `primary_target_confirmed` = 1
      AND `complete_attempt_confirmed` IS NULL
      AND `consent_version` = 'castingcompass.trip-validation-consent/1.0.0'
      AND `consented_at` IS NOT NULL
      AND `completion_attested_at` IS NULL)
    OR
    (`event_type` = 'completion'
      AND `primary_target_confirmed` = 1
      AND `complete_attempt_confirmed` = 1
      AND `consent_version` = 'castingcompass.trip-validation-consent/1.0.0'
      AND `consented_at` = `created_at`
      AND `completion_attested_at` = `created_at`)
    OR
    (`event_type` = 'retrospective_submission'
      AND `validation_protocol_id` IS NULL
      AND `source_role` = 'context_only'
      AND `selection_method` = 'retrospective_self_report'
      AND `primary_target_confirmed` = 1
      AND `complete_attempt_confirmed` = 1
      AND `attestation_status` = 'not_applicable_retrospective'
      AND `consented_at` = `created_at`
      AND `completion_attested_at` = `created_at`)
    OR
    (`event_type` = 'evidence_exclusion'
      AND `validation_protocol_id` IS NULL
      AND `activation_manifest_sha256` IS NULL
      AND `activated_at` IS NULL
      AND `activation_scoring_system_sha256` IS NULL
      AND `source_role` = 'context_only'
      AND `participant_group_id` IS NULL
      AND `recruitment_frame_id` IS NULL
      AND `recruitment_event_contract_version` IS NULL
      AND `recruitment_event_at` IS NULL
      AND `recruitment_event_sha256` IS NULL
      AND `community_approval_sha256` IS NULL
      AND `assignment_id` IS NULL
      AND `source_record_sha256` IS NULL
      AND `effort_segment_id` IS NULL
      AND `effort_unit` IS NULL
      AND `attempt_count` IS NULL
      AND `target_taxon_id` IS NULL
      AND `segment_start_at` IS NULL
      AND `segment_end_at` IS NULL
      AND `mode_at_completion` IS NULL
      AND `angler_count` IS NULL
      AND `duration_milliseconds` IS NULL
      AND `person_milliseconds` IS NULL
      AND `completion_event_contract_version` IS NULL
      AND `completion_event_at` IS NULL
      AND `completion_consent_version` IS NULL
      AND `completion_consented_at` IS NULL
      AND `completion_primary_target_confirmed` IS NULL
      AND `completion_complete_attempt_confirmed` IS NULL
      AND `completion_event_sha256` IS NULL
      AND `attestation_status` = 'invalidated_after_edit'
      AND `forecast_impression_id` IS NULL
      AND `completion_attested_at` IS NULL
      AND `evidence_status` = 'context_only'
      AND `exclusion_reason` IN ('post_completion_profile_edit', 'trusted_review_exclusion'))
    OR
    (`event_type` = 'legacy_context'
      AND `source_role` = 'context_only'
      AND `evidence_status` = 'context_only')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trip_validation_provenance_trip_created_idx`
  ON `trip_validation_provenance` (`trip_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trip_validation_provenance_cohort_role_idx`
  ON `trip_validation_provenance` (`collection_contract_version`, `validation_protocol_id`, `cohort_id`, `source_role`, `evidence_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trip_validation_provenance_participant_recruitment_idx`
  ON `trip_validation_provenance` (`participant_group_id`, `recruitment_event_at`);
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `forecast_impressions_append_only_guard`
BEFORE UPDATE ON `forecast_impressions`
BEGIN
  SELECT RAISE(ABORT, 'forecast impressions are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trip_validation_provenance_append_only_guard`
BEFORE UPDATE ON `trip_validation_provenance`
BEGIN
  SELECT RAISE(ABORT, 'trip validation provenance is append-only');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trip_validation_recruitment_event_immutable_guard`
BEFORE INSERT ON `trip_validation_provenance`
WHEN NEW.`participant_group_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `trip_validation_provenance` AS prior
  WHERE prior.`participant_group_id` = NEW.`participant_group_id`
    AND prior.`recruitment_event_sha256` IS NOT NULL
    AND (prior.`recruitment_frame_id` IS NOT NEW.`recruitment_frame_id`
      OR prior.`recruitment_source_id` IS NOT NEW.`recruitment_source_id`
      OR prior.`recruitment_event_contract_version` IS NOT NEW.`recruitment_event_contract_version`
      OR prior.`recruitment_event_at` IS NOT NEW.`recruitment_event_at`
      OR prior.`recruitment_event_sha256` IS NOT NEW.`recruitment_event_sha256`
      OR prior.`community_approval_sha256` IS NOT NEW.`community_approval_sha256`)
)
BEGIN
  SELECT RAISE(ABORT, 'participant recruitment event is immutable');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `forecast_impressions_trip_identity_guard`
BEFORE INSERT ON `forecast_impressions`
WHEN NOT EXISTS (
  SELECT 1 FROM `trips`
  WHERE `id` = NEW.`trip_id`
    AND `site_id` = NEW.`site_id`
    AND julianday(`started_at`) >= julianday(NEW.`window_start`)
    AND julianday(`started_at`) < julianday(NEW.`window_end`)
)
BEGIN
  SELECT RAISE(ABORT, 'forecast impression does not match trip site and start window');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trip_validation_activation_identity_guard`
BEFORE INSERT ON `trip_validation_provenance`
WHEN NEW.`validation_protocol_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `forecast_impressions`
  WHERE `id` = NEW.`forecast_impression_id`
    AND `trip_id` = NEW.`trip_id`
    AND `scoring_system_sha256` = NEW.`activation_scoring_system_sha256`
)
BEGIN
  SELECT RAISE(ABORT, 'validation activation does not match forecast impression');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trip_validation_completion_identity_guard`
BEFORE INSERT ON `trip_validation_provenance`
WHEN NEW.`event_type` = 'completion' AND NEW.`assignment_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `trip_validation_provenance` AS enrollment
  WHERE enrollment.`trip_id` = NEW.`trip_id`
    AND enrollment.`event_type` = 'enrollment'
    AND enrollment.`source_role` = 'prospective_secondary'
    AND enrollment.`assignment_id` = NEW.`assignment_id`
    AND enrollment.`source_record_sha256` = NEW.`source_record_sha256`
    AND enrollment.`effort_segment_id` = NEW.`effort_segment_id`
    AND enrollment.`participant_group_id` = NEW.`participant_group_id`
    AND enrollment.`validation_protocol_id` = NEW.`validation_protocol_id`
    AND enrollment.`activation_manifest_sha256` = NEW.`activation_manifest_sha256`
    AND enrollment.`activated_at` = NEW.`activated_at`
    AND enrollment.`activation_scoring_system_sha256` = NEW.`activation_scoring_system_sha256`
    AND enrollment.`cohort_id` = NEW.`cohort_id`
    AND enrollment.`incentive_policy_id` = NEW.`incentive_policy_id`
    AND enrollment.`recruitment_frame_id` = NEW.`recruitment_frame_id`
    AND enrollment.`recruitment_source_id` = NEW.`recruitment_source_id`
    AND enrollment.`recruitment_event_contract_version` = NEW.`recruitment_event_contract_version`
    AND enrollment.`recruitment_event_at` = NEW.`recruitment_event_at`
    AND enrollment.`recruitment_event_sha256` = NEW.`recruitment_event_sha256`
    AND enrollment.`community_approval_sha256` IS NEW.`community_approval_sha256`
    AND enrollment.`forecast_impression_id` = NEW.`forecast_impression_id`
    AND enrollment.`effort_unit` = NEW.`effort_unit`
    AND enrollment.`attempt_count` = NEW.`attempt_count`
    AND enrollment.`target_taxon_id` = NEW.`target_taxon_id`
    AND enrollment.`segment_start_at` = NEW.`segment_start_at`
    AND enrollment.`selection_method` = NEW.`selection_method`
    AND enrollment.`target_intent` = NEW.`target_intent`
    AND enrollment.`primary_target_confirmed` = NEW.`primary_target_confirmed`
    AND enrollment.`mode_at_enrollment` = NEW.`mode_at_enrollment`
    AND enrollment.`score_influenced_choice` = NEW.`score_influenced_choice`
)
BEGIN
  SELECT RAISE(ABORT, 'completion event does not match immutable enrollment identity');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trip_validation_secondary_eligibility_guard`
BEFORE INSERT ON `trip_validation_provenance`
WHEN NEW.`source_role` = 'prospective_secondary' AND NOT EXISTS (
  SELECT 1
  FROM `trips` AS t
  JOIN `forecast_impressions` AS f
    ON f.`id` = NEW.`forecast_impression_id` AND f.`trip_id` = t.`id`
  WHERE t.`id` = NEW.`trip_id`
    AND t.`started_at` >= '2026-08-01T00:00:00.000Z'
    AND t.`started_at` < '2027-08-01T00:00:00.000Z'
    AND julianday(NEW.`activated_at`) < julianday(t.`started_at`)
    AND t.`site_id` = f.`site_id`
    AND t.`started_at` = NEW.`segment_start_at`
    AND julianday(t.`started_at`) >= julianday(f.`window_start`)
    AND julianday(t.`started_at`) < julianday(f.`window_end`)
    AND (NEW.`event_type` != 'completion' OR (
      t.`status` = 'completed'
      AND t.`mode` = NEW.`mode_at_enrollment`
      AND t.`mode` = NEW.`mode_at_completion`
      AND t.`ended_at` = NEW.`segment_end_at`
      AND t.`angler_count` = NEW.`angler_count`
      AND t.`target_taxon_id` = NEW.`target_taxon_id`
      AND julianday(t.`ended_at`) <= julianday(f.`window_end`)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'secondary evidence row is outside its activated site-window envelope');
END;
--> statement-breakpoint

INSERT OR IGNORE INTO `trip_validation_provenance` (
  `id`, `trip_id`, `event_type`, `collection_contract_version`, `validation_protocol_id`, `cohort_id`, `source_role`,
  `recruitment_source_id`, `incentive_policy_id`, `selection_method`, `target_intent`,
  `mode_at_enrollment`, `consent_version`, `consented_at`, `score_influenced_choice`,
  `attestation_status`, `forecast_impression_id`, `completion_attested_at`,
  `evidence_status`, `exclusion_reason`, `created_at`
)
SELECT
  'validation_legacy_' || `id`, `id`, 'legacy_context',
  'castingcompass.validation-collection/1.0.0', NULL, 'predeployment-context', 'context_only',
  'legacy-unknown', 'none-outcome-independent/1.0.0', 'legacy_unknown', 'legacy_unknown',
  `mode`, NULL, `consent_at`, `score_influenced_choice`, 'legacy_unverified', NULL,
  CASE WHEN `status` = 'completed' THEN COALESCE(`completed_at`, `updated_at`) ELSE NULL END,
  'context_only', 'collected_before_validation_provenance', `created_at`
FROM `trips`;
