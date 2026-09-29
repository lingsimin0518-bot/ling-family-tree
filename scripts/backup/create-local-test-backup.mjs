import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStoredZipStream } from '../../lib/backup-archive.ts';

const TABLES_0006 = [
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
const TABLES_0010 = [
  ...TABLES_0006.slice(0, 9),
  'phone_change_challenges',
  ...TABLES_0006.slice(9, 12),
  'sms_verifications',
  ...TABLES_0006.slice(12, 13),
  'user_identities',
  ...TABLES_0006.slice(13),
];
const MIGRATIONS = [
  '0000_multi_family.sql',
  '0001_real_user_auth.sql',
  '0002_wechat_identity.sql',
  '0003_system_admin.sql',
  '0004_unified_person_operations.sql',
  '0005_creation_cooldown.sql',
  '0006_collaboration_persistence.sql',
  '0007_auth_identity_foundation.sql',
  '0008_phone_change_challenges.sql',
  '0009_aliyun_sms_provider.sql',
  '0010_security_s0_containment.sql',
];
const PROFILES = {
  '0006': {
    tables: TABLES_0006,
    migrations: MIGRATIONS.slice(0, 7),
    fixture: 'local-test-data-0006.sql',
  },
  '0010': {
    tables: TABLES_0010,
    migrations: MIGRATIONS,
    fixture: 'local-test-data.sql',
  },
};
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const encoder = new TextEncoder();

function fail(message) {
  throw new Error(message);
}

function requestedSchema() {
  const args = process.argv.slice(2);
  const inline = args.find((entry) => entry.startsWith('--schema='));
  const schemaIndex = args.indexOf('--schema');
  const value = inline?.slice('--schema='.length) ?? args[schemaIndex + 1] ?? '0010';
  if (!(value in PROFILES)) fail('仅支持 --schema 0006 或 --schema 0010');
  return value;
}

function runWrangler(args) {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) fail('请通过 pnpm exec 运行本地备份测试工具');
  const result = spawnSync(process.execPath, [packageManagerCli, 'exec', 'wrangler', ...args], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) fail(result.stderr || result.stdout || '本地 D1 命令失败');
  return result.stdout;
}

function resultRows(output) {
  const start = output.indexOf('[');
  if (start < 0) fail('无法解析本地 D1 输出');
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

function jsonBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const schemaVersion = requestedSchema();
  const profile = PROFILES[schemaVersion];
  const work = await mkdtemp(join(tmpdir(), `backup-${profile.tables.length}-table-fixture-`));
  const state = join(work, 'state');
  const config = join(work, 'wrangler.jsonc');
  await writeFile(
    config,
    JSON.stringify({
      name: `backup-fixture-${randomUUID()}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'backup-fixture',
          database_id: '00000000-0000-4000-8000-000000000000',
        },
      ],
    }),
  );
  const base = [
    'd1',
    'execute',
    'backup-fixture',
    '--local',
    '--config',
    config,
    '--persist-to',
    state,
  ];
  for (const migration of profile.migrations) {
    runWrangler([...base, '--file', join(projectRoot, 'drizzle', migration)]);
  }
  runWrangler([
    ...base,
    '--file',
    join(projectRoot, 'scripts', 'backup', 'fixtures', profile.fixture),
  ]);

  const schemaRows = resultRows(
    runWrangler([
      ...base,
      '--command',
      "SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema WHERE type IN ('table','index') ORDER BY type,name",
      '--json',
    ]),
  );
  const tableFiles = [];
  const tableManifests = [];
  const schemaTables = {};
  for (const table of profile.tables) {
    const columns = resultRows(
      runWrangler([...base, '--command', `PRAGMA table_info("${table}")`, '--json']),
    );
    const rows = resultRows(
      runWrangler([...base, '--command', `SELECT * FROM "${table}"`, '--json']),
    );
    schemaTables[table] = columns;
    const path = `tables/${table}.json`;
    const bytes = jsonBytes({ table_name: table, columns, rows });
    tableFiles.push({ path, bytes });
    tableManifests.push({
      table_name: table,
      file: path,
      row_count: rows.length,
      sha256: sha256(bytes),
    });
  }

  const schemaJson = jsonBytes({
    schema_version: schemaVersion,
    tables: schemaTables,
    sqlite_schema: schemaRows.filter(
      (entry) => profile.tables.includes(entry.table_name) || profile.tables.includes(entry.name),
    ),
  });
  const schemaReadme = encoder.encode(
    `本地 schema ${schemaVersion} / ${profile.tables.length} 表备份恢复测试数据，不含生产信息。\n`,
  );
  const checksums = {};
  for (const file of [...tableFiles, { path: 'schema/schema.json', bytes: schemaJson }]) {
    checksums[file.path] = sha256(file.bytes);
  }
  checksums['schema/README.md'] = sha256(schemaReadme);
  const now = new Date().toISOString();
  const manifest = {
    backup_format_version: 1,
    schema_version: schemaVersion,
    export_started_at: now,
    export_finished_at: now,
    project_id: 'appgprj_6a9b746cbba88191bd63914f864ffb5e',
    binding: 'DB',
    tables: tableManifests,
  };
  const files = [
    { path: 'manifest.json', bytes: jsonBytes(manifest) },
    { path: 'checksums.json', bytes: jsonBytes(checksums) },
    { path: 'schema/schema.json', bytes: schemaJson },
    { path: 'schema/README.md', bytes: schemaReadme },
    ...tableFiles,
  ];
  const zip = createStoredZipStream(files);
  const zipPath = join(work, `local-${schemaVersion}-${profile.tables.length}-table-backup.zip`);
  await writeFile(zipPath, new Uint8Array(await new Response(zip).arrayBuffer()));
  console.log(zipPath);
}

main().catch((error) => {
  console.error(`FAIL：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
