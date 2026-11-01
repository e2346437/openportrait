CREATE TABLE `ai_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`tool` text NOT NULL,
	`tier` text NOT NULL,
	`summary` text NOT NULL,
	`args` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`connection_id`) REFERENCES `ai_connection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_approval_status_idx` ON `ai_approval` (`status`,`created_at`);