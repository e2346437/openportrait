CREATE TABLE `payment_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_order_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'started' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempt_provider_idx` ON `payment_attempt` (`provider`,`provider_order_id`);--> statement-breakpoint
CREATE INDEX `payment_attempt_order_idx` ON `payment_attempt` (`order_id`);