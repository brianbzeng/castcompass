ALTER TABLE `validation_feasibility_recruitment_events`
  ADD COLUMN `snapshot_suppression_sha256` text;
--> statement-breakpoint
UPDATE `validation_feasibility_recruitment_events`
SET `snapshot_suppression_sha256` = lower(hex(randomblob(32)))
WHERE `snapshot_suppression_sha256` IS NULL;
--> statement-breakpoint
ALTER TABLE `validation_feasibility_events`
  ADD COLUMN `snapshot_suppression_sha256` text;
--> statement-breakpoint
UPDATE `validation_feasibility_events`
SET `snapshot_suppression_sha256` = lower(hex(randomblob(32)))
WHERE `event_type` = 'started' AND `snapshot_suppression_sha256` IS NULL;
--> statement-breakpoint
UPDATE `validation_feasibility_events` AS `terminal`
SET `snapshot_suppression_sha256` = COALESCE(
  (
    SELECT `started`.`snapshot_suppression_sha256`
    FROM `validation_feasibility_events` AS `started`
    WHERE `started`.`trip_id` = `terminal`.`trip_id`
      AND `started`.`event_type` = 'started'
    LIMIT 1
  ),
  lower(hex(randomblob(32)))
)
WHERE `terminal`.`event_type` != 'started' AND `terminal`.`snapshot_suppression_sha256` IS NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_recruitment_snapshot_suppression_guard`
BEFORE INSERT ON `validation_feasibility_recruitment_events`
WHEN NEW.`snapshot_suppression_sha256` IS NULL
  OR length(NEW.`snapshot_suppression_sha256`) != 64
  OR NEW.`snapshot_suppression_sha256` GLOB '*[^a-f0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility recruitment lacks a snapshot suppression digest');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_event_snapshot_suppression_guard`
BEFORE INSERT ON `validation_feasibility_events`
WHEN NEW.`snapshot_suppression_sha256` IS NULL
  OR length(NEW.`snapshot_suppression_sha256`) != 64
  OR NEW.`snapshot_suppression_sha256` GLOB '*[^a-f0-9]*'
  OR (
    NEW.`event_type` != 'started'
    AND NOT EXISTS (
      SELECT 1 FROM `validation_feasibility_events` AS `started`
      WHERE `started`.`trip_id` = NEW.`trip_id`
        AND `started`.`event_type` = 'started'
        AND `started`.`snapshot_suppression_sha256` = NEW.`snapshot_suppression_sha256`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility event lacks a valid snapshot suppression digest');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `validation_feasibility_snapshot_suppressions` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `suppression_id` text NOT NULL,
  `activation_id` text NOT NULL,
  `suppression_kind` text NOT NULL,
  `suppression_subject_sha256` text NOT NULL,
  `suppressed_event_type` text NOT NULL,
  `source_event_sha256` text NOT NULL,
  `removed_at` text NOT NULL,
  FOREIGN KEY (`activation_id`) REFERENCES `validation_feasibility_activations` (`id`) ON DELETE restrict,
  CONSTRAINT `validation_feasibility_snapshot_suppression_identity_check` CHECK (
    `suppression_id` GLOB 'fsuppress_*'
    AND length(`suppression_id`) = 42
    AND substr(`suppression_id`, 11) NOT GLOB '*[^a-f0-9]*'
    AND length(`suppression_subject_sha256`) = 64
    AND `suppression_subject_sha256` NOT GLOB '*[^a-f0-9]*'
    AND length(`source_event_sha256`) = 64
    AND `source_event_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CONSTRAINT `validation_feasibility_snapshot_suppression_kind_check` CHECK (
    (`suppression_kind` = 'participant' AND `suppressed_event_type` = 'participant')
    OR (`suppression_kind` = 'trip'
      AND `suppressed_event_type` IN ('started', 'completed', 'safe_canceled'))
  ),
  CONSTRAINT `validation_feasibility_snapshot_suppression_time_check` CHECK (
    length(`removed_at`) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', `removed_at`) = `removed_at`
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_snapshot_suppression_id_unique`
  ON `validation_feasibility_snapshot_suppressions` (`suppression_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_snapshot_suppression_subject_event_unique`
  ON `validation_feasibility_snapshot_suppressions`
    (`activation_id`, `suppression_kind`, `suppression_subject_sha256`, `suppressed_event_type`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `validation_feasibility_snapshot_suppression_source_event_unique`
  ON `validation_feasibility_snapshot_suppressions`
    (`activation_id`, `suppression_kind`, `suppressed_event_type`, `source_event_sha256`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_snapshot_suppression_insert_guard`
BEFORE INSERT ON `validation_feasibility_snapshot_suppressions`
WHEN abs((julianday(NEW.`removed_at`) - julianday('now')) * 86400.0) > 5.0
  OR (
    NEW.`suppression_kind` = 'participant'
    AND EXISTS (
      SELECT 1 FROM `validation_feasibility_recruitment_events` AS `recruitment`
      WHERE `recruitment`.`activation_id` = NEW.`activation_id`
        AND `recruitment`.`snapshot_suppression_sha256` = NEW.`suppression_subject_sha256`
        AND `recruitment`.`event_sha256` = NEW.`source_event_sha256`
    )
  )
  OR (
    NEW.`suppression_kind` = 'trip'
    AND EXISTS (
      SELECT 1 FROM `validation_feasibility_events` AS `event`
      WHERE `event`.`activation_id` = NEW.`activation_id`
        AND `event`.`event_type` = NEW.`suppressed_event_type`
        AND `event`.`snapshot_suppression_sha256` = NEW.`suppression_subject_sha256`
        AND `event`.`event_sha256` = NEW.`source_event_sha256`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility snapshot suppression lacks a server-observed deletion');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_snapshot_suppression_update_guard`
BEFORE UPDATE ON `validation_feasibility_snapshot_suppressions`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility snapshot suppressions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_snapshot_suppression_delete_guard`
BEFORE DELETE ON `validation_feasibility_snapshot_suppressions`
BEGIN
  SELECT RAISE(ABORT, 'validation feasibility snapshot suppressions outlive retained snapshots');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_recruitment_snapshot_suppression_capture`
AFTER DELETE ON `validation_feasibility_recruitment_events`
BEGIN
  INSERT OR IGNORE INTO `validation_feasibility_snapshot_suppressions` (
    `suppression_id`, `activation_id`, `suppression_kind`, `suppression_subject_sha256`,
    `suppressed_event_type`, `source_event_sha256`, `removed_at`
  ) VALUES (
    'fsuppress_' || lower(hex(randomblob(16))), OLD.`activation_id`, 'participant',
    OLD.`snapshot_suppression_sha256`, 'participant', OLD.`event_sha256`,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `validation_feasibility_event_snapshot_suppression_capture`
AFTER DELETE ON `validation_feasibility_events`
BEGIN
  INSERT OR IGNORE INTO `validation_feasibility_snapshot_suppressions` (
    `suppression_id`, `activation_id`, `suppression_kind`, `suppression_subject_sha256`,
    `suppressed_event_type`, `source_event_sha256`, `removed_at`
  ) VALUES (
    'fsuppress_' || lower(hex(randomblob(16))), OLD.`activation_id`, 'trip',
    OLD.`snapshot_suppression_sha256`, OLD.`event_type`, OLD.`event_sha256`,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;
