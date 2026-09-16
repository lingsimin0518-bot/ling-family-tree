ALTER TABLE persons ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
ALTER TABLE persons ADD COLUMN updated_by_user_id TEXT REFERENCES users(id);
ALTER TABLE persons ADD COLUMN updated_at TEXT;
ALTER TABLE relationships ADD COLUMN created_by_user_id TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_persons_family_creator
ON persons(family_id, created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_relationships_family_creator
ON relationships(family_id, created_by_user_id);

PRAGMA optimize;
