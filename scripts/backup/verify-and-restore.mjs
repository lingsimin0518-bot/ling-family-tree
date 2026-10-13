import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readBackupArchive } from './archive-reader.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
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
    value && typeof value === 'object' && value.__backup_type === 'blob'
    && typeof value.base64 === 'string'
  ) {
    return `X'${Buffer.from(value.base64, 'base64').toString('hex')}'`;
  }
  fail('备份包含不支持的 SQLite 值类型');
}

function tableInsertSql(table, payload) {
  const columns = payload.columns.map((column) => column.name);
  const prefix = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES `;
  return payload.rows.map((row) =>
    `${prefix}(${columns.map((column) => sqlValue(row[column] ?? null)).join(',')});`
  );
}

function runWrangler(args) {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) fail('请通过 pnpm backup:verify 运行验证工具');
  const result = spawnSync(process.execPath, [packageManagerCli, 'exec', 'wrangler', ...args], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  // Wrangler errors can echo INSERT values from the backup. Never print its output.
  if (result.status !== 0) fail(`本地 D1 验证失败（退出码 ${result.status ?? '未知'}）；未输出数据`);
  return result.stdout;
}

function resultRows(output) {
  const start = output.indexOf('[');
  if (start < 0) fail('无法解析本地 D1 返回结果');
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

function readCount(baseArgs, table) {
  const output = runWrangler([
    ...baseArgs, '--command',
    `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`, '--json',
  ]);
  const total = Number(resultRows(output)[0]?.total ?? -1);
  if (!Number.isSafeInteger(total) || total < 0) fail(`本地表行数无效：${table}`);
  return total;
}

function verifyBusinessRelations(baseArgs, version) {
  const checks = [
    ['族谱成员与用户/族谱关联', `SELECT COUNT(*) AS total FROM family_users fu
      LEFT JOIN users u ON u.id=fu.user_id LEFT JOIN families f ON f.id=fu.family_id
      WHERE u.id IS NULL OR f.id IS NULL`],
    ['人物与族谱关联', `SELECT COUNT(*) AS total FROM persons p
      LEFT JOIN families f ON f.id=p.family_id WHERE f.id IS NULL`],
    ['关系双方同属目标族谱', `SELECT COUNT(*) AS total FROM relationships r
      LEFT JOIN families f ON f.id=r.family_id
      LEFT JOIN persons a ON a.id=r.from_person_id
      LEFT JOIN persons b ON b.id=r.to_person_id
      WHERE f.id IS NULL OR a.id IS NULL OR b.id IS NULL
        OR a.family_id<>r.family_id OR b.family_id<>r.family_id`],
    ['人物认领关联', `SELECT COUNT(*) AS total FROM person_claims c
      LEFT JOIN families f ON f.id=c.family_id
      LEFT JOIN users u ON u.id=c.user_id
      LEFT JOIN persons p ON p.id=c.person_id
      WHERE f.id IS NULL OR u.id IS NULL OR p.id IS NULL OR p.family_id<>c.family_id`],
  ];
  if (version === '0010') {
    checks.push(
      ['认证身份与用户关联', `SELECT COUNT(*) AS total FROM user_identities i
        LEFT JOIN users u ON u.id=i.user_id WHERE u.id IS NULL`],
      ['手机号身份唯一性', `SELECT COUNT(*) AS total FROM (
        SELECT provider_user_id FROM user_identities WHERE provider='PHONE'
        GROUP BY provider_user_id HAVING COUNT(*)>1
      )`],
    );
  }
  for (const [label, sql] of checks) {
    // Wrangler treats a newline in --command as a command boundary; keep each
    // integrity query on one line so its JOIN/WHERE clauses are not dropped.
    const statement = sql.replace(/\s+/g, ' ').trim();
    const result = resultRows(runWrangler([...baseArgs, '--command', statement, '--json']));
    const violations = Number(result[0]?.total ?? -1);
    if (violations !== 0) fail(`业务关联一致性检查失败：${label}（${violations}）`);
    console.log(`PASS ${label}`);
  }
}

async function main() {
  const input = process.argv.slice(2).find((argument) => argument !== '--');
  if (!input) fail('用法：pnpm backup:verify -- "<backup.zip>"');
  const { profile, manifest, tablePayloads } = await readBackupArchive(input);

  const work = await mkdtemp(join(tmpdir(), 'family-backup-verify-'));
  const state = join(work, 'state');
  const config = join(work, 'wrangler.jsonc');
  await writeFile(config, JSON.stringify({
    name: `backup-verification-${randomUUID()}`,
    compatibility_date: '2026-09-01',
    d1_databases: [{
      binding: 'DB',
      database_name: 'backup-verification',
      database_id: '00000000-0000-4000-8000-000000000000',
    }],
  }));
  const baseArgs = [
    'd1', 'execute', 'backup-verification',
    '--local', '--config', config, '--persist-to', state,
  ];
  for (const migration of profile.migrations) {
    runWrangler([...baseArgs, '--file', join(projectRoot, 'drizzle', migration)]);
  }
  for (const table of profile.tables) {
    if (readCount(baseArgs, table) !== 0) fail(`全新本地 D1 不是空库：${table}`);
  }

  const importLines = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (const table of profile.importOrder) {
    importLines.push(...tableInsertSql(table, tablePayloads.get(table)));
  }
  importLines.push('COMMIT;', 'PRAGMA foreign_keys=ON;');
  const importFile = join(work, 'restore.sql');
  await writeFile(importFile, `${importLines.join('\n')}\n`);
  runWrangler([...baseArgs, '--file', importFile]);

  for (const table of profile.tables) {
    const actual = readCount(baseArgs, table);
    const expected = manifest.tables.find((entry) => entry.table_name === table).row_count;
    if (actual !== expected) fail(`本地恢复行数不一致：${table}`);
    console.log(`PASS ${table}`);
  }
  const foreignKeys = resultRows(
    runWrangler([...baseArgs, '--command', 'PRAGMA foreign_key_check', '--json']),
  );
  if (foreignKeys.length > 0) fail('本地恢复外键一致性检查失败');
  verifyBusinessRelations(baseArgs, profile.version);
  if (profile.version === '0010') {
    const unsafe = Number(resultRows(runWrangler([
      ...baseArgs, '--command',
      "SELECT COUNT(*) AS total FROM families WHERE source_type='LEGACY_STATIC' AND join_code NOT LIKE 'LEGACY-DISABLED-%'",
      '--json',
    ]))[0]?.total ?? -1);
    if (unsafe !== 0) fail('0010 旧族谱邀请码未完成轮换');
  }
  console.log(`PASS：${profile.version}/${profile.tables.length} 表备份结构、SHA-256、本地恢复、行数与外键检查全部通过。`);
  console.log(`隔离的本地验证目录：${work}`);
}

main().catch((error) => {
  console.error(`FAIL：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
