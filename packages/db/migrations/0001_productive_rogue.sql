CREATE TABLE `ai_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text DEFAULT 'token' NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`level` text DEFAULT 'read' NOT NULL,
	`areas` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_connection_tokenHash_unique` ON `ai_connection` (`token_hash`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `actor_type` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `connection_id` text;