export const TABLES_0006 = [
  'action_idempotency',
  'action_rate_limit',
  'announcements',
  'families',
  'family_activities',
  'family_users',
  'generations',
  'media',
  'person_claims',
  'persons',
  'relationships',
  'review_requests',
  'system_audit_logs',
  'user_messages',
  'user_sessions',
  'users',
];

export const TABLES_0010 = [
  ...TABLES_0006.slice(0, 9),
  'phone_change_challenges',
  ...TABLES_0006.slice(9, 12),
  'sms_verifications',
  ...TABLES_0006.slice(12, 13),
  'user_identities',
  ...TABLES_0006.slice(13),
];

export const MIGRATIONS_0006 = [
  '0000_multi_family.sql',
  '0001_real_user_auth.sql',
  '0002_wechat_identity.sql',
  '0003_system_admin.sql',
  '0004_unified_person_operations.sql',
  '0005_creation_cooldown.sql',
  '0006_collaboration_persistence.sql',
];

export const MIGRATIONS_0010 = [
  ...MIGRATIONS_0006,
  '0007_auth_identity_foundation.sql',
  '0008_phone_change_challenges.sql',
  '0009_aliyun_sms_provider.sql',
  '0010_security_s0_containment.sql',
];

export const PROFILES = {
  '0006': {
    version: '0006',
    tables: TABLES_0006,
    migrations: MIGRATIONS_0006,
    importOrder: [
      'users', 'families', 'family_users', 'generations', 'persons',
      'relationships', 'announcements', 'family_activities', 'media',
      'person_claims', 'review_requests', 'user_messages', 'system_audit_logs',
      'user_sessions', 'action_rate_limit', 'action_idempotency',
    ],
    recognitionMethods: ['d1_migrations', 'sites_migration_record', 'structural_inference'],
  },
  '0010': {
    version: '0010',
    tables: TABLES_0010,
    migrations: MIGRATIONS_0010,
    importOrder: [
      'users', 'user_identities', 'sms_verifications', 'phone_change_challenges',
      'families', 'family_users', 'generations', 'persons', 'relationships',
      'announcements', 'media', 'person_claims', 'family_activities',
      'review_requests', 'user_messages', 'system_audit_logs', 'user_sessions',
      'action_rate_limit', 'action_idempotency',
    ],
    recognitionMethods: ['d1_migrations', 'sites_migration_record'],
  },
};
