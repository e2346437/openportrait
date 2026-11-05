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
ALTER TABLE `shoot` ADD `headcount` integer DEFAULT 1 NOT NULL;