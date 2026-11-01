CREATE TABLE `download_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gallery_id` text NOT NULL,
	`photo_id` text,
	`scope` text NOT NULL,
	`variant` text NOT NULL,
	`client_email` text,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `download_event_idx` ON `download_event` (`gallery_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `favorite_item` (
	`selection_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`selection_id`, `photo_id`),
	FOREIGN KEY (`selection_id`) REFERENCES `favorite_selection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `favorite_list` (
	`id` text PRIMARY KEY NOT NULL,
	`gallery_id` text NOT NULL,
	`name` text NOT NULL,
	`max_count` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `favorite_selection` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`client_email` text NOT NULL,
	`submitted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `favorite_list`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `favorite_selection_idx` ON `favorite_selection` (`list_id`,`client_email`);--> statement-breakpoint
CREATE TABLE `gallery` (
	`id` text PRIMARY KEY NOT NULL,
	`shoot_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`shoot_folder` text NOT NULL,
	`folder_path` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_missing` integer DEFAULT false NOT NULL,
	`cover_photo_id` text,
	`cover_focal_x` real DEFAULT 50 NOT NULL,
	`cover_focal_y` real DEFAULT 50 NOT NULL,
	`design` text,
	`access_mode` text DEFAULT 'link' NOT NULL,
	`password_hash` text,
	`download_size` text DEFAULT 'full' NOT NULL,
	`download_lock` text DEFAULT 'none' NOT NULL,
	`unlocked_at` integer,
	`expires_at` integer,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_slug_idx` ON `gallery` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_folder_idx` ON `gallery` (`shoot_folder`);--> statement-breakpoint
CREATE TABLE `gallery_set` (
	`id` text PRIMARY KEY NOT NULL,
	`gallery_id` text NOT NULL,
	`name` text NOT NULL,
	`folder_name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`early_download` integer DEFAULT false NOT NULL,
	`cover_photo_id` text,
	`cover_focal_x` real DEFAULT 50 NOT NULL,
	`cover_focal_y` real DEFAULT 50 NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_set_folder_idx` ON `gallery_set` (`gallery_id`,`folder_name`);--> statement-breakpoint
CREATE TABLE `gallery_view` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gallery_id` text NOT NULL,
	`client_email` text,
	`ip_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gallery_view_idx` ON `gallery_view` (`gallery_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ingest_folder` (
	`id` text PRIMARY KEY NOT NULL,
	`rel_path` text NOT NULL,
	`state` text DEFAULT 'unmatched' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`taken_from` integer,
	`taken_to` integer,
	`sample_files` text DEFAULT '[]' NOT NULL,
	`stable` integer DEFAULT false NOT NULL,
	`first_seen_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_change_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`gallery_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingest_folder_path_idx` ON `ingest_folder` (`rel_path`);--> statement-breakpoint
CREATE TABLE `photo` (
	`id` text PRIMARY KEY NOT NULL,
	`gallery_id` text NOT NULL,
	`set_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`filename` text NOT NULL,
	`content_hash` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`width` integer,
	`height` integer,
	`taken_at` integer,
	`exif` text,
	`placeholder` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`missing_since` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_id`) REFERENCES `gallery_set`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_path_idx` ON `photo` (`rel_path`);--> statement-breakpoint
CREATE INDEX `photo_gallery_idx` ON `photo` (`gallery_id`,`set_id`,`sort`);--> statement-breakpoint
CREATE INDEX `photo_hash_idx` ON `photo` (`gallery_id`,`content_hash`);