ALTER TABLE `scheduler` ADD `create_shoot` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduler_booking` ADD `shoot_id` text;