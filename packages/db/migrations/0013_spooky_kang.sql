CREATE TABLE `contract` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text,
	`contact_id` text NOT NULL,
	`shoot_id` text,
	`order_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`token` text NOT NULL,
	`sent_at` integer,
	`viewed_at` integer,
	`signed_at` integer,
	`signer_name` text,
	`signer_email` text,
	`sign_method` text,
	`signature_image` text,
	`signer_ip` text,
	`signer_user_agent` text,
	`consent_text` text,
	`countersigned_at` integer,
	`countersigned_by` text,
	`voided_at` integer,
	`pdf_path` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_token_idx` ON `contract` (`token`);--> statement-breakpoint
CREATE INDEX `contract_contact_idx` ON `contract` (`contact_id`);--> statement-breakpoint
CREATE INDEX `contract_shoot_idx` ON `contract` (`shoot_id`);--> statement-breakpoint
CREATE INDEX `contract_status_idx` ON `contract` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `contract_template` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
