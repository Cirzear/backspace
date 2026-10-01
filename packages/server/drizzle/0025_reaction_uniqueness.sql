-- Legacy races and replayed adds could create several votes for the same actor.
-- Keep the first recorded reaction; text ID order makes timestamp ties deterministic.
DELETE FROM `reactions`
WHERE `id` IN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (
      PARTITION BY `message_id`, `user_id`, `emoji`
      ORDER BY `created_at` ASC, `id` ASC
    ) AS `duplicate_rank`
    FROM `reactions`
  )
  WHERE `duplicate_rank` > 1
);
--> statement-breakpoint
DELETE FROM `dm_reactions`
WHERE `id` IN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (
      PARTITION BY `dm_message_id`, `user_id`, `emoji`
      ORDER BY `created_at` ASC, `id` ASC
    ) AS `duplicate_rank`
    FROM `dm_reactions`
  )
  WHERE `duplicate_rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reactions_message_user_emoji` ON `reactions` (`message_id`,`user_id`,`emoji`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dm_reactions_message_user_emoji` ON `dm_reactions` (`dm_message_id`,`user_id`,`emoji`);
