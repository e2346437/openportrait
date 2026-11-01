CREATE TABLE `busy_block` (
	`calendar_id` text NOT NULL,
	`google_event_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `busy_block_pk` ON `busy_block` (`calendar_id`,`google_event_id`);--> statement-breakpoint
CREATE INDEX `busy_block_start_idx` ON `busy_block` (`starts_at`);--> statement-breakpoint
CREATE TABLE `calendar_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`notes` text,
	`contact_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `calendar_entry_start_idx` ON `calendar_entry` (`starts_at`);--> statement-breakpoint
CREATE TABLE `google_calendar` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`sync_token` text,
	`synced_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `google_link` (
	`id` text PRIMARY KEY NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`google_event_id` text NOT NULL,
	`etag` text,
	`pushed_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_link_item_idx` ON `google_link` (`item_type`,`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `google_link_event_idx` ON `google_link` (`calendar_id`,`google_event_id`);