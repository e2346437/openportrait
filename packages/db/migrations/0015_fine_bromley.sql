CREATE TABLE `import_record` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`external_key` text NOT NULL,
	`entity_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_record_key_idx` ON `import_record` (`source`,`kind`,`external_key`);--> statement-breakpoint
CREATE INDEX `import_record_batch_idx` ON `import_record` (`batch_id`);