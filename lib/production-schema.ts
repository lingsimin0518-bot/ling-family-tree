export const PRODUCTION_BACKUP_TABLES = [
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

export type ProductionBackupTable = (typeof PRODUCTION_BACKUP_TABLES)[number];
export type SchemaRecognitionMethod =
  | 'd1_migrations'
  | 'sites_migration_record'
  | 'structural_inference'
  | 'unrecognized';

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
] as const;

type NameRow = { name: string };
type ColumnRow = { name: string };
type MigrationRow = { name: unknown };

export function classifyProductionTables(names: string[]) {
  const businessTables: string[] = [];
  const platformTables: string[] = [];
  const unknownTables: string[] = [];
  const expected = new Set<string>(PRODUCTION_BACKUP_TABLES);
  for (const name of names) {
    if (expected.has(name)) businessTables.push(name);
    else if (PLATFORM_TABLES.has(name) || name.startsWith('sqlite_')) platformTables.push(name);
    else unknownTables.push(name);
  }
  const missingTables = PRODUCTION_BACKUP_TABLES.filter((table) => !businessTables.includes(table));
  return { businessTables, platformTables, unknownTables, missingTables };
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

async function has0006Structure(binding: D1Database) {
  const requiredColumns: Record<string, string[]> = {
    family_activities: ['family_id', 'author_user_id', 'status', 'reviewer_user_id'],
    review_requests: ['family_id', 'applicant_user_id', 'request_type', 'target_id', 'status'],
    user_messages: ['user_id', 'family_id', 'related_request_id', 'is_read'],
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const result = await binding.prepare(`PRAGMA table_info("${table}")`).all<ColumnRow>();
    const actual = new Set(result.results.map((column) => column.name));
    if (expected.some((column) => !actual.has(column))) return false;
  }
  return true;
}

export async function inspectProductionSchema(binding: D1Database) {
  const result = await binding.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).all<NameRow>();
  const { businessTables, platformTables, unknownTables, missingTables } = classifyProductionTables(result.results.map((row) => row.name));
  const matchesExpectedTables = missingTables.length === 0 && unknownTables.length === 0;
  const matchesExpectedStructure = matchesExpectedTables && await has0006Structure(binding);

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
    schemaVersion = '0006';
    schemaRecognitionMethod = 'structural_inference';
  }

  return {
    businessTables,
    platformTables,
    unknownTables,
    missingTables,
    schemaVersion,
    schemaRecognitionMethod,
    matchesExpected0006: matchesExpectedStructure && schemaVersion === '0006',
  };
}
