CREATE TABLE `notification_settings` (
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`channel_id` text,
	`level` text,
	`muted` integer DEFAULT 0 NOT NULL,
	`muted_until` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_settings_space_row` ON `notification_settings` (`user_id`,`space_id`) WHERE "notification_settings"."channel_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_settings_channel_row` ON `notification_settings` (`user_id`,`channel_id`) WHERE "notification_settings"."channel_id" IS NOT NULL;