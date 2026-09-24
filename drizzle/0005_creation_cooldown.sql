CREATE TABLE `action_rate_limit` (
  `id` text PRIMARY KEY NOT NULL,
  `actor_key` text NOT NULL,
  `user_id` text REFERENCES `users`(`id`) ON DELETE cascade,
  `family_id` text,
  `family_key` text DEFAULT '' NOT NULL,
  `action_type` text NOT NULL,
  `target_id` text,
  `last_success_at` text NOT NULL
);

CREATE UNIQUE INDEX `idx_action_rate_limit_scope`
ON `action_rate_limit` (`actor_key`,`family_key`,`action_type`);

CREATE INDEX `idx_action_rate_limit_success`
ON `action_rate_limit` (`last_success_at`);

CREATE TABLE `action_idempotency` (
  `id` text PRIMARY KEY NOT NULL,
  `actor_key` text NOT NULL,
  `family_key` text DEFAULT '' NOT NULL,
  `action_type` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL,
  `response_json` text,
  `created_at` text NOT NULL,
  `completed_at` text
);

CREATE UNIQUE INDEX `idx_action_idempotency_key`
ON `action_idempotency` (`actor_key`,`family_key`,`action_type`,`idempotency_key`);

CREATE INDEX `idx_action_idempotency_created`
ON `action_idempotency` (`created_at`);

PRAGMA optimize;
