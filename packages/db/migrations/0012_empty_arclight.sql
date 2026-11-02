ALTER TABLE `scheduler` ADD `price_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduler` ADD `deposit_type` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduler` ADD `deposit_value` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduler_booking` ADD `order_id` text;--> statement-breakpoint
ALTER TABLE `coupon` ADD `scheduler_id` text;