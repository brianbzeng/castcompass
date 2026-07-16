ALTER TABLE `users` ADD `age_eligibility_confirmed_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `terms_accepted_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `terms_version` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `privacy_accepted_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `privacy_version` text;
--> statement-breakpoint
ALTER TABLE `email_challenges` ADD `age_eligibility_confirmed_at` text;
--> statement-breakpoint
ALTER TABLE `email_challenges` ADD `terms_version` text;
--> statement-breakpoint
ALTER TABLE `email_challenges` ADD `privacy_version` text;
