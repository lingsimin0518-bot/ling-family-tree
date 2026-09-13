ALTER TABLE `users` ADD COLUMN `system_role` text NOT NULL DEFAULT 'USER'
  CHECK (`system_role` IN ('USER','SUPER_ADMIN'));
ALTER TABLE `users` ADD COLUMN `last_login_at` text;
ALTER TABLE `users` ADD COLUMN `disabled_at` text;
ALTER TABLE `users` ADD COLUMN `disabled_by` text;

CREATE INDEX `idx_users_system_role` ON `users` (`system_role`);
CREATE INDEX `idx_users_status` ON `users` (`status`);

CREATE TABLE `system_audit_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `operator_user_id` text NOT NULL,
  `action_type` text NOT NULL,
  `target_user_id` text,
  `old_value` text,
  `new_value` text,
  `created_at` text NOT NULL,
  `reason` text,
  FOREIGN KEY (`operator_user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`)
);
CREATE INDEX `idx_system_audit_logs_created` ON `system_audit_logs` (`created_at`);
CREATE INDEX `idx_system_audit_logs_target` ON `system_audit_logs` (`target_user_id`);
