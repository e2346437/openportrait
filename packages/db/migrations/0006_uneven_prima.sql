CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`to_address` text NOT NULL,
	`to_name` text,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`body_html` text,
	`kind` text DEFAULT 'other' NOT NULL,
	`contact_id` text,
	`shoot_id` text,
	`gallery_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `email_log_created_idx` ON `email_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `email_log_contact_idx` ON `email_log` (`contact_id`);--> statement-breakpoint
CREATE INDEX `email_log_gallery_idx` ON `email_log` (`gallery_id`);--> statement-breakpoint
CREATE TABLE `scheduler` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`duration_minutes` integer DEFAULT 30 NOT NULL,
	`buffer_before_minutes` integer DEFAULT 0 NOT NULL,
	`buffer_after_minutes` integer DEFAULT 0 NOT NULL,
	`min_notice_hours` integer DEFAULT 12 NOT NULL,
	`max_days_ahead` integer DEFAULT 60 NOT NULL,
	`step_minutes` integer DEFAULT 30 NOT NULL,
	`location` text,
	`shoot_type_id` text,
	`approval` text DEFAULT 'manual' NOT NULL,
	`availability` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`shoot_type_id`) REFERENCES `shoot_type`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_slug_idx` ON `scheduler` (`slug`);--> statement-breakpoint
CREATE TABLE `scheduler_booking` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduler_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`lead_id` text,
	`entry_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`scheduler_id`) REFERENCES `scheduler`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_id`) REFERENCES `lead`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entry_id`) REFERENCES `calendar_entry`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scheduler_booking_start_idx` ON `scheduler_booking` (`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_booking_token_idx` ON `scheduler_booking` (`token`);