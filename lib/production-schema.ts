export const PRODUCTION_BACKUP_TABLES_0006 = [
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
] as const;

export const PRODUCTION_BACKUP_TABLES_0010 = [
  'action_idempotency',
  'action_rate_limit',
  'announcements',
  'families',
  'family_activities',
  'family_users',
  'generations',
  'media',
  'person_claims',
  'phone_change_challenges',
  'persons',
  'relationships',
  'review_requests',
  'sms_verifications',
  'system_audit_logs',
  'user_identities',
  'user_messages',
  'user_sessions',
  'users',
] as const;

export const PRODUCTION_BACKUP_TABLES = PRODUCTION_BACKUP_TABLES_0010;
export type ProductionBackupTable = (typeof PRODUCTION_BACKUP_TABLES)[number];
export type BackupSchemaVersion = '0006' | '0010';
export type SchemaRecognitionMethod =
  | 'd1_migrations'
  | 'sites_migration_record'
  | 'structural_inference'
  | 'unrecognized';

export const PRODUCTION_BACKUP_PROFILES = {
  '0006': { schemaVersion: '0006', tables: PRODUCTION_BACKUP_TABLES_0006 },
  '0010': { schemaVersion: '0010', tables: PRODUCTION_BACKUP_TABLES_0010 },
} as const;

// Only explicitly identified platform tables are exempt from the strict business-table allowlist.
const PLATFORM_TABLES = new Set([
  'd1_migrations',
  '__appgarden_migrations',
  '_cf_KV',
  '_cf_METADATA',
]);
const MIGRATION_NAMES = [
  '0000_multi_family',
  '0001_real_user_auth',
  '0002_wechat_identity',
  '0003_system_admin',
  '0004_unified_person_operations',
  '0005_creation_cooldown',
  '0006_collaboration_persistence',
  '0007_auth_identity_foundation',
  '0008_phone_change_challenges',
  '0009_aliyun_sms_provider',
  '0010_security_s0_containment',
] as const;

type NameRow = { name: string };
type ColumnRow = { name: string };
type MigrationRow = { name: unknown };

export function classifyProductionTables(names: string[]) {
  const businessTables: string[] = [];
  const platformTables: string[] = [];
  const unknownTables: string[] = [];
  const known = new Set<string>(PRODUCTION_BACKUP_TABLES_0010);
  for (const name of names) {
    if (known.has(name)) businessTables.push(name);
    else if (PLATFORM_TABLES.has(name) || name.startsWith('sqlite_')) platformTables.push(name);
    else unknownTables.push(name);
  }
  // Any identity table means an attempted 0010 upgrade, never a 0006 profile.
  const base = new Set<string>(PRODUCTION_BACKUP_TABLES_0006);
  const hasIdentityTable = businessTables.some((table) => !base.has(table));
  const profileVersion: BackupSchemaVersion = hasIdentityTable ? '0010' : '0006';
  const expected = PRODUCTION_BACKUP_PROFILES[profileVersion].tables;
  const missingTables = expected.filter((table) => !businessTables.includes(table));
  return { businessTables, platformTables, unknownTables, missingTables, profileVersion };
}

function knownMigrationVersion(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.endsWith('.sql') ? value.slice(0, -4) : value;
  return MIGRATION_NAMES.includes(normalized as (typeof MIGRATION_NAMES)[number])
    ? normalized.slice(0, 4)
    : null;
}

async function readMigrationLedger(
  binding: D1Database,
  table: 'd1_migrations' | '__appgarden_migrations',
) {
  try {
    const columns = await binding.prepare(`PRAGMA table_info("${table}")`).all<ColumnRow>();
    const columnNames = new Set(columns.results.map((column) => column.name));
    const nameColumn = columnNames.has('name') ? 'name'
      : table === '__appgarden_migrations' && columnNames.has('migration_name') ? 'migration_name'
        : null;
    if (!nameColumn) return null;
    const rows = await binding.prepare(`SELECT "${nameColumn}" AS name FROM "${table}"`).all<MigrationRow>();
    if (rows.results.length === 0) return null;
    const versions = rows.results.map((row) => knownMigrationVersion(row.name));
    // An unfamiliar ledger format is not evidence of a particular schema version.
    if (versions.some((version) => version === null)) return null;
    return versions.sort((left, right) => left!.localeCompare(right!)).at(-1) ?? null;
  } catch {
    // Sites controls its own metadata schema. If it cannot be interpreted reliably,
    // use an explicitly labelled structural inference below.
    return null;
  }
}

async function hasColumns(binding: D1Database, table: string, expected: string[]) {
  const result = await binding.prepare(`PRAGMA table_info("${table}")`).all<ColumnRow>();
  const actual = new Set(result.results.map((column) => column.name));
  return expected.every((column) => actual.has(column));
}

async function has0006Structure(binding: D1Database) {
  return await hasColumns(binding, 'family_activities', ['family_id', 'author_user_id', 'status', 'reviewer_user_id'])
    && await hasColumns(binding, 'review_requests', ['family_id', 'applicant_user_id', 'request_type', 'target_id', 'status'])
    && await hasColumns(binding, 'user_messages', ['user_id', 'family_id', 'related_request_id', 'is_read']);
}

async function has0009Structure(binding: D1Database) {
  const providerIndex = await binding.prepare(`SELECT name FROM sqlite_schema
    WHERE type='index' AND name='idx_sms_verifications_provider_challenge'
      AND tbl_name='sms_verifications'`).all<NameRow>();
  return await has0006Structure(binding)
    && await hasColumns(binding, 'user_identities', ['user_id', 'provider', 'provider_user_id', 'verified_at'])
    && await hasColumns(binding, 'phone_change_challenges', ['user_id', 'token_hash', 'expires_at'])
    && await hasColumns(binding, 'sms_verifications', ['phone_e164', 'code_hash', 'provider', 'provider_request_id', 'provider_challenge_id', 'provider_status'])
    && providerIndex.results.length === 1;
}

async function has0010JoinCodes(binding: D1Database) {
  const result = await binding.prepare(`SELECT COUNT(*) AS total FROM families
    WHERE source_type = 'LEGACY_STATIC' AND join_code NOT LIKE 'LEGACY-DISABLED-%'`).all<{ total: number | string }>();
  return Number(result.results[0]?.total ?? -1) === 0;
}

export async function inspectProductionSchema(binding: D1Database) {
  const result = await binding.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).all<NameRow>();
  const { businessTables, platformTables, unknownTables, missingTables, profileVersion } = classifyProductionTables(result.results.map((row) => row.name));
  const matchesExpectedTables = missingTables.length === 0 && unknownTables.length === 0;
  const matchesExpectedStructure = matchesExpectedTables && (
    profileVersion === '0006' ? await has0006Structure(binding) : await has0009Structure(binding)
  );

  let schemaVersion = '未识别';
  let schemaRecognitionMethod: SchemaRecognitionMethod = 'unrecognized';
  if (platformTables.includes('d1_migrations')) {
    const recorded = await readMigrationLedger(binding, 'd1_migrations');
    if (recorded) {
      schemaVersion = recorded;
      schemaRecognitionMethod = 'd1_migrations';
    }
  }
  if (schemaRecognitionMethod === 'unrecognized' && platformTables.includes('__appgarden_migrations')) {
    const recorded = await readMigrationLedger(binding, '__appgarden_migrations');
    if (recorded) {
      schemaVersion = recorded;
      schemaRecognitionMethod = 'sites_migration_record';
    }
  }
  if (schemaRecognitionMethod === 'unrecognized' && matchesExpectedStructure) {
    // 0010 only changes row values. Its completion cannot be inferred from columns.
    schemaVersion = profileVersion === '0006' ? '0006' : '0009';
    schemaRecognitionMethod = 'structural_inference';
  }
  const matches0010Data = matchesExpectedStructure && profileVersion === '0010' && schemaVersion === '0010'
    && await has0010JoinCodes(binding);

  return {
    businessTables,
    platformTables,
    unknownTables,
    missingTables,
    profileVersion,
    schemaVersion,
    schemaRecognitionMethod,
    matchesExpected0006: matchesExpectedStructure && profileVersion === '0006' && schemaVersion === '0006',
    matchesExpected0010: matches0010Data
      && schemaRecognitionMethod !== 'structural_inference',
    matchesExpectedBackup: matchesExpectedStructure && (
      (profileVersion === '0006' && schemaVersion === '0006')
      || (matches0010Data && schemaRecognitionMethod !== 'structural_inference')
    ),
  };
}
