PRAGMA foreign_keys=ON;

CREATE TABLE `user_identities` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('PHONE','WECHAT_WEB','WECHAT_MINI')),
  `provider_app_id` text,
  `provider_user_id` text NOT NULL,
  `union_id` text,
  `union_scope` text,
  `verified_at` text,
  `created_at` text NOT NULL,
  `last_login_at` text,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CHECK (
    (`provider` = 'PHONE' AND `provider_app_id` IS NULL AND `union_id` IS NULL AND `union_scope` IS NULL AND `verified_at` IS NOT NULL)
    OR
    (`provider` IN ('WECHAT_WEB','WECHAT_MINI') AND `provider_app_id` IS NOT NULL AND `provider_app_id` != '')
  )
);

CREATE UNIQUE INDEX `idx_user_identities_phone_unique`
ON `user_identities` (`provider_user_id`)
WHERE `provider` = 'PHONE';

CREATE UNIQUE INDEX `idx_user_identities_wechat_unique`
ON `user_identities` (`provider`,`provider_app_id`,`provider_user_id`)
WHERE `provider` IN ('WECHAT_WEB','WECHAT_MINI');

CREATE INDEX `idx_user_identities_user`
ON `user_identities` (`user_id`);

CREATE INDEX `idx_user_identities_union`
ON `user_identities` (`union_scope`,`union_id`)
WHERE `union_id` IS NOT NULL AND `union_id` != '';

CREATE TABLE `sms_verifications` (
  `id` text PRIMARY KEY NOT NULL,
  `phone_e164` text NOT NULL,
  `purpose` text NOT NULL CHECK (`purpose` IN ('REGISTER','LOGIN','RESET_PASSWORD','BIND_PHONE','CHANGE_PHONE')),
  `code_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
  `max_attempts` integer NOT NULL DEFAULT 5 CHECK (`max_attempts` > 0),
  `used_at` text,
  `created_at` text NOT NULL,
  `requested_ip_hash` text
);

CREATE INDEX `idx_sms_verifications_phone_purpose_created`
ON `sms_verifications` (`phone_e164`,`purpose`,`created_at`);

CREATE INDEX `idx_sms_verifications_expires`
ON `sms_verifications` (`expires_at`);

-- Only already-verified, already-normalized E.164 values are safe to backfill.
-- Local-format phone numbers are deliberately skipped because users has no country field.
INSERT INTO `user_identities`
  (`id`,`user_id`,`provider`,`provider_app_id`,`provider_user_id`,`union_id`,`union_scope`,`verified_at`,`created_at`,`last_login_at`)
SELECT
  'phone-' || `id`,
  `id`,
  'PHONE',
  NULL,
  `phone`,
  NULL,
  NULL,
  `phone_verified_at`,
  COALESCE(`updated_at`,`created_at`),
  `last_login_at`
FROM `users`
WHERE `phone` IS NOT NULL
  AND `phone` != ''
  AND `phone_verified_at` IS NOT NULL
  AND `phone_verified_at` != ''
  AND `phone` GLOB '+[1-9]*'
  AND substr(`phone`,2) NOT GLOB '*[^0-9]*'
  AND length(substr(`phone`,2)) BETWEEN 8 AND 15
  AND NOT EXISTS (
    SELECT 1
    FROM `users` duplicate_user
    WHERE duplicate_user.id != users.id
      AND duplicate_user.phone = users.phone
      AND duplicate_user.phone_verified_at IS NOT NULL
      AND duplicate_user.phone_verified_at != ''
  );

PRAGMA optimize;
