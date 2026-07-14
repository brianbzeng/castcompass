CREATE TABLE `site_discussion_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`site_id` text NOT NULL,
	`summary` text NOT NULL,
	`gear_summary` text,
	`technique_tags_json` text,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`review_model` text,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_discussion_posts_trip_unique` ON `site_discussion_posts` (`trip_id`);
--> statement-breakpoint
CREATE INDEX `site_discussion_posts_site_time_idx` ON `site_discussion_posts` (`site_id`,`observed_at`);
