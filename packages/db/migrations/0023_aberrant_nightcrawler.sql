CREATE TABLE `catalog_package_item` (
	`package_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`package_id`, `item_id`),
	FOREIGN KEY (`package_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `catalog_item` ADD `auto_price` integer DEFAULT false NOT NULL;