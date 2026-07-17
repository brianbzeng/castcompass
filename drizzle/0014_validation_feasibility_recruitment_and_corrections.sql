CREATE TABLE IF NOT EXISTS `validation_feasibility_recruitment_campaigns` (
  `activation_id` text NOT NULL,
  `campaign_id` text NOT NULL,
  `recruitment_source_id` text NOT NULL,
  `selection_method` text NOT NULL,
  `invite_issued_at` text NOT NULL,
  `invite_expires_at` text NOT NULL,
  `community_approval_sha256` text,
  `token_payload_sha256` text NOT NULL,
  `sealed_at` text NOT NULL,
  PRIMARY KEY (`activation_id`, `campaign_id`),
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  CONSTRAINT `validation_feasibility_campaign_identity_check` CHECK (
    `campaign_id` GLOB 'campaign-[a-z0-9]*'
    AND length(`campaign_id`) BETWEEN 12 AND 88
    AND `selection_method` = 'direct_precommitment'
    AND length(`token_payload_sha256`) = 64 AND `token_payload_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_campaign_source_check` CHECK (
    (`recruitment_source_id` = 'direct-opt-in-research-invite' AND `community_approval_sha256` IS NULL)
    OR (`recruitment_source_id` = 'admin-approved-community-prospective'
      AND length(`community_approval_sha256`) = 64
      AND `community_approval_sha256` NOT GLOB '*[^a-f0-9]*')
  ),
  CONSTRAINT `validation_feasibility_campaign_time_check` CHECK (
    length(`invite_issued_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `invite_issued_at`) = `invite_issued_at`
    AND length(`invite_expires_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `invite_expires_at`) = `invite_expires_at`
    AND length(`sealed_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `sealed_at`) = `sealed_at`
    AND julianday(`invite_issued_at`) <= julianday(`sealed_at`)
    AND julianday(`invite_expires_at`) > julianday(`sealed_at`)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_campaign_payload_unique`
  ON `validation_feasibility_recruitment_campaigns` (`activation_id`, `token_payload_sha256`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_campaign_seal_guard`
BEFORE INSERT ON `validation_feasibility_recruitment_campaigns`
WHEN NOT EXISTS (
  SELECT 1 FROM `validation_feasibility_activations` AS `activation`
  WHERE `activation`.`id` = NEW.`activation_id`
    AND julianday(NEW.`sealed_at`) < julianday(`activation`.`start_at`)
    AND julianday(NEW.`invite_expires_at`) <= julianday(`activation`.`end_at`)
    AND abs((julianday(NEW.`sealed_at`) - julianday('now')) * 86400.0) <= 5.0
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility campaign must be sealed by the database before activation');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_campaign_update_guard`
BEFORE UPDATE ON `validation_feasibility_recruitment_campaigns`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility recruitment campaign is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_campaign_delete_guard`
BEFORE DELETE ON `validation_feasibility_recruitment_campaigns`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility recruitment campaign is immutable');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_recruitment_events` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` text NOT NULL,
  `activation_id` text NOT NULL,
  `user_id` text NOT NULL,
  `participant_group_id` text NOT NULL,
  `event_contract_version` text NOT NULL,
  `recruitment_frame_id` text NOT NULL,
  `recruitment_source_id` text NOT NULL,
  `selection_method` text NOT NULL,
  `recruited_at` text NOT NULL,
  `campaign_id` text,
  `invite_issued_at` text,
  `invite_expires_at` text,
  `community_approval_sha256` text,
  `event_sha256` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE cascade,
  CONSTRAINT `validation_feasibility_recruitment_contract_check` CHECK (
    `event_contract_version` = 'castingcompass.validation-feasibility-recruitment/2.0.0'
    AND `recruitment_frame_id` = 'california-halibut-feasibility-recruitment-v2'
  ),
  CONSTRAINT `validation_feasibility_recruitment_identity_check` CHECK (
    length(`participant_group_id`) = 76
    AND substr(`participant_group_id`, 1, 12) = 'participant-'
    AND substr(`participant_group_id`, 13) NOT GLOB '*[^a-f0-9]*'
    AND length(`event_sha256`) = 64 AND `event_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_recruitment_time_check` CHECK (
    length(`recruited_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `recruited_at`) = `recruited_at`
    AND length(`created_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `created_at`) = `created_at`
    AND `created_at` = `recruited_at`
    AND (`invite_issued_at` IS NULL OR (
      length(`invite_issued_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `invite_issued_at`) = `invite_issued_at`
    ))
    AND (`invite_expires_at` IS NULL OR (
      length(`invite_expires_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `invite_expires_at`) = `invite_expires_at`
    ))
  ),
  CONSTRAINT `validation_feasibility_recruitment_state_check` CHECK (
    (`recruitment_source_id` = 'castingcompass-organic-product'
      AND `selection_method` = 'organic_score_visible'
      AND `campaign_id` IS NULL AND `invite_issued_at` IS NULL
      AND `invite_expires_at` IS NULL AND `community_approval_sha256` IS NULL)
    OR (`recruitment_source_id` = 'direct-opt-in-research-invite'
      AND `selection_method` = 'direct_precommitment'
      AND `campaign_id` GLOB 'campaign-[a-z0-9]*'
      AND length(`campaign_id`) BETWEEN 12 AND 88
      AND `invite_issued_at` IS NOT NULL AND `invite_expires_at` IS NOT NULL
      AND `community_approval_sha256` IS NULL)
    OR (`recruitment_source_id` = 'admin-approved-community-prospective'
      AND `selection_method` = 'direct_precommitment'
      AND `campaign_id` GLOB 'campaign-[a-z0-9]*'
      AND length(`campaign_id`) BETWEEN 12 AND 88
      AND `invite_issued_at` IS NOT NULL AND `invite_expires_at` IS NOT NULL
      AND length(`community_approval_sha256`) = 64
      AND `community_approval_sha256` NOT GLOB '*[^a-f0-9]*')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_recruitment_event_id_unique`
  ON `validation_feasibility_recruitment_events` (`event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_recruitment_event_hash_unique`
  ON `validation_feasibility_recruitment_events` (`event_sha256`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_recruitment_participant_unique`
  ON `validation_feasibility_recruitment_events` (`activation_id`, `participant_group_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_recruitment_user_unique`
  ON `validation_feasibility_recruitment_events` (`activation_id`, `user_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_recruitment_activation_guard`
BEFORE INSERT ON `validation_feasibility_recruitment_events`
WHEN NOT EXISTS (
  SELECT 1 FROM `validation_feasibility_activations` AS `activation`
  WHERE `activation`.`id` = NEW.`activation_id`
    AND julianday(NEW.`recruited_at`) >= julianday(`activation`.`start_at`)
    AND julianday(NEW.`recruited_at`) < julianday(`activation`.`end_at`)
    AND (
      (NEW.`recruitment_source_id` = 'castingcompass-organic-product')
      OR EXISTS (
        SELECT 1 FROM `validation_feasibility_recruitment_campaigns` AS `campaign`
        WHERE `campaign`.`activation_id` = NEW.`activation_id`
          AND `campaign`.`campaign_id` = NEW.`campaign_id`
          AND `campaign`.`recruitment_source_id` = NEW.`recruitment_source_id`
          AND `campaign`.`selection_method` = NEW.`selection_method`
          AND `campaign`.`invite_issued_at` = NEW.`invite_issued_at`
          AND `campaign`.`invite_expires_at` = NEW.`invite_expires_at`
          AND `campaign`.`community_approval_sha256` IS NEW.`community_approval_sha256`
          AND julianday(`campaign`.`sealed_at`) < julianday(`activation`.`start_at`)
          AND julianday(`campaign`.`invite_expires_at`) > julianday(NEW.`recruited_at`)
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility recruitment is outside its sealed activation');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_recruitment_update_guard`
BEFORE UPDATE ON `validation_feasibility_recruitment_events`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility recruitment is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_start_recruitment_guard`
BEFORE INSERT ON `validation_feasibility_events`
WHEN NEW.`event_type` = 'started' AND NOT EXISTS (
  SELECT 1
  FROM `validation_feasibility_recruitment_events` AS `recruitment`
  JOIN `trips` AS `trip` ON `trip`.`id` = NEW.`trip_id` AND `trip`.`user_id` = `recruitment`.`user_id`
  WHERE `recruitment`.`activation_id` = NEW.`activation_id`
    AND `recruitment`.`participant_group_id` = NEW.`participant_group_id`
    AND `recruitment`.`recruitment_frame_id` = NEW.`recruitment_frame_id`
    AND `recruitment`.`recruitment_source_id` = NEW.`recruitment_source_id`
    AND `recruitment`.`selection_method` = NEW.`selection_method`
    AND julianday(`recruitment`.`recruited_at`) <= julianday(NEW.`segment_start_at`)
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility start lacks immutable recruitment provenance');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_recruitment_removals` (
  `activation_id` text NOT NULL,
  `removal_day` text NOT NULL,
  `removed_recruitment_count` integer DEFAULT 0 NOT NULL,
  `removed_organic_count` integer DEFAULT 0 NOT NULL,
  `removed_direct_count` integer DEFAULT 0 NOT NULL,
  `removed_community_count` integer DEFAULT 0 NOT NULL,
  `first_removed_at` text NOT NULL,
  `last_removed_at` text NOT NULL,
  PRIMARY KEY (`activation_id`, `removal_day`),
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  CONSTRAINT `validation_feasibility_recruitment_removal_counts_check` CHECK (
    `removed_recruitment_count` = `removed_organic_count` + `removed_direct_count` + `removed_community_count`
  )
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_recruitment_delete_guard`
BEFORE DELETE ON `validation_feasibility_recruitment_events`
WHEN EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility recruitment may be removed only with account privacy deletion');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_recruitment_removal_audit`
AFTER DELETE ON `validation_feasibility_recruitment_events`
BEGIN
  INSERT INTO `validation_feasibility_recruitment_removals` (
    `activation_id`, `removal_day`, `removed_recruitment_count`, `removed_organic_count`,
    `removed_direct_count`, `removed_community_count`, `first_removed_at`, `last_removed_at`
  ) VALUES (
    OLD.`activation_id`, strftime('%Y-%m-%d', 'now'), 1,
    CASE WHEN OLD.`recruitment_source_id` = 'castingcompass-organic-product' THEN 1 ELSE 0 END,
    CASE WHEN OLD.`recruitment_source_id` = 'direct-opt-in-research-invite' THEN 1 ELSE 0 END,
    CASE WHEN OLD.`recruitment_source_id` = 'admin-approved-community-prospective' THEN 1 ELSE 0 END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (`activation_id`, `removal_day`) DO UPDATE SET
    `removed_recruitment_count` = `removed_recruitment_count` + 1,
    `removed_organic_count` = `removed_organic_count` + CASE WHEN OLD.`recruitment_source_id` = 'castingcompass-organic-product' THEN 1 ELSE 0 END,
    `removed_direct_count` = `removed_direct_count` + CASE WHEN OLD.`recruitment_source_id` = 'direct-opt-in-research-invite' THEN 1 ELSE 0 END,
    `removed_community_count` = `removed_community_count` + CASE WHEN OLD.`recruitment_source_id` = 'admin-approved-community-prospective' THEN 1 ELSE 0 END,
    `last_removed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_corrections` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `correction_id` text NOT NULL,
  `activation_id` text NOT NULL,
  `trip_id` text NOT NULL,
  `correction_contract_version` text NOT NULL,
  `root_completion_event_sha256` text NOT NULL,
  `previous_event_sha256` text NOT NULL,
  `correction_reason` text NOT NULL,
  `analytical_status` text NOT NULL,
  `site_id` text NOT NULL,
  `geographic_panel` text NOT NULL,
  `mode` text NOT NULL,
  `segment_start_at` text NOT NULL,
  `segment_end_at` text NOT NULL,
  `angler_count` integer NOT NULL,
  `effort_minutes` real NOT NULL,
  `target_encountered` integer NOT NULL,
  `target_encounter_count` integer NOT NULL,
  `target_retained_count` integer NOT NULL,
  `target_released_count` integer NOT NULL,
  `identification_confidence` text NOT NULL,
  `corrected_at` text NOT NULL,
  `event_sha256` text NOT NULL,
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  FOREIGN KEY (`trip_id`) REFERENCES `trips` (`id`) ON DELETE cascade,
  CONSTRAINT `validation_feasibility_correction_contract_check` CHECK (
    `correction_contract_version` = 'castingcompass.validation-feasibility-correction/2.0.0'
    AND `correction_reason` = 'participant_profile_edit'
    AND `analytical_status` IN ('eligible_corrected_completion', 'excluded_after_identity_correction')
  ),
  CONSTRAINT `validation_feasibility_correction_hash_check` CHECK (
    length(`root_completion_event_sha256`) = 64 AND `root_completion_event_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`previous_event_sha256`) = 64 AND `previous_event_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`event_sha256`) = 64 AND `event_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_correction_observation_check` CHECK (
    `geographic_panel` IN ('north-coast', 'golden-gate-sf-coast', 'north-east-bay', 'central-south-bay', 'san-mateo-coast')
    AND `mode` IN ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
    AND `angler_count` BETWEEN 1 AND 12
    AND typeof(`effort_minutes`) IN ('integer', 'real') AND `effort_minutes` > 0 AND `effort_minutes` <= 2160
    AND `target_encountered` IN (0, 1)
    AND `target_encounter_count` BETWEEN 0 AND 40
    AND `target_retained_count` BETWEEN 0 AND 25
    AND `target_released_count` BETWEEN 0 AND 25
    AND `target_encounter_count` = `target_retained_count` + `target_released_count`
    AND `target_encountered` = CASE WHEN `target_encounter_count` > 0 THEN 1 ELSE 0 END
    AND `identification_confidence` = CASE WHEN `target_encounter_count` > 0 THEN 'self_reported' ELSE 'not_observed' END
  ),
  CONSTRAINT `validation_feasibility_correction_time_check` CHECK (
    length(`segment_start_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `segment_start_at`) = `segment_start_at`
    AND length(`segment_end_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `segment_end_at`) = `segment_end_at`
    AND length(`corrected_at`) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', `corrected_at`) = `corrected_at`
    AND julianday(`segment_end_at`) > julianday(`segment_start_at`)
    AND julianday(`corrected_at`) >= julianday(`segment_end_at`)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_correction_id_unique`
  ON `validation_feasibility_corrections` (`correction_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_correction_hash_unique`
  ON `validation_feasibility_corrections` (`event_sha256`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `validation_feasibility_correction_trip_sequence_idx`
  ON `validation_feasibility_corrections` (`trip_id`, `sequence`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_correction_update_guard`
BEFORE UPDATE ON `validation_feasibility_corrections`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility corrections are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_correction_chain_guard`
BEFORE INSERT ON `validation_feasibility_corrections`
WHEN NOT EXISTS (
  SELECT 1 FROM `validation_feasibility_events` AS `completion`
  WHERE `completion`.`trip_id` = NEW.`trip_id`
    AND `completion`.`activation_id` = NEW.`activation_id`
    AND `completion`.`event_type` = 'completed'
    AND `completion`.`event_sha256` = NEW.`root_completion_event_sha256`
    AND NEW.`previous_event_sha256` = COALESCE(
      (SELECT `prior`.`event_sha256` FROM `validation_feasibility_corrections` AS `prior`
       WHERE `prior`.`trip_id` = NEW.`trip_id` ORDER BY `prior`.`sequence` DESC LIMIT 1),
      `completion`.`event_sha256`
    )
    AND julianday(NEW.`corrected_at`) >= julianday(COALESCE(
      (SELECT `prior`.`corrected_at` FROM `validation_feasibility_corrections` AS `prior`
       WHERE `prior`.`trip_id` = NEW.`trip_id` ORDER BY `prior`.`sequence` DESC LIMIT 1),
      `completion`.`event_at`
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility correction does not extend the current chain');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_correction_trip_state_guard`
BEFORE INSERT ON `validation_feasibility_corrections`
WHEN NOT EXISTS (
  SELECT 1 FROM `trips` AS `trip`
  WHERE `trip`.`id` = NEW.`trip_id`
    AND `trip`.`status` = 'completed'
    AND `trip`.`moderation_status` = 'pending'
    AND `trip`.`site_id` = NEW.`site_id`
    AND `trip`.`mode` = NEW.`mode`
    AND `trip`.`started_at` = NEW.`segment_start_at`
    AND `trip`.`ended_at` = NEW.`segment_end_at`
    AND `trip`.`angler_count` = NEW.`angler_count`
    AND `trip`.`target_encounter_count` = NEW.`target_encounter_count`
    AND `trip`.`keeper_count` = NEW.`target_retained_count`
    AND `trip`.`short_released_count` = NEW.`target_released_count`
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility correction does not match current product trip state');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_correction_status_guard`
BEFORE INSERT ON `validation_feasibility_corrections`
WHEN (
  (NEW.`analytical_status` = 'eligible_corrected_completion' AND NOT EXISTS (
    SELECT 1 FROM `validation_feasibility_events` AS `started`
    WHERE `started`.`trip_id` = NEW.`trip_id` AND `started`.`event_type` = 'started'
      AND `started`.`site_id` = NEW.`site_id`
      AND `started`.`geographic_panel` = NEW.`geographic_panel`
      AND `started`.`mode` = NEW.`mode`
      AND `started`.`segment_start_at` = NEW.`segment_start_at`
      AND `started`.`angler_count` = NEW.`angler_count`
  ))
  OR
  (NEW.`analytical_status` = 'excluded_after_identity_correction' AND EXISTS (
    SELECT 1 FROM `validation_feasibility_events` AS `started`
    WHERE `started`.`trip_id` = NEW.`trip_id` AND `started`.`event_type` = 'started'
      AND `started`.`site_id` = NEW.`site_id`
      AND `started`.`geographic_panel` = NEW.`geographic_panel`
      AND `started`.`mode` = NEW.`mode`
      AND `started`.`segment_start_at` = NEW.`segment_start_at`
      AND `started`.`angler_count` = NEW.`angler_count`
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility correction analytical status is inconsistent');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_correction_removals` (
  `activation_id` text NOT NULL,
  `removal_day` text NOT NULL,
  `removed_correction_count` integer DEFAULT 0 NOT NULL,
  `first_removed_at` text NOT NULL,
  `last_removed_at` text NOT NULL,
  PRIMARY KEY (`activation_id`, `removal_day`),
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_correction_delete_guard`
BEFORE DELETE ON `validation_feasibility_corrections`
WHEN EXISTS (SELECT 1 FROM `trips` WHERE `id` = OLD.`trip_id`)
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility corrections may be removed only with trip privacy deletion');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_correction_removal_audit`
AFTER DELETE ON `validation_feasibility_corrections`
BEGIN
  INSERT INTO `validation_feasibility_correction_removals` (
    `activation_id`, `removal_day`, `removed_correction_count`, `first_removed_at`, `last_removed_at`
  ) VALUES (
    OLD.`activation_id`, strftime('%Y-%m-%d', 'now'), 1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (`activation_id`, `removal_day`) DO UPDATE SET
    `removed_correction_count` = `removed_correction_count` + 1,
    `last_removed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
