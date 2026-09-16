DROP INDEX IF EXISTS idx_relationships_family_creator;
DROP INDEX IF EXISTS idx_persons_family_creator;
ALTER TABLE relationships DROP COLUMN created_by_user_id;
ALTER TABLE persons DROP COLUMN updated_at;
ALTER TABLE persons DROP COLUMN updated_by_user_id;
ALTER TABLE persons DROP COLUMN created_by_user_id;
