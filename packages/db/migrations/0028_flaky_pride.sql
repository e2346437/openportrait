CREATE TABLE `subject_mark` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`child_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subject_mark_parent_idx` ON `subject_mark` (`parent_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `subject_mark_path_idx` ON `subject_mark` (`parent_id`,`path`);