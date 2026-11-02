ALTER TABLE `scheduler` ADD `max_per_day` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduler` ADD `date_overrides` text DEFAULT '{}' NOT NULL;