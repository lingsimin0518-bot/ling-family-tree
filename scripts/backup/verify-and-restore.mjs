import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TABLES = [
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
const IMPORT_ORDER = [
  'users',
  'families',
  'family_users',
  'generations',
  'persons',
  'relationships',
  'announcements',
  'family_activities',
  'media',
  'person_claims',
  'review_requests',
  'user_messages',
  'system_audit_logs',
  'user_sessions',
  'action_rate_limit',
  'action_idempotency',
];
const REQUIRED_FILES = new Set([
  'manifest.json',
  'checksums.json',
  'schema/schema.json',
  'schema/README.md',
  ...TABLES.map((table) => `tables/${table}.json`),
]);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function unzipStored(bytes) {
  const files = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const signature = view.getUint32(0, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > bytes.byteLength) {
      fail('ZIP 结构无效');
    }
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    if ((flags & 0x0008) !== 0) fail('不支持使用数据描述符的 ZIP');
    if (method !== 0 || compressedSize !== uncompressedSize) {
      fail('备份 ZIP 必须使用无损 STORE 格式');
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) fail('ZIP 文件被截断');
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (!name || name.startsWith('/') || name.includes('..') || files.has(name)) {
      fail(`ZIP 中存在不安全或重复路径：${name}`);
    }
    files.set(name, bytes.slice(dataStart, dataEnd));
    offset = dataEnd;
  }
  return files;
}

function parseJson(files, path) {
  const bytes = files.get(path);
  if (!bytes) fail(`缺少文件：${path}`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`JSON 无法解析：${path}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlValue(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('备份包含无效数字');
    return String(value);
  }
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (
    value &&
    typeof value === 'object' &&
    value.__backup_type === 'blob' &&
    typeof value.base64 === 'string'
  ) {
    return `X'${Buffer.from(value.base64, 'base64').toString('hex')}'`;
  }
  fail('备份包含不支持的 SQLite 值类型');
}

function tableInsertSql(table, payload) {
  if (payload.table_name !== table || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)) {
    fail(`表文件格式无效：${table}`);
  }
  const columns = payload.columns.map((column) => column.name);
  if (columns.some((column) => typeof column !== 'string' || !column)) {
    fail(`表字段定义无效：${table}`);
  }
  const prefix = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES `;
  return payload.rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`表数据无效：${table}`);
    return `${prefix}(${columns.map((column) => sqlValue(row[column] ?? null)).join(',')});`;
  });
}

function runWrangler(args, cwd = projectRoot) {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) fail('请通过 pnpm backup:verify 运行验证工具');
  const result = spawnSync(process.execPath, [packageManagerCli, 'exec', 'wrangler', ...args], {
    cwd,
    env: environment,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `本地 D1 命令失败：${result.error?.message || result.stderr || result.stdout || '未知错误'}`,
    );
  }
  return result.stdout;
}

function parseWranglerJson(output) {
  const start = output.indexOf('[');
  if (start < 0) fail('无法解析本地 D1 返回结果');
  return JSON.parse(output.slice(start));
}

function resultRows(output) {
  const parsed = parseWranglerJson(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

async function main() {
  const input = process.argv.slice(2).find((argument) => argument !== '--');
  if (!input) fail('用法：pnpm backup:verify -- "<backup.zip>"');
  const zipPath = resolve(input);
  const files = unzipStored(new Uint8Array(await readFile(zipPath)));
  const actualFiles = new Set(files.keys());
  const missing = [...REQUIRED_FILES].filter((path) => !actualFiles.has(path));
  const extra = [...actualFiles].filter((path) => !REQUIRED_FILES.has(path));
  if (missing.length || extra.length) {
    fail(`ZIP 文件集合不正确；缺少：${missing.join(', ') || '无'}；多出：${extra.join(', ') || '无'}`);
  }

  const manifest = parseJson(files, 'manifest.json');
  if (
    manifest.backup_format_version !== 1 ||
    manifest.project_id !== 'appgprj_6a9b746cbba88191bd63914f864ffb5e' ||
    manifest.binding !== 'DB' ||
    manifest.schema_version !== '0006' ||
    !['d1_migrations', 'sites_migration_record', 'structural_inference'].includes(manifest.schema_recognition_method) ||
    !Array.isArray(manifest.tables)
  ) {
    fail('manifest 与当前 0006/16 表生产备份要求不匹配');
  }
  const manifestTables = manifest.tables.map((entry) => entry.table_name);
  if (
    manifestTables.length !== TABLES.length ||
    TABLES.some((table) => !manifestTables.includes(table))
  ) {
    fail('manifest 没有完整列出16张表');
  }
  const schema = parseJson(files, 'schema/schema.json');
  if (schema.schema_version !== manifest.schema_version || schema.schema_recognition_method !== manifest.schema_recognition_method || Object.keys(schema.tables ?? {}).length !== TABLES.length || TABLES.some((table) => !Object.hasOwn(schema.tables, table))) {
    fail('schema 文件与 manifest 的版本、识别方式或16张表不一致');
  }
  if (schema.sqlite_schema?.some((entry) => !TABLES.includes(entry.table_name) && !TABLES.includes(entry.name))) {
    fail('schema 文件包含平台内部表或未知表');
  }

  const checksums = parseJson(files, 'checksums.json');
  const requiredChecksums = [...REQUIRED_FILES].filter((path) => path !== 'manifest.json' && path !== 'checksums.json');
  if (Object.keys(checksums).length !== requiredChecksums.length || requiredChecksums.some((path) => typeof checksums[path] !== 'string')) {
    fail('校验和清单没有完整列出所有备份文件');
  }
  for (const [path, expected] of Object.entries(checksums)) {
    const bytes = files.get(path);
    if (!bytes || sha256(bytes) !== expected) fail(`SHA-256 校验失败：${path}`);
  }
  for (const entry of manifest.tables) {
    const bytes = files.get(entry.file);
    if (!bytes || sha256(bytes) !== entry.sha256) fail(`表校验失败：${entry.table_name}`);
  }

  const work = await mkdtemp(join(tmpdir(), 'family-backup-verify-'));
  const state = join(work, 'state');
  const config = join(work, 'wrangler.jsonc');
  await writeFile(
    config,
    JSON.stringify({
      name: `backup-verification-${randomUUID()}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'backup-verification',
          database_id: '00000000-0000-4000-8000-000000000000',
        },
      ],
    }),
  );
  const baseArgs = [
    'd1',
    'execute',
    'backup-verification',
    '--local',
    '--config',
    config,
    '--persist-to',
    state,
  ];
  for (let version = 0; version <= 6; version += 1) {
    const prefix = String(version).padStart(4, '0');
    const migration = [
      '0000_multi_family.sql',
      '0001_real_user_auth.sql',
      '0002_wechat_identity.sql',
      '0003_system_admin.sql',
      '0004_unified_person_operations.sql',
      '0005_creation_cooldown.sql',
      '0006_collaboration_persistence.sql',
    ][version];
    if (!migration.startsWith(prefix)) fail('migration 顺序配置错误');
    runWrangler([...baseArgs, '--file', join(projectRoot, 'drizzle', migration)]);
  }

  for (const table of TABLES) {
    const output = runWrangler([...baseArgs, '--command', `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`, '--json']);
    const total = Number(resultRows(output)[0]?.total ?? -1);
    if (total !== 0) fail(`全新本地 D1 不是空库：${table}=${total}`);
  }

  const importLines = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  const tablePayloads = new Map();
  for (const table of TABLES) tablePayloads.set(table, parseJson(files, `tables/${table}.json`));
  for (const table of IMPORT_ORDER) importLines.push(...tableInsertSql(table, tablePayloads.get(table)));
  importLines.push('COMMIT;', 'PRAGMA foreign_keys=ON;');
  const importFile = join(work, 'restore.sql');
  await writeFile(importFile, `${importLines.join('\n')}\n`);
  runWrangler([...baseArgs, '--file', importFile]);

  const results = [];
  for (const table of TABLES) {
    const output = runWrangler([...baseArgs, '--command', `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`, '--json']);
    const actual = Number(resultRows(output)[0]?.total ?? -1);
    const expected = Number(manifest.tables.find((entry) => entry.table_name === table)?.row_count ?? -1);
    results.push({ table, expected, actual, pass: actual === expected });
  }
  const foreignKeys = resultRows(
    runWrangler([...baseArgs, '--command', 'PRAGMA foreign_key_check', '--json']),
  );
  if (foreignKeys.length > 0) fail(`外键一致性检查失败：${JSON.stringify(foreignKeys)}`);
  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.table}: ${result.actual}/${result.expected}`);
  }
  if (results.some((result) => !result.pass)) fail('一个或多个表的行数不一致');
  console.log('PASS：备份结构、校验和、本地恢复、16张表行数和外键检查全部通过。');
  console.log(`隔离的本地验证目录：${work}`);
}

main().catch((error) => {
  console.error(`FAIL：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
