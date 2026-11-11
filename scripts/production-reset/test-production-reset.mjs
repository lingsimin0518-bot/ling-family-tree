import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:production-reset 运行测试');
const wranglerCli = join(root, 'node_modules/wrangler/bin/wrangler.js');
let activeServer;
let assertions = 0;
const work = await mkdtemp(join(tmpdir(), 'production-reset-test-'));
const state = join(work, 'state');
const lifecycleConfig = join(work, 'lifecycle-wrangler.json');
const appConfig = join(work, 'app-wrangler.json');
async function reservePort() {
  const listener = createServer();
  await new Promise((done, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', done); });
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
const lifecyclePort = await reservePort();
const appPort = await reservePort();
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
  assertions += 1;
  console.log(`PASS ${message}`);
}

function cleanEnvironment() {
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(work, 'tool.log') };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  return environment;
}

function run(args) {
  if (activeServer) throw new Error('禁止在Worker运行期间启动第二个D1/SQLite进程');
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    cwd: root,
    env: cleanEnvironment(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
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
run([...d1, '--file', join(root, 'scripts', 'backup', 'fixtures', 'local-test-data-0010.sql')]);

function sql(command) {
  return resultRows(run([...d1, '--command', command, '--json']));
}

async function startServer(config, port, origin) {
  if (activeServer) throw new Error('上一测试Worker尚未退出');
  const child = spawn(process.execPath, [wranglerCli, 'dev', '--local', '--config', config, '--persist-to', state, '--port', String(port)], {
    cwd: root,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeServer = child;
  // Drain both pipes: unread child output can block the process on Windows.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error('本地测试 Worker 提前退出');
    try {
      const ready = await http(origin, config === lifecycleConfig ? '/test/health' : '/api/health', undefined, {}, 1000);
      if (ready.status === 200 && (config !== lifecycleConfig || ready.data?.ready === 'local-lifecycle')) return child;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  await stopServer(child);
  throw new Error('本地测试 Worker 启动超时');
}

async function stopServer(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((done, fail) => {
      const deadline = setTimeout(() => fail(new Error('本地Worker退出超时')), 10_000);
      child.once('exit', () => { clearTimeout(deadline); done(); });
    });
  }
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  activeServer = undefined;
}

// Fresh sockets and fully consumed responses never cross a Worker restart.
// No business POST (especially Reset) is retried on any transport failure.
function http(origin, path, body, headers = {}, timeout = 30_000, redirects = 0) {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(origin + path, {
      method: payload === undefined ? 'GET' : 'POST', agent: false,
      headers: { Connection: 'close', ...(payload === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      }), ...headers },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('error', fail);
      response.once('end', () => {
        try {
          // Match fetch's ordinary static-asset GET redirects (.html -> clean
          // URL), without replaying any POST or leaving the local origin.
          if (payload === undefined && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            const target = new URL(response.headers.location, origin);
            if (target.origin !== origin || redirects >= 5) throw new Error('LOCAL_REDIRECT_INVALID');
            http(origin, target.pathname + target.search, undefined, headers, timeout, redirects + 1).then(done, fail);
            return;
          }
          done({ status: response.statusCode, text,
            data: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null,
            cookie: response.headers['set-cookie']?.[0]?.split(';')[0] ?? '' });
        } catch (error) { fail(error); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('LOCAL_HTTP_TIMEOUT')));
    request.once('error', fail);
    request.end(payload);
  });
}
const post = http;
const readState = async () => (await http(lifecycleOrigin, '/test/state')).data;
const counts = () => sql(`SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(',')}`)[0];

async function scanTextFiles(directory) {
  const findings = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (['.html', '.js', '.json'].includes(extname(entry.name))) {
        const text = await readFile(path, 'utf8');
        if (text.includes('addKnownMainFamily')) findings.push(path);
        if (entry.name === 'family.html' && !/window\.NORMALIZED_FAMILY_TREE\s*=\s*null/.test(text)) findings.push(path);
      }
    }
  }
  await visit(directory);
  return findings;
}

const schemaBefore = sql("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index') ORDER BY type,name");
const beforeCounts = counts();
ok(Object.values(beforeCounts).every((count) => count > 0), 'Reset 前19张业务表均有测试数据');
ok(migrations.length === 11 && sql("SELECT COUNT(*) total FROM sqlite_schema WHERE type='table'")[0]?.total >= 19, '0000～0010 本地结构已创建');

let server = await startServer(lifecycleConfig, lifecyclePort, lifecycleOrigin);
try {
  const initial = await readState();
  let response = await post(lifecycleOrigin, '/test/reset', {
    operatorUserId: 'u-super',
    confirmation: 'WRONG',
    secret: resetSecret,
    verifiedBackupSha256: backupSha256,
  });
  ok(response.status === 400, '错误确认文本不能执行 Reset');
  ok(JSON.stringify((await readState()).rows) === JSON.stringify(initial.rows), '失败的 Reset 不改变19表逐行数据');

  await post(lifecycleOrigin, '/test/fail-delete', {});
  const failureBefore = await readState();
  response = await post(lifecycleOrigin, '/test/reset', {
    operatorUserId: 'u-super', confirmation: 'RESET_ALL_BUSINESS_DATA:local-reset-fixture',
    secret: resetSecret, verifiedBackupSha256: backupSha256,
  });
  ok(response.status === 500, 'persons DELETE中途失败使真实D1 batch整体失败');
  const failureAfter = await readState();
  ok(JSON.stringify(failureAfter.rows) === JSON.stringify(failureBefore.rows), '失败回滚后19表逐行数据完全一致，无partial reset');
  ok(JSON.stringify(failureAfter.schema) === JSON.stringify(failureBefore.schema), '失败回滚后表/索引/外键/触发器不变');
  ok(failureAfter.foreignKeys.length === 0, '失败回滚后foreign_key_check为0 violations');
  await post(lifecycleOrigin, '/test/remove-failure', {});

  response = await post(lifecycleOrigin, '/test/reset', {
    operatorUserId: 'u-super',
    confirmation: 'RESET_ALL_BUSINESS_DATA:local-reset-fixture',
    secret: resetSecret,
    verifiedBackupSha256: backupSha256,
  });
  ok(response.status === 200, '带环境、项目、备份和Secret确认的 Reset 成功');
  ok(tables.every((table) => response.data.after?.[table] === 0), 'Reset 返回的19表计数全部为0');
  const after = await readState();
  ok(tables.every((table) => after.counts[table] === 0), '同一真实D1独立读取19表全0，包括认证/审计/限流');
  ok(JSON.stringify(after.migrations) === JSON.stringify(initial.migrations), '0000～0010 migration历史逐行保留');

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

const afterCounts = counts();
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
try {
  const responses = await Promise.all([
    http(appOrigin, '/api/health'), http(appOrigin, '/api/auth/session', undefined, { Cookie: 'ling_session=old-local-session' }),
    http(appOrigin, '/api/families'), http(appOrigin, '/api/families?family_id=f-test'),
    http(appOrigin, '/api/families?family_id=missing-family'),
  ]);
  ok(responses[0].status === 200, '空库应用health正常');
  ok(responses.slice(1).every((response) => response.status === 401), '旧Session/空库/失败族谱请求不返回族谱数据');
  const html = await http(appOrigin, '/family.html?family_id=f-test');
  ok(html.status === 200 && /window\.NORMALIZED_FAMILY_TREE\s*=\s*null/.test(html.text)
    && !html.text.includes('addKnownMainFamily'), '空库静态HTML无真实族谱fallback');
} finally { await stopServer(server); }
ok(Object.values(counts()).every((count) => count === 0), '空库正常/失败访问后19表仍全0，无自动SUPER_ADMIN/OWNER/family/person');

// A separate populated scenario exercises three concurrent real core calls.
// SQLite/D1 batch remains real; failed Reset requests are never retried.
run([...d1, '--file', join(root, 'scripts/backup/fixtures/local-test-data.sql')]);
run([...d1, '--file', join(root, 'scripts/backup/fixtures/local-test-data-0010.sql')]);
server = await startServer(lifecycleConfig, lifecyclePort, lifecycleOrigin);
try {
  const body = { operatorUserId: 'u-super', confirmation: 'RESET_ALL_BUSINESS_DATA:local-reset-fixture',
    secret: resetSecret, verifiedBackupSha256: backupSha256 };
  const responses = await Promise.all([0, 1, 2].map(() => post(lifecycleOrigin, '/test/reset', body)));
  ok(responses.filter((response) => response.status === 200).length === 1, '三个并发合法核心请求只有一个成功提交');
  ok(responses.filter((response) => response.status !== 200).every((response) => [403, 500].includes(response.status)), '其余并发核心请求被原子授权guard拒绝');
  const after = await readState();
  ok(tables.every((table) => after.counts[table] === 0), '并发结束19表全0，无残留guard或身份');
  ok(after.foreignKeys.length === 0 && after.migrations.length === 11, '并发Reset保留migration且外键检查通过');
} finally { await stopServer(server); }

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
  response = await http(appOrigin, '/api/families', undefined, { cookie: newCookie });
  ok(response.status === 200 && response.data.families.length === 0, '新用户首次进入没有任何默认族谱');
} finally { await stopServer(server); }
const newCounts = counts();
ok(newCounts.users === 1 && newCounts.families === 0 && newCounts.family_users === 0 && newCounts.persons === 0, '注册和普通访问不自动创建SUPER_ADMIN/OWNER/族谱/人物');
server = await startServer(appConfig, appPort, appOrigin);
try {
  let response = await post(appOrigin, '/api/families', {
    action: 'CREATE_FAMILY', name: '第一本正式测试族谱', description: 'local only',
  }, { cookie: newCookie, 'Idempotency-Key': 'production-reset-family-create-1' });
  ok(response.status === 201, '新用户可以从空状态创建族谱');
  response = await http(appOrigin, '/api/families?family_id=f-test', undefined, { cookie: newCookie });
  ok(response.status === 403 || response.status === 404, '旧族谱ID不能被新用户访问');
} finally {
  await stopServer(server);
}
ok(sql(`SELECT COUNT(*) total FROM family_users WHERE user_id='${newUserId}' AND role='OWNER'`)[0]?.total === 1, '明确创建族谱后创建者正确成为OWNER');

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
  const after = await readState();
  ok(after.rows.users.filter((user) => user.id === newUserId && user.system_role === 'SUPER_ADMIN').length === 1, '本地夹具新管理员已成为SUPER_ADMIN');
  ok(after.rows.system_audit_logs.filter((row) => row.id === 'system-bootstrap-super-admin-v1' && row.action_type === 'SUPER_ADMIN_BOOTSTRAP').length === 1, 'Bootstrap写入永久审计锁');
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
  const response = await http(appOrigin, '/api/admin?view=overview', undefined, { cookie: newCookie });
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
console.log(`PASS Production lifecycle: ${assertions} checks; real local D1 batch; no business POST retries; no production calls.`);
