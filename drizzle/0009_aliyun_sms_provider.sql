ALTER TABLE `sms_verifications` ADD COLUMN `provider` TEXT NOT NULL DEFAULT 'MOCK';
ALTER TABLE `sms_verifications` ADD COLUMN `provider_request_id` TEXT;
ALTER TABLE `sms_verifications` ADD COLUMN `provider_challenge_id` TEXT;
ALTER TABLE `sms_verifications` ADD COLUMN `provider_status` TEXT NOT NULL DEFAULT 'CREATED';

CREATE INDEX `idx_sms_verifications_provider_challenge`
ON `sms_verifications` (`provider`,`provider_challenge_id`);
