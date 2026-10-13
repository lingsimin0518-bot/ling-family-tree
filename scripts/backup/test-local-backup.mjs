import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_0010, MIGRATIONS_0006, TABLES_0006 } from './profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function runWrangler(args) {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) fail('请通过 pnpm backup:test-fixture 运行测试');
  const result = spawnSync(process.execPath, [packageManagerCli, 'exec', 'wrangler', ...args], {
    cwd: root, env: environment, encoding: 'utf8', shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`本地升级命令失败（退出码 ${result.status ?? '未知'}）`);
  return result.stdout;
}

function rows(output) {
  const start = output.indexOf('[');
  if (start < 0) fail('无法解析本地 D1 返回结果');
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

function readCount(base, table) {
  const result = rows(runWrangler([...base, '--command', `SELECT COUNT(*) AS total FROM "${table}"`, '--json']));
  return Number(result[0]?.total ?? -1);
}

function testLocalUpgrade(work) {
  const base = [
    'd1', 'execute', 'backup-verification', '--local',
    '--config', join(work, 'wrangler.jsonc'), '--persist-to', join(work, 'state'),
  ];
  const before = new Map(TABLES_0006.map((table) => [table, readCount(base, table)]));
  for (const migration of MIGRATIONS_0010.slice(MIGRATIONS_0006.length)) {
    runWrangler([...base, '--file', join(root, 'drizzle', migration)]);
  }
  for (const table of TABLES_0006) {
    if (readCount(base, table) !== before.get(table)) fail(`本地升级后原有表行数变化：${table}`);
  }
  for (const table of ['user_identities', 'sms_verifications', 'phone_change_challenges']) {
    if (readCount(base, table) < 0) fail(`本地升级缺少新表：${table}`);
  }
  const providerColumn = rows(runWrangler([
    ...base, '--command',
    "SELECT COUNT(*) AS total FROM pragma_table_info('sms_verifications') WHERE name='provider_challenge_id'",
    '--json',
  ]));
  if (Number(providerColumn[0]?.total ?? 0) !== 1) fail('本地升级缺少 0009 provider_challenge_id 字段');
  const unsafeLegacy = rows(runWrangler([
    ...base, '--command',
    "SELECT COUNT(*) AS total FROM families WHERE source_type='LEGACY_STATIC' AND join_code NOT LIKE 'LEGACY-DISABLED-%'",
    '--json',
  ]));
  if (Number(unsafeLegacy[0]?.total ?? -1) !== 0) fail('本地升级未轮换旧族谱邀请码');
  const foreignKeys = rows(runWrangler([...base, '--command', 'PRAGMA foreign_key_check', '--json']));
  if (foreignKeys.length !== 0) fail('本地升级外键检查失败');
  console.log('PASS：0006 备份本地恢复后升级到 0010，原有 16 表行数、新表、邀请码与外键检查通过。');
}

const backups = new Map();
for (const version of ['0006', '0010']) {
  const create = spawnSync(process.execPath, [
    '--experimental-strip-types',
    join(root, 'scripts/backup/create-local-test-backup.mjs'), version,
  ], { cwd: root, env: process.env, encoding: 'utf8' });
  if (create.status !== 0) {
    fail(create.stderr.match(/FAIL：[^\r\n]*/)?.[0] ?? '本地备份夹具创建失败');
  }
  const zipPath = create.stdout.trim().split(/\r?\n/).find((line) => line.endsWith('.zip'));
  if (!zipPath) fail('未找到本地测试备份 ZIP');
  backups.set(version, zipPath);
  const verify = spawnSync(process.execPath, [
    join(root, 'scripts/backup/verify-and-restore.mjs'), zipPath,
  ], { cwd: root, env: process.env, encoding: 'utf8' });
  if (verify.status !== 0) {
    fail(verify.stderr.match(/FAIL：[^\r\n]*/)?.[0] ?? '本地备份恢复验证失败');
  }
  process.stdout.write(verify.stdout || '');
  if (version === '0006') {
    const work = verify.stdout.match(/隔离的本地验证目录：([^\r\n]+)/)?.[1];
    if (!work) fail('无法定位隔离的本地恢复目录');
    testLocalUpgrade(work);
  }
}
const compare = spawnSync(process.execPath, [
  join(root, 'scripts/backup/compare-versions.mjs'),
  backups.get('0006'), backups.get('0010'),
], { cwd: root, env: process.env, encoding: 'utf8' });
if (compare.status !== 0) fail('本地 0006/0010 备份比较失败');
process.stdout.write(compare.stdout || '');
