ALTER TABLE `trips` ADD COLUMN `observation_contract_version` text;
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `taxon_catalog_version` text;
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `target_taxon_id` text NOT NULL DEFAULT 'california-halibut'
  CHECK (`target_taxon_id` = 'california-halibut');
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `contract_status` text
  CHECK (`contract_status` IS NULL OR `contract_status` IN ('valid', 'legacy_unverified', 'rejected'));
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `taxon_observations_json` text;
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `outcome_class` text
  CHECK (`outcome_class` IS NULL OR `outcome_class` IN ('target_encountered', 'non_target_only', 'no_fish'));
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `target_encounter_count` integer
  CHECK (`target_encounter_count` IS NULL OR `target_encounter_count` >= 0);
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `any_fish_encounter_count` integer
  CHECK (`any_fish_encounter_count` IS NULL OR `any_fish_encounter_count` >= 0);
--> statement-breakpoint
ALTER TABLE `trips` ADD COLUMN `target_identification_confidence` text
  CHECK (`target_identification_confidence` IS NULL OR `target_identification_confidence`
    IN ('verified', 'self_reported', 'uncertain', 'unresolved', 'not_observed'))
  CONSTRAINT `trips_species_contract_coherence_check` CHECK (
    (`contract_status` IS NOT NULL OR (
      `observation_contract_version` IS NULL
      AND `taxon_catalog_version` IS NULL
      AND `taxon_observations_json` IS NULL
      AND `outcome_class` IS NULL
      AND `target_encounter_count` IS NULL
      AND `any_fish_encounter_count` IS NULL
      AND `target_identification_confidence` IS NULL
    ))
    AND (`contract_status` != 'legacy_unverified' OR (
      `observation_contract_version` IS NULL
      AND `taxon_catalog_version` IS NULL
      AND `taxon_observations_json` IS NULL
      AND `outcome_class` IS NULL
      AND `target_encounter_count` IS NULL
      AND `any_fish_encounter_count` IS NULL
      AND `target_identification_confidence` IS NULL
    ))
    AND (`contract_status` != 'valid' OR (
        `status` = 'completed'
        AND `observation_contract_version` = 'castingcompass.observation/2.0.0'
        AND `taxon_catalog_version` = 'castingcompass.taxa/1.0.0'
        AND `target_taxon_id` = 'california-halibut'
        AND typeof(`angler_count`) = 'integer'
        AND `angler_count` BETWEEN 1 AND 12
        AND typeof(`angler_hours`) IN ('integer', 'real')
        AND `angler_hours` > 0
        AND `angler_hours` <= 432
        AND typeof(`keeper_count`) = 'integer'
        AND typeof(`short_released_count`) = 'integer'
        AND typeof(`halibut_encounters`) = 'integer'
        AND typeof(`no_catch`) = 'integer'
        AND typeof(`other_catch_count`) = 'integer'
        AND typeof(`target_encounter_count`) = 'integer'
        AND typeof(`any_fish_encounter_count`) = 'integer'
        AND `keeper_count` BETWEEN 0 AND 25
        AND `short_released_count` BETWEEN 0 AND 25
        AND `keeper_count` + `short_released_count` <= 40
        AND `other_catch_count` BETWEEN 0 AND 100
        AND `no_catch` IN (0, 1)
        AND typeof(`mode`) = 'text'
        AND `mode` IN ('shore', 'beach', 'pier', 'jetty', 'kayak', 'boat', 'other')
        AND typeof(`started_at`) = 'text'
        AND typeof(`ended_at`) = 'text'
        AND length(`started_at`) = 24
        AND length(`ended_at`) = 24
        AND strftime('%Y-%m-%dT%H:%M:%fZ', `started_at`) = `started_at`
        AND strftime('%Y-%m-%dT%H:%M:%fZ', `ended_at`) = `ended_at`
        AND julianday(`ended_at`) > julianday(`started_at`)
        AND `taxon_observations_json` IS NOT NULL
        AND json_valid(`taxon_observations_json`) = 1
        AND `outcome_class` IS NOT NULL
        AND `target_encounter_count` IS NOT NULL
        AND `any_fish_encounter_count` IS NOT NULL
        AND `target_identification_confidence` IS NOT NULL
        AND `target_encounter_count` = `keeper_count` + `short_released_count`
        AND `halibut_encounters` = `target_encounter_count`
        AND `any_fish_encounter_count` = `target_encounter_count` + `other_catch_count`
        AND `target_encounter_count` <= `any_fish_encounter_count`
        AND `target_identification_confidence` = CASE
          WHEN `target_encounter_count` > 0 THEN 'self_reported'
          ELSE 'not_observed'
        END
        AND `no_catch` = CASE WHEN `any_fish_encounter_count` = 0 THEN 1 ELSE 0 END
        AND `outcome_class` = CASE
          WHEN `target_encounter_count` > 0 THEN 'target_encountered'
          WHEN `any_fish_encounter_count` > 0 THEN 'non_target_only'
          ELSE 'no_fish'
        END
        AND `taxon_observations_json` = CASE
          WHEN `other_catch_count` > 0 THEN json_array(
            json_object(
              'taxon_id', 'california-halibut',
              'encounter_count', `target_encounter_count`,
              'retained_count', `keeper_count`,
              'released_count', `short_released_count`,
              'disposition_unknown_count', 0,
              'identification_confidence', `target_identification_confidence`,
              'identification_basis', CASE WHEN `target_encounter_count` > 0 THEN 'angler-report' ELSE 'not-observed' END
            ),
            json_object(
              'taxon_id', 'unresolved-fish',
              'encounter_count', `other_catch_count`,
              'retained_count', 0,
              'released_count', 0,
              'disposition_unknown_count', `other_catch_count`,
              'identification_confidence', 'unresolved',
              'identification_basis', 'unresolved'
            )
          )
          ELSE json_array(json_object(
            'taxon_id', 'california-halibut',
            'encounter_count', `target_encounter_count`,
            'retained_count', `keeper_count`,
            'released_count', `short_released_count`,
            'disposition_unknown_count', 0,
            'identification_confidence', `target_identification_confidence`,
            'identification_basis', CASE WHEN `target_encounter_count` > 0 THEN 'angler-report' ELSE 'not-observed' END
          ))
        END
      )
    )
  );
--> statement-breakpoint

UPDATE `trips`
SET
  `target_taxon_id` = 'california-halibut',
  `contract_status` = 'legacy_unverified',
  `observation_contract_version` = NULL,
  `taxon_catalog_version` = NULL,
  `taxon_observations_json` = NULL,
  `outcome_class` = NULL,
  `target_encounter_count` = NULL,
  `any_fish_encounter_count` = NULL,
  `target_identification_confidence` = NULL;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trips_completed_contract_insert_guard`
BEFORE INSERT ON `trips`
WHEN NEW.`status` = 'completed' AND NEW.`contract_status` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'completed trips require an explicit contract status');
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `trips_completed_contract_update_guard`
BEFORE UPDATE OF `status`, `contract_status` ON `trips`
WHEN NEW.`status` = 'completed' AND NEW.`contract_status` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'completed trips require an explicit contract status');
END;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `trips_contract_target_completed_idx`
  ON `trips` (`contract_status`, `target_taxon_id`, `completed_at`);
