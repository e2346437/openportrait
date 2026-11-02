CREATE TABLE `coupon` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`item_id` text,
	`expires_on` text,
	`max_uses` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_code_idx` ON `coupon` (`code`);--> statement-breakpoint
CREATE TABLE `credit_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`order_id` text,
	`actor_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `credit_entry_contact_idx` ON `credit_entry` (`contact_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `order` ADD `coupon_id` text;--> statement-breakpoint
ALTER TABLE `order` ADD `coupon_code` text;--> statement-breakpoint
ALTER TABLE `order` ADD `coupon_cents` integer DEFAULT 0 NOT NULL;