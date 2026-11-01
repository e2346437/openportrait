CREATE TABLE `gallery_visitor` (
	`gallery_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`gallery_id`, `email`),
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `gallery` ADD `registration` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery` ADD `welcome_message` text;