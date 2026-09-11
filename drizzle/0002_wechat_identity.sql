ALTER TABLE `users` ADD COLUMN `wechat_openid` text;
ALTER TABLE `users` ADD COLUMN `wechat_unionid` text;
ALTER TABLE `users` ADD COLUMN `phone_verified_at` text;

CREATE UNIQUE INDEX `idx_users_wechat_openid_unique`
ON `users` (`wechat_openid`)
WHERE `wechat_openid` IS NOT NULL AND `wechat_openid` != '';

CREATE UNIQUE INDEX `idx_users_wechat_unionid_unique`
ON `users` (`wechat_unionid`)
WHERE `wechat_unionid` IS NOT NULL AND `wechat_unionid` != '';
