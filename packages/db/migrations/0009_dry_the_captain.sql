CREATE TABLE `catalog_item` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'item' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `catalog_item_kind_idx` ON `catalog_item` (`kind`,`position`);--> statement-breakpoint
CREATE TABLE `counter` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`quote_number` integer,
	`invoice_number` integer,
	`contact_id` text NOT NULL,
	`shoot_id` text,
	`lead_id` text,
	`title` text NOT NULL,
	`intro` text,
	`terms` text,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`tax_bps` integer DEFAULT 0 NOT NULL,
	`valid_until` text,
	`token` text NOT NULL,
	`sent_at` integer,
	`viewed_at` integer,
	`accepted_at` integer,
	`accepted_name` text,
	`accepted_ip` text,
	`declined_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_token_idx` ON `order` (`token`);--> statement-breakpoint
CREATE INDEX `order_contact_idx` ON `order` (`contact_id`);--> statement-breakpoint
CREATE INDEX `order_shoot_idx` ON `order` (`shoot_id`);--> statement-breakpoint
CREATE INDEX `order_kind_status_idx` ON `order` (`kind`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_line` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_id` text,
	`description` text NOT NULL,
	`detail` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_cents` integer NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_line_order_idx` ON `order_line` (`order_id`,`position`);--> statement-breakpoint
CREATE TABLE `payment` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`provider` text DEFAULT 'manual' NOT NULL,
	`provider_ref` text,
	`note` text,
	`paid_at` integer NOT NULL,
	`recorded_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `payment_order_idx` ON `payment` (`order_id`,`paid_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_provider_ref_idx` ON `payment` (`provider`,`provider_ref`);--> statement-breakpoint
CREATE TABLE `payment_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`due_date` text,
	FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payment_schedule_order_idx` ON `payment_schedule` (`order_id`,`position`);