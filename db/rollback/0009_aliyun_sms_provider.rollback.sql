DROP INDEX IF EXISTS `idx_sms_verifications_provider_challenge`;
ALTER TABLE `sms_verifications` DROP COLUMN `provider_status`;
ALTER TABLE `sms_verifications` DROP COLUMN `provider_challenge_id`;
ALTER TABLE `sms_verifications` DROP COLUMN `provider_request_id`;
ALTER TABLE `sms_verifications` DROP COLUMN `provider`;
