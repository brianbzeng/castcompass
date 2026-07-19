-- Durable outbox, lease, retry, and attention state for advisory AI review.
-- Queue messages carry only the opaque job ID; trip/account content remains in D1.
CREATE TABLE `ai_review_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `trip_id` text NOT NULL,
  `state` text NOT NULL,
  `attempts` integer NOT NULL DEFAULT 0,
  `available_at` text NOT NULL,
  `lease_expires_at` text,
  `last_error_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `ai_review_jobs_state_check`
    CHECK (`state` in ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')),
  CONSTRAINT `ai_review_jobs_attempts_check` CHECK (`attempts` >= 0 AND `attempts` <= 5),
  CONSTRAINT `ai_review_jobs_terminal_check` CHECK (
    (`state` = 'completed' AND `completed_at` IS NOT NULL)
    OR (`state` != 'completed' AND `completed_at` IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_review_jobs_trip_unique`
  ON `ai_review_jobs` (`trip_id`);
--> statement-breakpoint
CREATE INDEX `ai_review_jobs_dispatch_idx`
  ON `ai_review_jobs` (`state`, `available_at`, `lease_expires_at`);
