import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:upgrade-0006-0010 运行测试');
const migrations = [
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
const baseTables = [
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
const targetTables = [
  ...baseTables.slice(0, 9),
  'phone_change_challenges',
  ...baseTables.slice(9, 12),
  'sms_verifications',
  ...baseTables.slice(12, 13),
  'user_identities',
  ...baseTables.slice(13),
];
const work = await mkdtemp(join(tmpdir(), 'upgrade-0006-0010-'));
const state = join(work, 'state');
const config = join(work, 'wrangler.jsonc');

function ok(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

function cleanEnvironment() {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  return environment;
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, 'exec', 'wrangler', ...args], {
    cwd: root,
    env: cleanEnvironment(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || '本地 D1 命令失败');
  return result.stdout;
}

function resultRows(output) {
  const start = output.indexOf('[');
  if (start < 0) throw new Error('无法解析本地 D1 输出');
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

await writeFile(
  config,
  JSON.stringify({
    name: `upgrade-test-${randomUUID()}`,
    compatibility_date: '2026-09-01',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'upgrade-test',
        database_id: '00000000-0000-4000-8000-000000000000',
      },
    ],
  }),
);
const d1 = [
  'd1',
  'execute',
  'upgrade-test',
  '--local',
  '--config',
  config,
  '--persist-to',
  state,
];
const sql = (command) =>
  resultRows(run([...d1, '--command', command, '--json']));

for (const migration of migrations.slice(0, 7)) {
  run([...d1, '--file', join(root, 'drizzle', migration)]);
}
const ledger = join(work, 'migration-ledger.sql');
await writeFile(
  ledger,
  `CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);\n${migrations
    .slice(0, 7)
    .map((name, index) => `INSERT INTO d1_migrations(id,name) VALUES(${index + 1},'${name}');`)
    .join('\n')}\n`,
);
run([...d1, '--file', ledger]);
run([
  ...d1,
  '--file',
  join(root, 'scripts', 'backup', 'fixtures', 'local-test-data-0006.sql'),
]);

const beforeCounts = Object.fromEntries(
  baseTables.map((table) => [
    table,
    Number(sql(`SELECT COUNT(*) AS total FROM "${table}"`)[0]?.total ?? -1),
  ]),
);
ok(Object.values(beforeCounts).every((count) => count > 0), '0006 的16张业务表均含测试数据');
ok(
  targetTables
    .filter((table) => !baseTables.includes(table))
    .every(
      (table) =>
        Number(
          sql(
            `SELECT COUNT(*) AS total FROM sqlite_schema WHERE type='table' AND name='${table}'`,
          )[0]?.total ?? -1,
        ) === 0,
    ),
  '升级前3张认证新表尚不存在',
);

const unchangedTables = [
  'users',
  'user_sessions',
  'family_users',
  'persons',
  'relationships',
];
const beforeRows = Object.fromEntries(
  unchangedTables.map((table) => [
    table,
    sql(`SELECT * FROM "${table}" ORDER BY rowid`),
  ]),
);
const beforeFamilies = sql('SELECT * FROM families ORDER BY id');

for (let index = 7; index < migrations.length; index += 1) {
  const migration = migrations[index];
  run([...d1, '--file', join(root, 'drizzle', migration)]);
  run([
    ...d1,
    '--command',
    `INSERT INTO d1_migrations(id,name) VALUES(${index + 1},'${migration}')`,
  ]);
}

const actualBusinessTables = sql(
  "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
)
  .map((row) => row.name)
  .filter((name) => targetTables.includes(name));
ok(
  actualBusinessTables.length === targetTables.length &&
    targetTables.every((table) => actualBusinessTables.includes(table)),
  '升级后恰好存在19张业务表',
);
for (const table of baseTables) {
  const after = Number(sql(`SELECT COUNT(*) AS total FROM "${table}"`)[0]?.total ?? -1);
  ok(after === beforeCounts[table], `${table} 行数保持 ${after}`);
}
for (const table of unchangedTables) {
  ok(
    JSON.stringify(sql(`SELECT * FROM "${table}" ORDER BY rowid`)) ===
      JSON.stringify(beforeRows[table]),
    `${table} 内容未变化`,
  );
}

const afterFamilies = sql('SELECT * FROM families ORDER BY id');
for (const beforeFamily of beforeFamilies) {
  const afterFamily = afterFamilies.find((family) => family.id === beforeFamily.id);
  ok(Boolean(afterFamily), `族谱 ${beforeFamily.id} 未丢失`);
  const beforeComparable = { ...beforeFamily };
  const afterComparable = { ...afterFamily };
  delete beforeComparable.join_code;
  delete afterComparable.join_code;
  ok(
    JSON.stringify(afterComparable) === JSON.stringify(beforeComparable),
    `族谱 ${beforeFamily.id} 除加入码外未变化`,
  );
  if (beforeFamily.source_type === 'LEGACY_STATIC') {
    ok(
      typeof afterFamily.join_code === 'string' &&
        afterFamily.join_code.startsWith('LEGACY-DISABLED-') &&
        afterFamily.join_code !== beforeFamily.join_code,
      '0010 仅失效旧静态族谱加入码',
    );
  } else {
    ok(afterFamily.join_code === beforeFamily.join_code, '数据库族谱加入码保持不变');
  }
}
ok(
  Number(sql("SELECT COUNT(*) AS total FROM user_identities WHERE provider='PHONE'")[0]?.total ?? -1) ===
    1,
  '0007 只回填已验证且规范化的手机号身份',
);
ok(
  Number(sql('SELECT COUNT(*) AS total FROM sms_verifications')[0]?.total ?? -1) === 0 &&
    Number(sql('SELECT COUNT(*) AS total FROM phone_change_challenges')[0]?.total ?? -1) === 0,
  '其他新认证表为空且创建成功',
);
ok(
  sql('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')[0]?.name ===
    '0010_security_s0_containment.sql',
  'migration ledger 最终为0010',
);
ok(sql('PRAGMA foreign_key_check').length === 0, '0006→0010 外键检查通过');
console.log('PASS：0006/16表到0010/19表迁移完整性验证全部通过。');
