DROP INDEX IF EXISTS `idx_messages_channel_unread`;--> statement-breakpoint
CREATE INDEX `idx_messages_channel_unread` ON `messages` (`channel_id`,CAST(id AS INTEGER),`user_id`,`type`);
