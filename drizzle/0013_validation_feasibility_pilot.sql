CREATE TABLE IF NOT EXISTS `validation_feasibility_activations` (
  `id` text PRIMARY KEY NOT NULL,
  `protocol_id` text NOT NULL,
  `protocol_version` text NOT NULL,
  `protocol_sha256` text NOT NULL,
  `activation_commitment_sha256` text NOT NULL,
  `activation_manifest_sha256` text NOT NULL,
  `site_catalog_sha256` text NOT NULL,
  `scoring_system_kind` text NOT NULL,
  `scoring_system_version` text NOT NULL,
  `scoring_system_sha256` text NOT NULL,
  `worker_version_id` text NOT NULL,
  `study_consent_version` text NOT NULL,
  `start_at` text NOT NULL,
  `end_at` text NOT NULL,
  `preregistered_at` text NOT NULL,
  `receipt_verified_at` text NOT NULL,
  `status` text NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT `validation_feasibility_activation_protocol_check` CHECK (
    `protocol_id` = 'california-halibut-collection-feasibility-v2'
    AND `protocol_version` = '2.0.0'
    AND `protocol_sha256` = '8ff0d7bd009ed8eb10f328347d58d0b63d0b6c822b08351cc5c2760d41de13ed'
    AND `site_catalog_sha256` = 'b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860'
  ),
  CONSTRAINT `validation_feasibility_activation_hash_check` CHECK (
    length(`protocol_sha256`) = 64 AND `protocol_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`activation_commitment_sha256`) = 64 AND `activation_commitment_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`activation_manifest_sha256`) = 64 AND `activation_manifest_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`site_catalog_sha256`) = 64 AND `site_catalog_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`scoring_system_sha256`) = 64 AND `scoring_system_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_activation_identity_check` CHECK (
    `scoring_system_kind` = 'heuristic-configuration'
    AND `scoring_system_version` = 'heuristic-california-halibut-' || `scoring_system_sha256`
    AND length(`worker_version_id`) BETWEEN 1 AND 200
    AND length(`study_consent_version`) BETWEEN 1 AND 200
  ),
  CONSTRAINT `validation_feasibility_activation_time_check` CHECK (
    length(`start_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `start_at`) = `start_at`
    AND length(`end_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `end_at`) = `end_at`
    AND length(`preregistered_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `preregistered_at`) = `preregistered_at`
    AND length(`receipt_verified_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `receipt_verified_at`) = `receipt_verified_at`
    AND length(`created_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `created_at`) = `created_at`
    AND julianday(`end_at`) > julianday(`start_at`)
    AND julianday(`end_at`) - julianday(`start_at`) BETWEEN 90 AND 365
    AND julianday(`created_at`) <= julianday(`preregistered_at`)
    AND julianday(`preregistered_at`) <= julianday(`receipt_verified_at`)
    AND julianday(`receipt_verified_at`) < julianday(`start_at`)
  ),
  CONSTRAINT `validation_feasibility_activation_status_check` CHECK (`status` = 'sealed-before-enrollment')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_activation_commitment_unique`
  ON `validation_feasibility_activations` (`activation_commitment_sha256`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_activation_manifest_unique`
  ON `validation_feasibility_activations` (`activation_manifest_sha256`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_activation_update_guard`
BEFORE UPDATE ON `validation_feasibility_activations`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility activation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_activation_delete_guard`
BEFORE DELETE ON `validation_feasibility_activations`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility activation is immutable');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_events` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` text NOT NULL,
  `activation_id` text NOT NULL,
  `trip_id` text NOT NULL,
  `event_type` text NOT NULL,
  `event_contract_version` text NOT NULL,
  `source_record_sha256` text NOT NULL,
  `participant_group_id` text NOT NULL,
  `recruitment_frame_id` text NOT NULL,
  `recruitment_source_id` text NOT NULL,
  `selection_method` text NOT NULL,
  `score_influenced_choice` integer NOT NULL,
  `study_consent_version` text NOT NULL,
  `study_consented_at` text NOT NULL,
  `target_taxon_id` text NOT NULL,
  `site_id` text NOT NULL,
  `geographic_panel` text NOT NULL,
  `mode` text NOT NULL,
  `segment_start_at` text NOT NULL,
  `segment_end_at` text,
  `angler_count` integer NOT NULL,
  `effort_minutes` real,
  `target_encountered` integer,
  `target_encounter_count` integer,
  `target_retained_count` integer,
  `target_released_count` integer,
  `identification_confidence` text,
  `scoring_system_kind` text NOT NULL,
  `scoring_system_version` text NOT NULL,
  `scoring_system_sha256` text NOT NULL,
  `opportunity_score` integer NOT NULL,
  `opportunity_window_id` text NOT NULL,
  `snapshot_sha256` text NOT NULL,
  `terminal_reason` text,
  `previous_event_sha256` text,
  `event_at` text NOT NULL,
  `event_sha256` text NOT NULL,
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`) ON DELETE cascade,
  CONSTRAINT `validation_feasibility_event_type_check` CHECK (`event_type` IN ('started', 'completed', 'safe_canceled')),
  CONSTRAINT `validation_feasibility_event_contract_check` CHECK (`event_contract_version` = 'castingcompass.validation-feasibility-event/2.0.0'),
  CONSTRAINT `validation_feasibility_event_hash_check` CHECK (
    length(`source_record_sha256`) = 64 AND `source_record_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`scoring_system_sha256`) = 64 AND `scoring_system_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`snapshot_sha256`) = 64 AND `snapshot_sha256` NOT GLOB '*[^a-f0-9]*'
    AND (`previous_event_sha256` IS NULL OR (length(`previous_event_sha256`) = 64 AND `previous_event_sha256` NOT GLOB '*[^a-f0-9]*'))
    AND length(`event_sha256`) = 64 AND `event_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_event_participant_check` CHECK (
    length(`participant_group_id`) = 76
    AND substr(`participant_group_id`, 1, 12) = 'participant-'
    AND substr(`participant_group_id`, 13) NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_event_recruitment_check` CHECK (
    `recruitment_frame_id` = 'california-halibut-feasibility-recruitment-v2'
    AND `recruitment_source_id` IN (
      'castingcompass-organic-product',
      'direct-opt-in-research-invite',
      'admin-approved-community-prospective'
    )
    AND `selection_method` IN ('organic_score_visible', 'direct_precommitment', 'safe_randomized')
    AND `score_influenced_choice` IN (0, 1)
  ),
  CONSTRAINT `validation_feasibility_event_population_check` CHECK (
    `target_taxon_id` = 'california-halibut'
    AND `mode` IN ('shore', 'beach', 'pier', 'jetty')
    AND `geographic_panel` IN ('north-coast', 'golden-gate-sf-coast', 'north-east-bay', 'central-south-bay', 'san-mateo-coast')
    AND `angler_count` BETWEEN 1 AND 12
  ),
  CONSTRAINT `validation_feasibility_event_score_check` CHECK (
    `scoring_system_kind` = 'heuristic-configuration'
    AND `scoring_system_version` = 'heuristic-california-halibut-' || `scoring_system_sha256`
    AND `opportunity_score` BETWEEN 0 AND 100
  ),
  CONSTRAINT `validation_feasibility_event_time_check` CHECK (
    length(`study_consented_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `study_consented_at`) = `study_consented_at`
    AND length(`segment_start_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `segment_start_at`) = `segment_start_at`
    AND (`segment_end_at` IS NULL OR (length(`segment_end_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `segment_end_at`) = `segment_end_at`))
    AND length(`event_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `event_at`) = `event_at`
    AND julianday(`study_consented_at`) <= julianday(`segment_start_at`)
    AND julianday(`event_at`) >= julianday(`segment_start_at`)
    AND (`segment_end_at` IS NULL OR julianday(`segment_end_at`) >= julianday(`segment_start_at`))
  ),
  CONSTRAINT `validation_feasibility_event_state_check` CHECK (
    (`event_type` = 'started'
      AND `segment_end_at` IS NULL
      AND `effort_minutes` IS NULL
      AND `target_encountered` IS NULL
      AND `target_encounter_count` IS NULL
      AND `target_retained_count` IS NULL
      AND `target_released_count` IS NULL
      AND `identification_confidence` IS NULL
      AND `terminal_reason` IS NULL
      AND `previous_event_sha256` IS NULL
      AND `event_at` = `segment_start_at`)
    OR (`event_type` = 'completed'
      AND `segment_end_at` IS NOT NULL
      AND typeof(`effort_minutes`) IN ('integer', 'real') AND `effort_minutes` > 0 AND `effort_minutes` <= 2160
      AND `target_encountered` IN (0, 1)
      AND typeof(`target_encounter_count`) = 'integer' AND `target_encounter_count` BETWEEN 0 AND 40
      AND typeof(`target_retained_count`) = 'integer' AND `target_retained_count` BETWEEN 0 AND 25
      AND typeof(`target_released_count`) = 'integer' AND `target_released_count` BETWEEN 0 AND 25
      AND `target_encounter_count` = `target_retained_count` + `target_released_count`
      AND `target_encountered` = CASE WHEN `target_encounter_count` > 0 THEN 1 ELSE 0 END
      AND `identification_confidence` = CASE WHEN `target_encounter_count` > 0 THEN 'self_reported' ELSE 'not_observed' END
      AND `terminal_reason` IS NULL
      AND `previous_event_sha256` IS NOT NULL
      AND `event_at` = `segment_end_at`)
    OR (`event_type` = 'safe_canceled'
      AND `segment_end_at` IS NOT NULL
      AND typeof(`effort_minutes`) IN ('integer', 'real') AND `effort_minutes` >= 0 AND `effort_minutes` <= 2160
      AND `target_encountered` IS NULL
      AND `target_encounter_count` IS NULL
      AND `target_retained_count` IS NULL
      AND `target_released_count` IS NULL
      AND `identification_confidence` IS NULL
      AND `terminal_reason` IN ('weather', 'water_safety', 'access', 'health', 'personal', 'other')
      AND `previous_event_sha256` IS NOT NULL
      AND `event_at` = `segment_end_at`)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_event_id_unique`
  ON `validation_feasibility_events` (`event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_event_hash_unique`
  ON `validation_feasibility_events` (`event_sha256`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_trip_event_unique`
  ON `validation_feasibility_events` (`trip_id`, `event_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `validation_feasibility_activation_sequence_idx`
  ON `validation_feasibility_events` (`activation_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `validation_feasibility_participant_event_idx`
  ON `validation_feasibility_events` (`participant_group_id`, `event_at`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_event_update_guard`
BEFORE UPDATE ON `validation_feasibility_events`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_start_identity_guard`
BEFORE INSERT ON `validation_feasibility_events`
WHEN NEW.`event_type` = 'started' AND NOT EXISTS (
  SELECT 1
  FROM `trips` AS `trip`
  JOIN `forecast_impressions` AS `forecast` ON `forecast`.`trip_id` = `trip`.`id`
  JOIN `validation_feasibility_activations` AS `activation` ON `activation`.`id` = NEW.`activation_id`
  WHERE `trip`.`id` = NEW.`trip_id`
    AND `trip`.`user_id` IS NOT NULL
    AND `trip`.`status` = 'active'
    AND `trip`.`source` = 'live'
    AND `trip`.`site_id` = NEW.`site_id`
    AND `trip`.`mode` = NEW.`mode`
    AND `trip`.`started_at` = NEW.`segment_start_at`
    AND `trip`.`angler_count` = NEW.`angler_count`
    AND `trip`.`score_influenced_choice` = NEW.`score_influenced_choice`
    AND `trip`.`opportunity_window_id` = NEW.`opportunity_window_id`
    AND `trip`.`opportunity_score` = NEW.`opportunity_score`
    AND `forecast`.`site_id` = NEW.`site_id`
    AND `forecast`.`window_id` = NEW.`opportunity_window_id`
    AND `forecast`.`snapshot_sha256` = NEW.`snapshot_sha256`
    AND `forecast`.`scoring_system_kind` = NEW.`scoring_system_kind`
    AND `forecast`.`scoring_system_version` = NEW.`scoring_system_version`
    AND `forecast`.`scoring_system_sha256` = NEW.`scoring_system_sha256`
    AND `forecast`.`opportunity_score` = NEW.`opportunity_score`
    AND `activation`.`site_catalog_sha256` = `forecast`.`site_catalog_sha256`
    AND `activation`.`scoring_system_kind` = NEW.`scoring_system_kind`
    AND `activation`.`scoring_system_version` = NEW.`scoring_system_version`
    AND `activation`.`scoring_system_sha256` = NEW.`scoring_system_sha256`
    AND `activation`.`study_consent_version` = NEW.`study_consent_version`
    AND julianday(NEW.`event_at`) >= julianday(`activation`.`start_at`)
    AND julianday(NEW.`event_at`) < julianday(`activation`.`end_at`)
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility start does not match its activation, trip, and forecast');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_single_terminal_guard`
BEFORE INSERT ON `validation_feasibility_events`
WHEN NEW.`event_type` IN ('completed', 'safe_canceled') AND EXISTS (
  SELECT 1 FROM `validation_feasibility_events`
  WHERE `trip_id` = NEW.`trip_id` AND `event_type` IN ('completed', 'safe_canceled')
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility attempt already has a terminal event');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_terminal_identity_guard`
BEFORE INSERT ON `validation_feasibility_events`
WHEN NEW.`event_type` IN ('completed', 'safe_canceled') AND NOT EXISTS (
  SELECT 1 FROM `validation_feasibility_events` AS `started`
  WHERE `started`.`trip_id` = NEW.`trip_id`
    AND `started`.`event_type` = 'started'
    AND `started`.`activation_id` = NEW.`activation_id`
    AND `started`.`event_sha256` = NEW.`previous_event_sha256`
    AND `started`.`source_record_sha256` = NEW.`source_record_sha256`
    AND `started`.`participant_group_id` = NEW.`participant_group_id`
    AND `started`.`recruitment_frame_id` = NEW.`recruitment_frame_id`
    AND `started`.`recruitment_source_id` = NEW.`recruitment_source_id`
    AND `started`.`selection_method` = NEW.`selection_method`
    AND `started`.`score_influenced_choice` = NEW.`score_influenced_choice`
    AND `started`.`study_consent_version` = NEW.`study_consent_version`
    AND `started`.`study_consented_at` = NEW.`study_consented_at`
    AND `started`.`target_taxon_id` = NEW.`target_taxon_id`
    AND `started`.`site_id` = NEW.`site_id`
    AND `started`.`geographic_panel` = NEW.`geographic_panel`
    AND `started`.`mode` = NEW.`mode`
    AND `started`.`segment_start_at` = NEW.`segment_start_at`
    AND `started`.`angler_count` = NEW.`angler_count`
    AND `started`.`scoring_system_kind` = NEW.`scoring_system_kind`
    AND `started`.`scoring_system_version` = NEW.`scoring_system_version`
    AND `started`.`scoring_system_sha256` = NEW.`scoring_system_sha256`
    AND `started`.`opportunity_score` = NEW.`opportunity_score`
    AND `started`.`opportunity_window_id` = NEW.`opportunity_window_id`
    AND `started`.`snapshot_sha256` = NEW.`snapshot_sha256`
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility terminal does not match its start');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_terminal_trip_state_guard`
BEFORE INSERT ON `validation_feasibility_events`
WHEN NEW.`event_type` IN ('completed', 'safe_canceled') AND NOT EXISTS (
  SELECT 1 FROM `trips` AS `trip`
  WHERE `trip`.`id` = NEW.`trip_id`
    AND `trip`.`site_id` = NEW.`site_id`
    AND `trip`.`mode` = NEW.`mode`
    AND `trip`.`started_at` = NEW.`segment_start_at`
    AND `trip`.`angler_count` = NEW.`angler_count`
    AND `trip`.`token_hash` IS NULL
    AND (
      (NEW.`event_type` = 'completed'
        AND `trip`.`status` = 'completed'
        AND `trip`.`ended_at` = NEW.`segment_end_at`
        AND `trip`.`completed_at` = NEW.`event_at`
        AND `trip`.`target_encounter_count` = NEW.`target_encounter_count`
        AND `trip`.`keeper_count` = NEW.`target_retained_count`
        AND `trip`.`short_released_count` = NEW.`target_released_count`)
      OR
      (NEW.`event_type` = 'safe_canceled'
        AND `trip`.`status` = 'active'
        AND `trip`.`updated_at` = NEW.`event_at`)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility terminal does not match product trip state');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_privacy_removals` (
  `activation_id` text NOT NULL,
  `removal_day` text NOT NULL,
  `removed_event_count` integer DEFAULT 0 NOT NULL,
  `removed_started_attempt_count` integer DEFAULT 0 NOT NULL,
  `removed_completed_attempt_count` integer DEFAULT 0 NOT NULL,
  `removed_safe_canceled_attempt_count` integer DEFAULT 0 NOT NULL,
  `first_removed_at` text NOT NULL,
  `last_removed_at` text NOT NULL,
  PRIMARY KEY (`activation_id`, `removal_day`),
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  CONSTRAINT `validation_feasibility_privacy_removal_day_check` CHECK (
    length(`removal_day`) = 10 AND strftime('%Y-%m-%d', `removal_day`) = `removal_day`
  ),
  CONSTRAINT `validation_feasibility_privacy_removal_counts_check` CHECK (
    `removed_event_count` >= 0
    AND `removed_started_attempt_count` >= 0
    AND `removed_completed_attempt_count` >= 0
    AND `removed_safe_canceled_attempt_count` >= 0
    AND `removed_event_count` = `removed_started_attempt_count` + `removed_completed_attempt_count` + `removed_safe_canceled_attempt_count`
  )
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_event_delete_guard`
BEFORE DELETE ON `validation_feasibility_events`
WHEN EXISTS (SELECT 1 FROM `trips` WHERE `id` = OLD.`trip_id`)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility events may be removed only with their trip privacy deletion');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_event_privacy_removal_audit`
AFTER DELETE ON `validation_feasibility_events`
BEGIN
  INSERT INTO `validation_feasibility_privacy_removals` (
    `activation_id`, `removal_day`, `removed_event_count`,
    `removed_started_attempt_count`, `removed_completed_attempt_count`,
    `removed_safe_canceled_attempt_count`, `first_removed_at`, `last_removed_at`
  ) VALUES (
    OLD.`activation_id`, strftime('%Y-%m-%d', 'now'), 1,
    CASE WHEN OLD.`event_type` = 'started' THEN 1 ELSE 0 END,
    CASE WHEN OLD.`event_type` = 'completed' THEN 1 ELSE 0 END,
    CASE WHEN OLD.`event_type` = 'safe_canceled' THEN 1 ELSE 0 END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (`activation_id`, `removal_day`) DO UPDATE SET
    `removed_event_count` = `removed_event_count` + 1,
    `removed_started_attempt_count` = `removed_started_attempt_count` + CASE WHEN OLD.`event_type` = 'started' THEN 1 ELSE 0 END,
    `removed_completed_attempt_count` = `removed_completed_attempt_count` + CASE WHEN OLD.`event_type` = 'completed' THEN 1 ELSE 0 END,
    `removed_safe_canceled_attempt_count` = `removed_safe_canceled_attempt_count` + CASE WHEN OLD.`event_type` = 'safe_canceled' THEN 1 ELSE 0 END,
    `last_removed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
