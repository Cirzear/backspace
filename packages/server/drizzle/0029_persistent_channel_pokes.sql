DROP INDEX `idx_messages_channel_unread`;--> statement-breakpoint
ALTER TABLE `messages` ADD `type` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_channel_unread` ON `messages` (`channel_id`,CAST(id AS INTEGER),`user_id`,`type`);