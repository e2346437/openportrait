CREATE TABLE `gallery_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`gallery_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`restored_at` integer,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gallery_archive_gallery_idx` ON `gallery_archive` (`gallery_id`);--> statement-breakpoint
ALTER TABLE `gallery` ADD `expiry_reminder_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `archived_at` integer;