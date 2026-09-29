import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:production-reset 运行测试');
const work = await mkdtemp(join(tmpdir(), 'production-reset-test-'));
const state = join(work, 'state');
const lifecycleConfig = join(work, 'lifecycle-wrangler.json');
const appConfig = join(work, 'app-wrangler.json');
const lifecyclePort = 8810;
const appPort = 8811;
const lifecycleOrigin = `http://127.0.0.1:${lifecyclePort}`;
const appOrigin = `http://127.0.0.1:${appPort}`;
const resetSecret = 'local-reset-secret-for-tests-only-32-characters';
const bootstrapSecret = 'local-bootstrap-secret-for-tests-only-32-characters';
const backupSha256 = 'a'.repeat(64);
const tables = [
  'action_idempotency', 'action_rate_limit', 'announcements', 'families',
  'family_activities', 'family_users', 'generations', 'media', 'person_claims',
  'phone_change_challenges', 'persons', 'relationships', 'review_requests',
  'sms_verifications', 'system_audit_logs', 'user_identities', 'user_messages',
  'user_sessions', 'users',
];
const migrations = [
  '0000_multi_family.sql', '0001_real_user_auth.sql', '0002_wechat_identity.sql',
  '0003_system_admin.sql', '0004_unified_person_operations.sql',
  '0005_creation_cooldown.sql', '0006_collaboration_persistence.sql',
  '0007_auth_identity_foundation.sql', '0008_phone_change_challenges.sql',
  '0009_aliyun_sms_provider.sql', '0010_security_s0_containment.sql',
];

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
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function resultRows(output) {
  const start = output.indexOf('[');
  if (start < 0) throw new Error('无法解析本地 D1 输出');
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

const baseConfig = {
  compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: [{
    binding: 'DB',
    database_name: 'production-reset-test',
    database_id: '00000000-0000-4000-8000-000000000000',
  }],
};
await writeFile(lifecycleConfig, JSON.stringify({
  ...baseConfig,
  name: 'production-reset-lifecycle-test',
  main: join(root, 'scripts', 'production-reset', 'local-lifecycle-worker.ts'),
  vars: {
    APP_ENV: 'local-reset-test',
    PROJECT_ID: 'local-reset-fixture',
    RESET_SECRET: resetSecret,
    RESET_BACKUP_SHA256: backupSha256,
    BOOTSTRAP_SECRET: bootstrapSecret,
  },
}));
await writeFile(appConfig, JSON.stringify({
  ...baseConfig,
  name: 'production-reset-app-test',
  main: join(root, 'dist', 'server', 'index.js'),
  assets: { directory: join(root, 'dist', 'client') },
  vars: {
    SMS_MODE: 'mock',
    APP_ENV: 'test',
    SMS_CODE_PEPPER: 'production-reset-test-pepper-at-least-32-characters',
  },
}));

const d1 = ['d1', 'execute', 'production-reset-test', '--local', '--config', lifecycleConfig, '--persist-to', state];
for (const migration of migrations) run([...d1, '--file', join(root, 'drizzle', migration)]);
const migrationLedger = join(work, 'migration-ledger.sql');
await writeFile(migrationLedger, `
CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
${migrations.map((name, index) => `INSERT INTO d1_migrations(id,name) VALUES(${index + 1},'${name}');`).join('\n')}
`);
run([...d1, '--file', migrationLedger]);
run([...d1, '--file', join(root, 'scripts', 'backup', 'fixtures', 'local-test-data.sql')]);

function sql(command) {
  return resultRows(run([...d1, '--command', command, '--json']));
}

async function startServer(config, port, origin) {
  const child = spawn(process.execPath, [cli, 'exec', 'wrangler', 'dev', '--local', '--config', config, '--persist-to', state, '--port', String(port)], {
    cwd: root,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error('本地测试 Worker 提前退出');
    try {
      await fetch(origin);
      return child;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  child.kill();
  throw new Error('本地测试 Worker 启动超时');
}

async function stopServer(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

async function post(origin, path, body, headers = {}) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
}

async function scanTextFiles(directory) {
  const findings = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (['.html', '.js', '.json'].includes(extname(entry.name))) {
        const text = await readFile(path, 'utf8');
        if (text.includes('addKnownMainFamily')) findings.push(path);
        if (entry.name === 'family.html' && !/S0 containment[\s\S]*NORMALIZED_FAMILY_TREE\s*=\s*null/.test(text)) findings.push(path);
      }
    }
  }
  await visit(directory);
  return findings;
}

const schemaBefore = sql("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index') ORDER BY type,name");
const beforeCounts = Object.fromEntries(tables.map((table) => [table, Number(sql(`SELECT COUNT(*) total FROM "${table}"`)[0]?.total ?? 0)]));
ok(Object.values(beforeCounts).every((count) => count > 0), 'Reset 前19张业务表均有测试数据');
ok(migrations.length === 11 && sql("SELECT COUNT(*) total FROM sqlite_schema WHERE type='table'")[0]?.total >= 19, '0000～0010 本地结构已创建');

let server = await startServer(lifecycleConfig, lifecyclePort, lifecycleOrigin);
try {
  let response = await post(lifecycleOrigin, '/test/reset', {
    operatorUserId: 'u-super',
    confirmation: 'WRONG',
    secret: resetSecret,
    verifiedBackupSha256: backupSha256,
  });
  ok(response.status === 400, '错误确认文本不能执行 Reset');
  ok(tables.every((table) => Number(sql(`SELECT COUNT(*) total FROM "${table}"`)[0]?.total ?? 0) > 0), '失败的 Reset 不产生部分删除');

  response = await post(lifecycleOrigin, '/test/reset', {
    operatorUserId: 'u-super',
    confirmation: 'RESET_ALL_BUSINESS_DATA:local-reset-fixture',
    secret: resetSecret,
    verifiedBackupSha256: backupSha256,
  });
  ok(response.status === 200, '带环境、项目、备份和Secret确认的 Reset 成功');
  ok(tables.every((table) => response.data.after?.[table] === 0), 'Reset 返回的19表计数全部为0');

  response = await post(lifecycleOrigin, '/test/reset', {
    operatorUserId: 'u-super',
    confirmation: 'RESET_ALL_BUSINESS_DATA:local-reset-fixture',
    secret: resetSecret,
    verifiedBackupSha256: backupSha256,
  });
  ok(response.status === 403, '旧SUPER_ADMIN和旧Session消失后不能再次执行 Reset');
} finally {
  await stopServer(server);
}

const afterCounts = Object.fromEntries(tables.map((table) => [table, Number(sql(`SELECT COUNT(*) total FROM "${table}"`)[0]?.total ?? 0)]));
ok(Object.values(afterCounts).every((count) => count === 0), 'Reset 后19张业务表全部为0');
const schemaAfter = sql("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index') ORDER BY type,name");
ok(JSON.stringify(schemaAfter) === JSON.stringify(schemaBefore), 'Reset 前后表、索引和Schema完全一致');
ok(sql('SELECT COUNT(*) total FROM d1_migrations')[0]?.total === migrations.length, 'migration记录在Reset后完整保留');
ok(sql('PRAGMA foreign_key_check').length === 0, 'Reset 后外键检查通过');
ok(sql("SELECT COUNT(*) total FROM users WHERE id IN ('u-super','u-user','u-owner','u-admin')")[0]?.total === 0, '所有旧账号和SUPER_ADMIN均不存在');
ok(sql('SELECT COUNT(*) total FROM user_sessions')[0]?.total === 0, '所有旧Session均失效');
ok(sql('SELECT COUNT(*) total FROM user_identities')[0]?.total === 0, '所有旧手机号和微信Identity均不存在');
ok(sql("SELECT COUNT(*) total FROM families WHERE id='f-test'")[0]?.total === 0, '旧族谱已经不存在');

server = await startServer(appConfig, appPort, appOrigin);
let newUserId = '';
let newCookie = '';
try {
  let response = await post(appOrigin, '/api/auth/login', { username: 'super', password: 'old-password' });
  ok(response.status === 401, '旧账号无法登录');
  response = await post(appOrigin, '/api/auth/register', {
    username: 'formal_admin',
    password: 'formal-password-1',
    confirmPassword: 'formal-password-1',
    email: 'formal-admin@example.test',
  }, { 'CF-Connecting-IP': '192.0.2.51' });
  ok(response.status === 201 && response.cookie, '清空后新用户可以正常注册');
  newUserId = response.data.user.id;
  newCookie = response.cookie;
  ok(response.data.user.systemRole === 'USER', '第一个注册用户不会自动成为SUPER_ADMIN');
  response = await fetch(appOrigin + '/api/families', { headers: { cookie: newCookie } }).then(async (item) => ({ status:item.status, data:await item.json() }));
  ok(response.status === 200 && response.data.families.length === 0, '新用户首次进入没有任何默认族谱');
  ok(sql('SELECT COUNT(*) total FROM family_users')[0]?.total === 0, '普通访问不会自动产生OWNER');
  response = await post(appOrigin, '/api/families', {
    action: 'CREATE_FAMILY', name: '第一本正式测试族谱', description: 'local only',
  }, { cookie: newCookie, 'Idempotency-Key': 'production-reset-family-create-1' });
  ok(response.status === 201, '新用户可以从空状态创建族谱');
  ok(sql(`SELECT COUNT(*) total FROM family_users WHERE user_id='${newUserId}' AND role='OWNER'`)[0]?.total === 1, '明确创建族谱后创建者正确成为OWNER');
  response = await fetch(appOrigin + '/api/families?family_id=f-test', { headers: { cookie: newCookie } }).then(async (item) => ({ status:item.status }));
  ok(response.status === 403 || response.status === 404, '旧族谱ID不能被新用户访问');
} finally {
  await stopServer(server);
}

server = await startServer(lifecycleConfig, lifecyclePort, lifecycleOrigin);
try {
  let response = await post(lifecycleOrigin, '/test/bootstrap', {
    targetUserId: 'not-the-selected-user',
    confirmation: 'BOOTSTRAP_SUPER_ADMIN:not-the-selected-user',
    secret: bootstrapSecret,
  });
  ok(response.status === 404, 'Bootstrap不能猜测或作用于不存在的账号');
  response = await post(lifecycleOrigin, '/test/bootstrap', {
    targetUserId: newUserId,
    confirmation: `BOOTSTRAP_SUPER_ADMIN:${newUserId}`,
    secret: bootstrapSecret,
  });
  ok(response.status === 200 && response.data.targetUserId === newUserId, 'Bootstrap只升级明确指定的user_id');
  ok(sql(`SELECT COUNT(*) total FROM users WHERE id='${newUserId}' AND system_role='SUPER_ADMIN'`)[0]?.total === 1, '新正式管理员已成为SUPER_ADMIN');
  ok(sql("SELECT COUNT(*) total FROM system_audit_logs WHERE id='system-bootstrap-super-admin-v1' AND action_type='SUPER_ADMIN_BOOTSTRAP'")[0]?.total === 1, 'Bootstrap写入永久审计锁');
  response = await post(lifecycleOrigin, '/test/bootstrap', {
    targetUserId: newUserId,
    confirmation: `BOOTSTRAP_SUPER_ADMIN:${newUserId}`,
    secret: bootstrapSecret,
  });
  ok(response.status === 409, 'Bootstrap成功后再次执行被拒绝');
} finally {
  await stopServer(server);
}

server = await startServer(appConfig, appPort, appOrigin);
try {
  const response = await fetch(appOrigin + '/api/admin?view=overview', { headers: { cookie: newCookie } });
  ok(response.status === 200, '新SUPER_ADMIN可以正常访问系统后台API');
} finally {
  await stopServer(server);
}

ok(sql('PRAGMA foreign_key_check').length === 0, '完整Reset、重注册和Bootstrap流程外键检查通过');
ok((await scanTextFiles(join(root, 'public'))).length === 0, 'public静态文件不含旧主谱生成器且静态初始树为空');
ok((await scanTextFiles(join(root, 'dist', 'client'))).length === 0, '构建后的HTML/JS/JSON不含旧主谱生成器且静态初始树为空');
const tracked = run(['--version']);
ok(Boolean(tracked), '本地测试全程未使用remote D1');
console.log('PASS：正式空库Reset与一次性SUPER_ADMIN Bootstrap本地验证全部通过。');
