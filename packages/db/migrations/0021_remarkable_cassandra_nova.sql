ALTER TABLE `user` ADD `totp_secret` text;--> statement-breakpoint
ALTER TABLE `user` ADD `totp_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `recovery_codes` text;