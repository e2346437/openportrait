CREATE TABLE `master_access` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`password_hash` text,
	`expires_at` integer,
	`disabled_at` integer,
	`views` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `master_access_parentId_unique` ON `master_access` (`parent_id`);