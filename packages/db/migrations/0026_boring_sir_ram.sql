CREATE TABLE `shoot_run_item` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_id` text NOT NULL,
	`start_minutes` integer NOT NULL,
	`duration_minutes` integer,
	`title` text NOT NULL,
	`location` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shoot_run_item_shoot_idx` ON `shoot_run_item` (`shoot_id`,`start_minutes`);