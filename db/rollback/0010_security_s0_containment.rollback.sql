-- Emergency rollback only. Restoring the historical fixed code reintroduces
-- the retired join path and must not be used while that code is publicly known.
UPDATE `families`
SET `join_code` = 'LINGSHI'
WHERE `id` = 'family-lingshi-existing'
  AND `source_type` = 'LEGACY_STATIC';
