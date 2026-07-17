-- Workload-backed indexes for retention, account history, advisory review, and
-- privacy cascade enforcement. Keep this list synchronized with the runtime
-- bootstrap statements and scripts/check_d1_query_plans.py.

CREATE INDEX IF NOT EXISTS `auth_sessions_expires_idx`
  ON `auth_sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `saved_sites_user_created_idx`
  ON `saved_sites` (`user_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_attempts_attempted_idx`
  ON `auth_attempts` (`attempted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `email_challenges_expires_idx`
  ON `email_challenges` (`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `email_challenges_user_idx`
  ON `email_challenges` (`user_id`)
  WHERE `user_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `signup_age_proofs_consumed_idx`
  ON `signup_age_proofs` (`consumed_at`)
  WHERE `consumed_at` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `privacy_deletion_jobs_scope_subject_idx`
  ON `privacy_deletion_jobs` (`scope`, `subject_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `privacy_deletion_jobs_state_completed_idx`
  ON `privacy_deletion_jobs` (`state`, `completed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trips_user_history_idx`
  ON `trips` (`user_id`, COALESCE(`completed_at`, `ended_at`, `started_at`) DESC)
  WHERE `status` = 'completed' AND `user_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trips_user_created_idx`
  ON `trips` (`user_id`, `created_at` DESC)
  WHERE `user_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trips_ai_review_backlog_idx`
  ON `trips` (`status`, COALESCE(`completed_at`, `ended_at`, `started_at`))
  WHERE `ai_review_status` IS NULL OR `ai_review_status` = 'retry';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trips_reporter_active_created_idx`
  ON `trips` (`reporter_key_hash`, `created_at`)
  WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trip_validation_provenance_forecast_trip_idx`
  ON `trip_validation_provenance` (`forecast_impression_id`, `trip_id`)
  WHERE `forecast_impression_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `validation_feasibility_recruitment_user_sequence_idx`
  ON `validation_feasibility_recruitment_events` (`user_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `validation_feasibility_correction_activation_sequence_idx`
  ON `validation_feasibility_corrections` (`activation_id`, `sequence`);
