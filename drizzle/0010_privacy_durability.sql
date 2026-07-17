CREATE TABLE IF NOT EXISTS `signup_age_proofs` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`confirmed_at` text NOT NULL,
	`gate_version` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `signup_age_proofs_expiry_idx` ON `signup_age_proofs` (`expires_at`,`consumed_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `privacy_deletion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_hash` text NOT NULL,
	`scope` text NOT NULL,
	`subject_hash` text NOT NULL,
	`owner_subject_hash` text NOT NULL,
	`state` text NOT NULL,
	`objects_total` integer DEFAULT 0 NOT NULL,
	`objects_deleted` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`requested_at` text NOT NULL,
	`active_data_removed_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `privacy_deletion_jobs_scope_check` CHECK(`privacy_deletion_jobs`.`scope` in ('account', 'trip')),
	CONSTRAINT `privacy_deletion_jobs_state_check` CHECK(`privacy_deletion_jobs`.`state` in ('active_data_removed', 'purging', 'completed', 'needs_attention'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `privacy_deletion_jobs_receipt_unique` ON `privacy_deletion_jobs` (`receipt_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `privacy_deletion_jobs_state_updated_idx` ON `privacy_deletion_jobs` (`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `privacy_deletion_jobs_owner_state_idx` ON `privacy_deletion_jobs` (`owner_subject_hash`,`state`,`updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `privacy_deletion_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`object_key` text,
	`object_key_hash` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`lease_expires_at` text,
	`lease_token` text,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `privacy_deletion_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `privacy_deletion_tasks_state_check` CHECK(`privacy_deletion_tasks`.`state` in ('pending', 'leased', 'completed', 'needs_attention')),
	CONSTRAINT `privacy_deletion_tasks_locator_check` CHECK((`privacy_deletion_tasks`.`state` = 'completed' AND `privacy_deletion_tasks`.`object_key` IS NULL) OR (`privacy_deletion_tasks`.`state` != 'completed' AND `privacy_deletion_tasks`.`object_key` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `privacy_deletion_tasks_job_object_unique` ON `privacy_deletion_tasks` (`job_id`,`object_key_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `privacy_deletion_tasks_retry_idx` ON `privacy_deletion_tasks` (`state`,`available_at`,`lease_expires_at`);
