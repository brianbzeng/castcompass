CREATE TABLE IF NOT EXISTS `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `password_salt` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_sessions_user_idx` ON `auth_sessions` (`user_id`,`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `saved_sites` (
  `user_id` text NOT NULL,
  `site_id` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY(`user_id`, `site_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `email_hash` text NOT NULL,
  `attempted_at` text NOT NULL,
  `successful` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_attempts_email_time_idx` ON `auth_attempts` (`email_hash`,`attempted_at`);
