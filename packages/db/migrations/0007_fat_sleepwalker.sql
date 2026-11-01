CREATE TABLE `camera_account` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`public_key` text,
	`folder` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_login_at` integer,
	`last_upload_at` integer,
	`files_received` integer DEFAULT 0 NOT NULL,
	`bytes_received` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camera_account_username_unique` ON `camera_account` (`username`);