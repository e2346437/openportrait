ALTER TABLE `download_event` ADD `file_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `download_max_times` integer;--> statement-breakpoint
ALTER TABLE `gallery` ADD `download_max_files` integer;