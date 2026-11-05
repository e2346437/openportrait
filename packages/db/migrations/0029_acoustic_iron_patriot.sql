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
CREATE UNIQUE INDEX `master_access_parentId_unique` ON `master_access` (`parent_id`);--> statement-breakpoint
CREATE TABLE `shoot_cost` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_id` text NOT NULL,
	`label` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shoot_cost_shoot_idx` ON `shoot_cost` (`shoot_id`,`position`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `subject_mark_path_idx` ON `subject_mark` (`parent_id`,`path`);--> statement-breakpoint
ALTER TABLE `shoot` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `shoot` ADD `kind` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `shoot` ADD `bill_to` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `shoot` ADD `show_on_master` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `shoot` ADD `headcount` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `shoot_parent_idx` ON `shoot` (`parent_id`);