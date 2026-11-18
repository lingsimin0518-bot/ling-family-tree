import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { localFetch as fetch } from '../test-support/local-http.mjs';
import { TABLES_0010, MIGRATIONS_0010 } from '../backup/profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = await mkdtemp(join(tmpdir(), 'initial-user-local-'));
const config = join(work, 'wrangler.jsonc');
const state = join(work, 'state');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const secret = randomBytes(32).toString('hex');
const password = `fixture-${randomBytes(18).toString('hex')}`;
const publicOrigin = 'https://family-tree.lingsimin0518.chatgpt.site';
const route = '/api/admin/operations/initial-user';
const projectId = 'appgprj_6a9b746cbba88191bd63914f864ffb5e';
const base = { name: 'local-initial-user-test', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'],
  d1_databases: [{ binding: 'DB', database_name: 'local-initial-user', database_id: '00000000-0000-4000-8000-000000000000' }] };
const vars = { APP_ENV: 'production', MAINTENANCE_MODE: 'true', PRODUCTION_RESET_ENABLED: 'false',
  INITIAL_USER_REGISTRATION_ENABLED: 'true', INITIAL_USER_REGISTRATION_ALLOWED_PROJECT_ID: projectId,
  LOCAL_INITIAL_USER_TEST_ONLY: 'true' };
await writeFile(config, JSON.stringify({ ...base, main: join(root, 'scripts/initial-user/local-initial-user-worker.ts'), vars }));
// Synthetic runtime credentials only, deliberately outside Git and vars output.
await writeFile(join(work, '.dev.vars'), `INITIAL_USER_REGISTRATION_SECRET="${secret}"\nLOCAL_TEST_PASSWORD="${password}"\n`);
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(work, 'tool.log') };
delete environment.CLOUDFLARE_API_TOKEN; delete environment.CLOUDFLARE_ACCOUNT_ID;
let child;
let origin;
let output = '';
let assertions = 0;
function ok(value, label) { if (!value) throw new Error(`FAIL ${label}`); assertions += 1; console.log(`PASS ${label}`); }
function cli(args) {
  if (child) throw new Error('Do not start another SQLite owner while Worker is running');
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, env: environment,
    encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .replaceAll(secret, '[REDACTED]').replaceAll(password, '[REDACTED]')
      .replace(/\b[A-Za-z0-9_-]{64,}\b/g, '[REDACTED]');
    throw new Error(`Local D1 setup failed (${result.status ?? result.error?.code}): ${diagnostic.slice(-3000)}`);
  }
  return result.stdout;
}
const d1 = ['d1', 'execute', 'local-initial-user', '--local', '--config', config, '--persist-to', state];
for (const name of MIGRATIONS_0010) cli([...d1, '--file', join(root, 'drizzle', name)]);
const ledger = join(work, 'ledger.sql');
await writeFile(ledger, `CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);\n${MIGRATIONS_0010.map((name, index) => `INSERT INTO d1_migrations VALUES(${index + 1},'${name}');`).join('\n')}`);
cli([...d1, '--file', ledger]);

async function start(readyPath) {
  const listener = createServer();
  await new Promise((done, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', done); });
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', state, '--port', String(port)], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-1024 * 1024); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-1024 * 1024); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try { const response = await fetch(origin + readyPath, { signal: AbortSignal.timeout(1000) }); if (response.status === 200) return; } catch { /* readiness GET only */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  await stop(); throw new Error('Local initial-user Worker not ready; no credential output');
}
async function stop() {
  if (!child) return;
  const running = child;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(running.pid), '/T', '/F'], { stdio: 'ignore' });
  else running.kill();
  if (running.exitCode === null && running.signalCode === null) await new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('Worker exit timeout')), 10_000);
    running.once('exit', () => { clearTimeout(timeout); done(); });
  });
  running.stdout.destroy(); running.stderr.destroy(); running.unref(); child = undefined;
}
const body = { projectId, username: 'initial_local_user', password, confirmPassword: password, email: 'initial@example.test' };
async function send(options = {}) {
  const { method = 'POST', path = route, patch = {}, scenario, headers = {}, raw, probe = false } = options;
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000),
    headers: { Origin: publicOrigin, 'Sec-Fetch-Site': 'same-origin',
      ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(probe
        ? { 'X-Initial-User-Availability-Check': 'v1' } : { 'X-Initial-User-Registration-Secret': secret }) } : {}),
      ...(scenario ? { 'X-Local-Test-Scenario': scenario } : {}), ...headers },
    ...(method === 'POST' ? { body: raw ?? (probe ? '{}' : JSON.stringify({ ...body, ...patch })) } : {}) });
  const text = await response.text();
  ok(!text.includes(secret) && !text.includes(password) && !text.includes('pbkdf2_sha256$') && !text.includes('INSERT INTO'), '响应不含Secret、密码、哈希或SQL');
  ok(!response.headers.has('set-cookie') && response.headers.get('cache-control') === 'private, no-store', '不签发Session/Cookie且响应禁止缓存');
  return { status: response.status, data: JSON.parse(text), headers: response.headers };
}
async function fixture(action) {
  const response = await fetch(origin + '/fixture/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  if (!response.ok) throw new Error('Local fixture action failed');
}
async function current() { return (await fetch(origin + '/fixture/state')).json(); }
async function denial(options, status, code, label) {
  const before = await current();
  const result = await send(options);
  const after = await current();
  ok(result.status === status && result.data.code === code, `${label}（${result.status}/${result.data.code}）`);
  ok(JSON.stringify(before) === JSON.stringify(after), `${label}不改变本地数据库`);
}

await start('/fixture/ready');
try {
  const original = await current();
  ok(Object.keys(original.counts).length === 19 && Object.values(original.counts).every((n) => n === 0), '全新0010/19表夹具全部为空');
  await denial({ method: 'GET' }, 405, 'METHOD_NOT_ALLOWED', 'GET不创建账号');
  await denial({ scenario: 'disabled' }, 503, 'INITIAL_USER_REGISTRATION_DISABLED', '开关false拒绝');
  await denial({ scenario: 'missing-enabled' }, 503, 'INITIAL_USER_REGISTRATION_DISABLED', '默认不开启');
  await denial({ scenario: 'maintenance-off' }, 503, 'MAINTENANCE_REQUIRED', '非维护模式拒绝');
  await denial({ scenario: 'wrong-environment' }, 409, 'INITIAL_USER_TARGET_MISMATCH', '非production拒绝');
  await denial({ scenario: 'wrong-project' }, 409, 'INITIAL_USER_TARGET_MISMATCH', '服务端错误project拒绝');
  await denial({ patch: { projectId: 'wrong-project' } }, 409, 'INITIAL_USER_TARGET_MISMATCH', '请求错误project拒绝');
  await denial({ scenario: 'reset-enabled' }, 503, 'INITIAL_USER_RESET_NOT_DISARMED', 'Reset武装时拒绝');
  await denial({ scenario: 'old-reset-secret' }, 503, 'INITIAL_USER_RESET_NOT_DISARMED', '旧Reset Secret未删除时拒绝');
  await denial({ scenario: 'missing-secret' }, 503, 'INITIAL_USER_SECRET_NOT_CONFIGURED', '缺少服务端Secret拒绝');
  await denial({ scenario: 'weak-secret' }, 503, 'INITIAL_USER_SECRET_NOT_CONFIGURED', '弱格式服务端Secret拒绝');
  await denial({ headers: { 'X-Initial-User-Registration-Secret': randomBytes(32).toString('hex') } }, 403, 'INITIAL_USER_SECRET_INVALID', '错误Secret拒绝');
  await denial({ headers: { Origin: 'https://attacker.example' } }, 403, 'INITIAL_USER_ORIGIN_INVALID', '跨站Origin拒绝');
  await denial({ headers: { 'X-Local-Test-Host': 'attacker.example' } }, 403, 'INITIAL_USER_ORIGIN_INVALID', '错误Host拒绝');
  await denial({ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'INITIAL_USER_ORIGIN_INVALID', '跨站fetch元数据拒绝');
  await denial({ path: route + '?trigger=true' }, 403, 'INITIAL_USER_ORIGIN_INVALID', '任何query触发拒绝');
  await denial({ patch: { secret } }, 400, 'INITIAL_USER_REQUEST_INVALID', 'JSON中放Secret拒绝');
  await denial({ patch: { user_id: 'chosen-id' } }, 400, 'INITIAL_USER_REQUEST_INVALID', '手工user_id拒绝');
  await denial({ patch: { system_role: 'SUPER_ADMIN' } }, 400, 'INITIAL_USER_REQUEST_INVALID', '角色输入拒绝');
  await denial({ raw: '{' }, 400, 'INITIAL_USER_REQUEST_INVALID', '无效JSON拒绝');
  await denial({ raw: 'x'.repeat(4097) }, 413, 'INITIAL_USER_REQUEST_INVALID', '超长请求拒绝');
  for (const patch of [{ username: 'bad-name!' }, { password: 'short', confirmPassword: 'short' }, { confirmPassword: 'different' }, { email: 'invalid' }, { email: '' }]) {
    await denial({ patch }, 400, 'INITIAL_USER_VALIDATION_FAILED', '现有正式账号校验仍生效');
  }
  await fixture('unknown-table');
  await denial({}, 409, 'INITIAL_USER_UNKNOWN_TABLES', '未知额外表fail closed');
  await fixture('remove-unknown');
  await fixture('old-schema');
  await denial({}, 409, 'INITIAL_USER_SCHEMA_MISMATCH', '不是0010拒绝');
  await fixture('restore-schema');
  await fixture('missing-table');
  await denial({}, 409, 'INITIAL_USER_SCHEMA_MISMATCH', '缺少业务表拒绝');
  await fixture('restore-table');
  await fixture('add-user');
  await denial({}, 409, 'INITIAL_USER_ALREADY_EXISTS', 'users已存在拒绝');
  await fixture('clear');
  await fixture('add-family');
  await denial({}, 409, 'INITIAL_USER_DATABASE_NOT_EMPTY', 'families非0拒绝');
  await fixture('clear');
  await denial({ probe: true, headers: { 'X-Initial-User-Availability-Check': 'wrong' } }, 400, 'INITIAL_USER_AVAILABILITY_INVALID', '错误只读检查标记拒绝');
  await denial({ probe: true, headers: { 'X-Initial-User-Registration-Secret': secret } }, 400, 'INITIAL_USER_AVAILABILITY_INVALID', '只读检查禁止携带Secret');
  await denial({ probe: true, raw: JSON.stringify(body) }, 400, 'INITIAL_USER_AVAILABILITY_INVALID', '只读检查禁止携带账号创建参数');
  const beforeAvailability = await current();
  let availability = await send({ probe: true });
  ok(availability.status === 200 && availability.data.available === true
    && Object.keys(availability.data).sort().join(',') === 'available,projectId,runtimeDeploymentVerification', '状态接口只公开空库可用性，不暴露账号或Secret');
  ok(JSON.stringify(beforeAvailability) === JSON.stringify(await current()), '只读检查不写任何表且不能创建账号');

  for (const failure of ['fail-insert', 'ignore-insert', 'promote-insert', 'family-insert']) {
    await fixture(failure);
    const before = await current();
    const result = await send();
    const after = await current();
    ok(result.status === 500 && result.data.code === 'INITIAL_USER_CREATION_FAILED', `${failure}使真实D1 batch整体失败`);
    ok(JSON.stringify(before) === JSON.stringify(after) && Object.values(after.counts).every((n) => n === 0), `${failure}完整回滚，无用户、锁、管理员或业务残留`);
    await fixture('remove-failure');
  }

  let result = await send();
  ok(result.status === 201 && result.data.user.system_role === 'USER' && result.data.user.status === 'ACTIVE', '正确空库只创建ACTIVE USER');
  ok(Object.keys(result.data.user).sort().join(',') === 'id,status,system_role,username', '成功响应只含安全账号字段');
  let after = await current();
  ok(after.counts.users === 1 && TABLES_0010.filter((table) => table !== 'users').every((table) => after.counts[table] === 0), '只增加一个users；Session、锁和全部业务数据仍0');
  ok(after.users[0].passwordMatches && after.users[0].saltedHash, '复用正式加盐PBKDF2及密码校验');
  ok(after.users.every((user) => user.system_role === 'USER') && after.counts.family_users === 0, '不会自动SUPER_ADMIN或OWNER');
  await denial({}, 409, 'INITIAL_USER_ALREADY_EXISTS', '成功后第二次创建被拒绝');
  availability = await send({ probe: true });
  ok(availability.status === 409 && !availability.data.available, '创建后状态不再允许显示表单');
  await fixture('clear');
  const concurrent = await Promise.all([0, 1, 2].map((n) => send({ patch: { username: `concurrent_${n}`, email: `concurrent-${n}@example.test` } })));
  ok(concurrent.filter((item) => item.status === 201).length === 1 && concurrent.filter((item) => item.status === 409).length === 2, '3个不同合法账号并发，只1个成功');
  after = await current();
  ok(after.counts.users === 1 && TABLES_0010.filter((table) => table !== 'users').every((table) => after.counts[table] === 0), '并发结束只有一个USER，其余18表0');
  ok(after.users[0].system_role === 'USER' && after.foreignKeys.length === 0, '并发后无SUPER_ADMIN且FK为0 violations');
  ok(JSON.stringify(after.schema) === JSON.stringify(original.schema) && JSON.stringify(after.migrations) === JSON.stringify(original.migrations), 'schema、索引及11条migration不变');
  for (const path of ['/api/auth/register', '/api/auth/register/phone']) {
    result = await send({ path });
    ok(result.status === 503 && result.data.code === 'SERVICE_MAINTENANCE', `${path}原维护门禁保持`);
  }
  ok(!output.includes(secret) && !output.includes(password), '本地运行日志不包含测试Secret或密码');
} finally { await stop(); }

// Actual framework build: no operational opt-in or secret is supplied.
await unlink(join(work, '.dev.vars'));
await writeFile(config, JSON.stringify({ ...base, main: join(root, 'dist/server/index.js'),
  // Match the generated deployment config. Rebundling this already-built
  // multi-module Worker can stall lazy route loading in local Wrangler.
  no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
  assets: { directory: join(root, 'dist/client') }, vars: { APP_ENV: 'production', MAINTENANCE_MODE: 'true', PRODUCTION_RESET_ENABLED: 'false' } }));
// Independent application instances prevent Wrangler's development proxy from
// restarting one POST in response to an earlier POST. No POST is retried and
// every original status/header assertion is retained. This is local HTTP
// coverage, not a claim of production or shared-instance continuous acceptance.
for (const testCase of [
  { options: {}, code: 'INITIAL_USER_REGISTRATION_DISABLED', label: '真实构建默认关闭，无需Session仍fail closed' },
  { options: { probe: true }, code: 'INITIAL_USER_REGISTRATION_DISABLED', label: '真实构建默认不公开注册表单状态' },
  { options: { path: '/api/auth/register' }, code: 'SERVICE_MAINTENANCE', label: '真实构建普通注册仍503' },
  { options: { path: '/api/auth/register/phone' }, code: 'SERVICE_MAINTENANCE', label: '真实构建手机注册仍503' },
]) {
  await start('/api/health');
  try {
    const read = await send({ method: 'GET' });
    ok(read.status === 405, '独立真实构建实例GET入口405');
    const result = await send(testCase.options);
    ok(result.status === 503 && result.data.code === testCase.code && !result.data.available, testCase.label);
  } finally { await stop(); }
}
const countsOutput = cli([...d1, '--command', `SELECT ${TABLES_0010.map((table) =>
  `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(',')}`, '--json']);
const countsRow = JSON.parse(countsOutput.slice(countsOutput.indexOf('[')))[0].results[0];
ok(TABLES_0010.every((table) => Number(countsRow[table]) === (table === 'users' ? 1 : 0)), '所有构建后禁用态请求均不改变19表数据');

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (['.js', '.json', '.html', '.css'].includes(extname(file))) {
      const text = await readFile(file, 'utf8');
      if (text.includes(secret) || text.includes(password) || text.includes('LOCAL_INITIAL_USER_TEST_ONLY') || text.includes('/fixture/action')) throw new Error('Fixture/credential leaked into build');
    }
  }
}
await scan(join(root, 'dist'));
const persistedLogs = await readFile(join(work, 'tool.log'), 'utf8');
ok(!output.includes(secret) && !output.includes(password)
  && !persistedLogs.includes(secret) && !persistedLogs.includes(password), '控制台和Wrangler日志均不含测试Secret或密码');
console.log(`PASS initial-user: ${assertions} checks; real local D1; no production migrations/calls, SMS or deployment.`);
