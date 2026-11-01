CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` text NOT NULL,
	`lead_id` text,
	`shoot_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`actor_id` text,
	`at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_contact_idx` ON `activity` (`contact_id`,`at`);--> statement-breakpoint
CREATE TABLE `contact` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text,
	`phone` text,
	`company` text,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`region` text,
	`postal_code` text,
	`country` text,
	`source` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `household`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contact_email_idx` ON `contact` (`email`);--> statement-breakpoint
CREATE INDEX `contact_name_idx` ON `contact` (`last_name`,`first_name`);--> statement-breakpoint
CREATE INDEX `contact_household_idx` ON `contact` (`household_id`);--> statement-breakpoint
CREATE TABLE `contact_tag` (
	`contact_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`contact_id`, `tag_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_tag_tag_idx` ON `contact_tag` (`tag_id`);--> statement-breakpoint
CREATE TABLE `household` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`lead_id` text,
	`shoot_id` text,
	`body` text NOT NULL,
	`author_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `note_contact_idx` ON `note` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_unique` ON `tag` (`name`);--> statement-breakpoint
CREATE TABLE `lead` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`shoot_type_id` text,
	`source` text,
	`message` text,
	`event_date` text,
	`lost_reason` text,
	`converted_shoot_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `lead_stage`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shoot_type_id`) REFERENCES `shoot_type`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `lead_stage_idx` ON `lead` (`stage_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `lead_contact_idx` ON `lead` (`contact_id`);--> statement-breakpoint
CREATE TABLE `lead_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shoot` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`shoot_type_id` text NOT NULL,
	`status` text DEFAULT 'booked' NOT NULL,
	`primary_contact_id` text NOT NULL,
	`lead_id` text,
	`folder_path` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`shoot_type_id`) REFERENCES `shoot_type`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`primary_contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shoot_status_idx` ON `shoot` (`status`);--> statement-breakpoint
CREATE INDEX `shoot_contact_idx` ON `shoot` (`primary_contact_id`);--> statement-breakpoint
CREATE INDEX `shoot_folder_idx` ON `shoot` (`folder_path`);--> statement-breakpoint
CREATE TABLE `shoot_contact` (
	`shoot_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`shoot_id`, `contact_id`),
	FOREIGN KEY (`shoot_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `shoot_event` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shoot_event_start_idx` ON `shoot_event` (`starts_at`);--> statement-breakpoint
CREATE INDEX `shoot_event_shoot_idx` ON `shoot_event` (`shoot_id`);--> statement-breakpoint
CREATE TABLE `shoot_type` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`folder_label` text NOT NULL,
	`auto_publish` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`archived_at` integer
);
