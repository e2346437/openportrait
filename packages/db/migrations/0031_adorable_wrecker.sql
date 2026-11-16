ALTER TABLE `ai_approval` ADD `binding` text;--> statement-breakpoint
UPDATE `ai_approval` SET `status` = 'expired', `decided_at` = cast(unixepoch('subsec') * 1000 as integer), `result` = '{"error":"This request was queued before approvals were tied to the exact action and details, so it expired. Ask again."}' WHERE `status` = 'pending' AND `binding` IS NULL;
