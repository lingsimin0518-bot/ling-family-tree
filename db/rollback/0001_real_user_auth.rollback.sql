-- Emergency rollback for phase 1. The nullable user columns are intentionally
-- retained so rollback never rebuilds or risks existing user/family records.
DROP INDEX IF EXISTS `idx_user_sessions_expires`;
DROP INDEX IF EXISTS `idx_user_sessions_user`;
DROP TABLE IF EXISTS `user_sessions`;
DROP INDEX IF EXISTS `idx_users_phone_unique`;
DROP INDEX IF EXISTS `idx_users_email_unique`;
DROP INDEX IF EXISTS `idx_users_username_unique`;
-- The previous application remains compatible with the retained nullable columns.
