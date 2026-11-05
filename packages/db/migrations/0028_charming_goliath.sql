ALTER TABLE `gallery` ADD `checked_out_at` integer;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_folders` text;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_return_days` integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_prev` text;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_total_files` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_total_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_ready_at` integer;