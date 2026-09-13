DROP INDEX IF EXISTS `idx_system_audit_logs_target`;
DROP INDEX IF EXISTS `idx_system_audit_logs_created`;
DROP TABLE IF EXISTS `system_audit_logs`;
DROP INDEX IF EXISTS `idx_users_status`;
DROP INDEX IF EXISTS `idx_users_system_role`;
-- SQLite/D1 does not safely drop these users columns in place. Preserve data and
-- rebuild the users table from a backup when a full rollback is required.
