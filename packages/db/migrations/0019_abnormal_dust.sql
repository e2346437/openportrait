CREATE TABLE `shoot_task` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_id` text NOT NULL,
	`title` text NOT NULL,
	`due_date` text,
	`done_at` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shoot_task_shoot_idx` ON `shoot_task` (`shoot_id`);--> statement-breakpoint
CREATE INDEX `shoot_task_due_idx` ON `shoot_task` (`done_at`,`due_date`);--> statement-breakpoint
CREATE TABLE `shoot_type_task` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_type_id` text NOT NULL,
	`title` text NOT NULL,
	`due_days` integer,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`shoot_type_id`) REFERENCES `shoot_type`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shoot_type_task_type_idx` ON `shoot_type_task` (`shoot_type_id`);