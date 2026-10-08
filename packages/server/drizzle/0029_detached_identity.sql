ALTER TABLE `users` ADD `detached_home_instance` text;--> statement-breakpoint
ALTER TABLE `users` ADD `detached_home_user_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_detached_home_user_id` ON `users` (`detached_home_user_id`);