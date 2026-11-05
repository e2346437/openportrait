ALTER TABLE `shoot` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `shoot` ADD `kind` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `shoot` ADD `bill_to` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `shoot` ADD `show_on_master` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `shoot_parent_idx` ON `shoot` (`parent_id`);