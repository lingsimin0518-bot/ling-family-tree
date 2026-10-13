PRAGMA foreign_keys=ON;

CREATE TABLE `phone_change_challenges` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `old_phone_e164` text NOT NULL,
  `token_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `used_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);

CREATE UNIQUE INDEX `idx_phone_change_challenges_token`
ON `phone_change_challenges` (`token_hash`);

CREATE INDEX `idx_phone_change_challenges_user_created`
ON `phone_change_challenges` (`user_id`,`created_at`);

PRAGMA optimize;
