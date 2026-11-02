CREATE TABLE `questionnaire` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`template_id` text,
	`title` text NOT NULL,
	`intro` text,
	`fields` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`token` text NOT NULL,
	`answers` text,
	`sent_at` integer,
	`viewed_at` integer,
	`submitted_at` integer,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questionnaire_token_idx` ON `questionnaire` (`token`);--> statement-breakpoint
CREATE INDEX `questionnaire_shoot_idx` ON `questionnaire` (`shoot_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `questionnaire_template` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`intro` text,
	`fields` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `shoot_type_questionnaire` (
	`shoot_type_id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`send_mode` text DEFAULT 'manual' NOT NULL,
	FOREIGN KEY (`shoot_type_id`) REFERENCES `shoot_type`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `questionnaire_template`(`id`) ON UPDATE no action ON DELETE cascade
);
