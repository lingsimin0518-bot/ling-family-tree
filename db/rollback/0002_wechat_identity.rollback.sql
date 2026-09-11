-- Safe rollback for the WeChat identity reservation.
-- D1/SQLite column removal would require rebuilding the users table, so the
-- nullable columns (including phone_verified_at) are retained to avoid risking
-- existing accounts.
DROP INDEX IF EXISTS `idx_users_wechat_unionid_unique`;
DROP INDEX IF EXISTS `idx_users_wechat_openid_unique`;
