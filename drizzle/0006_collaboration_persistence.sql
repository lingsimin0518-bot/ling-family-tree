PRAGMA foreign_keys=ON;

CREATE TABLE `family_activities` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL REFERENCES `families`(`id`) ON DELETE CASCADE,
  `author_user_id` text NOT NULL REFERENCES `users`(`id`),
  `title` text NOT NULL,
  `body` text NOT NULL,
  `status` text NOT NULL DEFAULT 'PENDING' CHECK (`status` IN ('PENDING','APPROVED','REJECTED')),
  `reviewer_user_id` text REFERENCES `users`(`id`),
  `created_at` text NOT NULL,
  `reviewed_at` text
);
CREATE INDEX `idx_activities_family_status_created` ON `family_activities` (`family_id`,`status`,`created_at`);

CREATE TABLE `review_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL REFERENCES `families`(`id`) ON DELETE CASCADE,
  `applicant_user_id` text NOT NULL REFERENCES `users`(`id`),
  `reviewer_user_id` text REFERENCES `users`(`id`),
  `request_type` text NOT NULL CHECK (`request_type` IN ('CLAIM_PERSON','CREATE_PERSON','UPDATE_PERSON','FAMILY_ACTIVITY')),
  `target_id` text,
  `old_data` text,
  `new_data` text,
  `reason` text,
  `status` text NOT NULL DEFAULT 'PENDING' CHECK (`status` IN ('PENDING','APPROVED','REJECTED')),
  `created_at` text NOT NULL,
  `reviewed_at` text
);
CREATE INDEX `idx_reviews_family_status_created` ON `review_requests` (`family_id`,`status`,`created_at`);
CREATE UNIQUE INDEX `idx_reviews_type_target` ON `review_requests` (`request_type`,`target_id`) WHERE `target_id` IS NOT NULL AND `request_type` IN ('CLAIM_PERSON','FAMILY_ACTIVITY');

CREATE TABLE `user_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `family_id` text NOT NULL REFERENCES `families`(`id`) ON DELETE CASCADE,
  `message_type` text NOT NULL,
  `title` text NOT NULL,
  `content` text NOT NULL,
  `related_request_id` text REFERENCES `review_requests`(`id`) ON DELETE SET NULL,
  `is_read` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL
);
CREATE INDEX `idx_messages_user_family_created` ON `user_messages` (`user_id`,`family_id`,`created_at`);

INSERT OR IGNORE INTO `review_requests`
  (`id`,`family_id`,`applicant_user_id`,`reviewer_user_id`,`request_type`,`target_id`,`old_data`,`new_data`,`reason`,`status`,`created_at`,`reviewed_at`)
SELECT
  'review-claim-' || pc.id,
  pc.family_id,
  pc.user_id,
  NULL,
  'CLAIM_PERSON',
  pc.id,
  NULL,
  json_object('person_id', pc.person_id),
  CASE
    WHEN pc.status = 'APPROVED' AND (
      SELECT COUNT(*) FROM person_claims duplicate_claim
      WHERE duplicate_claim.family_id = pc.family_id
        AND duplicate_claim.user_id = pc.user_id
        AND duplicate_claim.status = 'APPROVED'
    ) > 1
    THEN '历史认领记录回填；检测到同一用户在同一族谱存在多条 APPROVED，保留原状未自动修复。'
    ELSE '历史认领记录回填；原状态保持不变。'
  END,
  pc.status,
  pc.created_at,
  CASE WHEN pc.status IN ('APPROVED','REJECTED') THEN pc.created_at ELSE NULL END
FROM person_claims pc;
