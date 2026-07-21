-- Durable, owner-bound packaging for complete privacy exports.
-- Queue payloads contain only the opaque job ID. Export contents stay in D1
-- until the consumer writes a short-lived object to the private export bucket.
CREATE TABLE `privacy_export_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text,
  `owner_subject_hash` text NOT NULL,
  `state` text NOT NULL,
  `attempts` integer NOT NULL DEFAULT 0,
  `available_at` text NOT NULL,
  `lease_expires_at` text,
  `lease_token` text,
  `object_key` text,
  `object_key_hash` text,
  `content_sha256` text,
  `size_bytes` integer,
  `record_count` integer,
  `last_error_code` text,
  `requested_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  `expires_at` text,
  CONSTRAINT `privacy_export_jobs_state_check`
    CHECK (`state` in ('pending', 'queued', 'processing', 'retry', 'completed', 'canceled', 'expired', 'needs_attention')),
  CONSTRAINT `privacy_export_jobs_attempts_check`
    CHECK (`attempts` >= 0 AND `attempts` <= 5),
  CONSTRAINT `privacy_export_jobs_locator_check`
    CHECK ((`object_key` IS NULL AND `object_key_hash` IS NULL)
      OR (`object_key` IS NOT NULL AND `object_key_hash` IS NOT NULL)),
  CONSTRAINT `privacy_export_jobs_completed_check`
    CHECK (`state` != 'completed'
      OR (`user_id` IS NOT NULL AND `object_key` IS NOT NULL
        AND `content_sha256` IS NOT NULL AND `size_bytes` IS NOT NULL
        AND `record_count` IS NOT NULL AND `completed_at` IS NOT NULL AND `expires_at` IS NOT NULL)),
  CONSTRAINT `privacy_export_jobs_expired_check`
    CHECK (`state` != 'expired' OR (`user_id` IS NULL AND `object_key` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `privacy_export_jobs_active_user_unique`
  ON `privacy_export_jobs` (`user_id`)
  WHERE `user_id` IS NOT NULL
    AND `state` in ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention');
--> statement-breakpoint
CREATE UNIQUE INDEX `privacy_export_jobs_object_key_unique`
  ON `privacy_export_jobs` (`object_key`)
  WHERE `object_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `privacy_export_jobs_dispatch_idx`
  ON `privacy_export_jobs` (`state`, `available_at`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `privacy_export_jobs_expiry_idx`
  ON `privacy_export_jobs` (`state`, `expires_at`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `privacy_export_jobs_owner_idx`
  ON `privacy_export_jobs` (`owner_subject_hash`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `privacy_deletion_tasks`
  ADD COLUMN `object_store` text NOT NULL DEFAULT 'trip_photos'
  CONSTRAINT `privacy_deletion_tasks_object_store_check`
    CHECK (`object_store` in ('trip_photos', 'privacy_exports'));
--> statement-breakpoint
CREATE INDEX `privacy_deletion_tasks_store_retry_idx`
  ON `privacy_deletion_tasks` (`object_store`, `state`, `available_at`, `lease_expires_at`);
