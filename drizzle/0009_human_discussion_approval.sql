-- 0008 is intentionally reserved for the in-progress API rate-limit migration.
-- Existing discussion rows remain unapproved and therefore fail closed.
ALTER TABLE `site_discussion_posts` ADD COLUMN `approved_at` text;
--> statement-breakpoint
ALTER TABLE `site_discussion_posts` ADD COLUMN `approved_by` text;
--> statement-breakpoint
ALTER TABLE `site_discussion_posts` ADD COLUMN `source_ai_reviewed_at` text;
