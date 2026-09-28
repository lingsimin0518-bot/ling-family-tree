-- S0 containment: invalidate every legacy-static family join code.
-- Application code also rejects joins to LEGACY_STATIC families; this data
-- update prevents the former fixed value from remaining a usable credential
-- if an older application build is accidentally restored.
UPDATE `families`
SET `join_code` = 'LEGACY-DISABLED-' || lower(hex(randomblob(16)))
WHERE `source_type` = 'LEGACY_STATIC';
