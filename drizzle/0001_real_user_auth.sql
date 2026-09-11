ALTER TABLE `users` ADD COLUMN `username` text;
ALTER TABLE `users` ADD COLUMN `password_hash` text;
ALTER TABLE `users` ADD COLUMN `phone` text;
ALTER TABLE `users` ADD COLUMN `nickname` text;
ALTER TABLE `users` ADD COLUMN `avatar` text;
ALTER TABLE `users` ADD COLUMN `status` text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE `users` ADD COLUMN `updated_at` text;

CREATE UNIQUE INDEX `idx_users_username_unique`
ON `users` (`username` COLLATE NOCASE)
WHERE `username` IS NOT NULL AND `username` != '';
CREATE UNIQUE INDEX `idx_users_email_unique`
ON `users` (`email` COLLATE NOCASE)
WHERE `email` IS NOT NULL AND `email` != '';
CREATE UNIQUE INDEX `idx_users_phone_unique`
ON `users` (`phone`)
WHERE `phone` IS NOT NULL AND `phone` != '';

CREATE TABLE `user_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `user_agent` text,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_user_sessions_user` ON `user_sessions` (`user_id`);
CREATE INDEX `idx_user_sessions_expires` ON `user_sessions` (`expires_at`);
