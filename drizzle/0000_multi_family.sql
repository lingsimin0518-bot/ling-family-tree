PRAGMA foreign_keys = ON;

CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text,
  `display_name` text,
  `created_at` text NOT NULL
);

CREATE TABLE `families` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `join_code` text NOT NULL,
  `source_type` text DEFAULT 'DATABASE' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL
);
CREATE UNIQUE INDEX `idx_families_join_code` ON `families` (`join_code`);

CREATE TABLE `family_users` (
  `user_id` text NOT NULL,
  `family_id` text NOT NULL,
  `role` text NOT NULL CHECK (`role` IN ('OWNER','ADMIN','EDITOR','VIEWER')),
  `joined_at` text NOT NULL,
  PRIMARY KEY (`user_id`,`family_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_family_users_family_role` ON `family_users` (`family_id`,`role`);

CREATE TABLE `generations` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `number` integer NOT NULL,
  `title` text,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_generations_family_number` ON `generations` (`family_id`,`number`);

CREATE TABLE `persons` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `linked_user_id` text,
  `name` text NOT NULL,
  `gender` text,
  `generation` integer NOT NULL,
  `birth_year` text,
  `biography` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`linked_user_id`) REFERENCES `users`(`id`)
);
CREATE INDEX `idx_persons_family_generation` ON `persons` (`family_id`,`generation`);
CREATE INDEX `idx_persons_family_name` ON `persons` (`family_id`,`name`);

CREATE TABLE `relationships` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `from_person_id` text NOT NULL,
  `to_person_id` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('PARENT','CHILD','SPOUSE')),
  `created_at` text NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`from_person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`to_person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE
);
CREATE INDEX `idx_relationships_family_from` ON `relationships` (`family_id`,`from_person_id`);
CREATE INDEX `idx_relationships_family_to` ON `relationships` (`family_id`,`to_person_id`);

CREATE TABLE `announcements` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `author_user_id` text NOT NULL,
  `title` text NOT NULL,
  `body` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`)
);
CREATE INDEX `idx_announcements_family_created` ON `announcements` (`family_id`,`created_at`);

CREATE TABLE `media` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `person_id` text,
  `uploader_user_id` text NOT NULL,
  `kind` text NOT NULL,
  `storage_key` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`uploader_user_id`) REFERENCES `users`(`id`)
);
CREATE INDEX `idx_media_family_person` ON `media` (`family_id`,`person_id`);

CREATE TABLE `person_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `user_id` text NOT NULL,
  `person_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('PENDING','APPROVED','REJECTED')),
  `created_at` text NOT NULL,
  FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `idx_claims_family_user_person` ON `person_claims` (`family_id`,`user_id`,`person_id`);
