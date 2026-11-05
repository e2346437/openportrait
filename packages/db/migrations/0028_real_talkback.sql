CREATE TABLE `raw_file` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_folder` text NOT NULL,
	`rel_path` text NOT NULL,
	`filename` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`remote_key` text,
	`missing_since` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_file_path_idx` ON `raw_file` (`rel_path`);--> statement-breakpoint
CREATE INDEX `raw_file_folder_idx` ON `raw_file` (`shoot_folder`);--> statement-breakpoint
ALTER TABLE `gallery` ADD `storage_originals` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `storage_gallery` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checked_out_at` integer;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_folders` text;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_return_days` integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_prev` text;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_total_files` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_total_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `checkout_ready_at` integer;