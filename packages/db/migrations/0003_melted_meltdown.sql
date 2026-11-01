CREATE TABLE `oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_code` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`label` text NOT NULL,
	`level` text NOT NULL,
	`areas` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_connection` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `ai_connection` ADD `access_expires_at` integer;--> statement-breakpoint
ALTER TABLE `ai_connection` ADD `refresh_hash` text;--> statement-breakpoint
ALTER TABLE `ai_connection` ADD `refresh_prev_hash` text;