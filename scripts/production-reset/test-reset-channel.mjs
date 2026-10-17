import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { TABLES_0010, MIGRATIONS_0010 } from '../backup/profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:reset-channel 运行');
const work = await mkdtemp(join(tmpdir(), 'production-reset-channel-'));
const state = join(work, 'state');
const config = join(work, 'wrangler.jsonc');
const origin = 'http://127.0.0.1:8830';
const publicOrigin = 'https://lingshi-family-tree.lingsimin0518.chatgpt.site';
const path = '/api/admin/operations/production-reset';
const projectId = 'appgprj_6a9b746cbba88191bd63914f864ffb5e';
const deploymentId = 'appgdep_localtest0123456789';
const secret = randomBytes(64).toString('hex');
const backupSha = createHash('sha256').update('LOCAL-TEST-BACKUP-ONLY').digest('hex');
const tokens = Object.fromEntries(['u-super', 'u-user', 'u-owner', 'u-admin'].map((id) => [id, randomBytes(32).toString('base64url')]));
let assertions = 0;
function ok(value, label) { if (!value) throw new Error(`FAIL ${label}`); assertions += 1; console.log(`PASS ${label}`); }
function environment() {
  const result = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(work, 'tool.log') };
  delete result.CLOUDFLARE_API_TOKEN;
  delete result.CLOUDFLARE_ACCOUNT_ID;
  return result;
}
function wrangler(args) {
  const result = spawnSync(process.execPath, [cli, 'exec', 'wrangler', ...args], {
    cwd: root, env: environment(), encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('本地 D1 命令失败；未输出夹具、凭证或 SQL 内容');
  return result.stdout;
}
const vars = {
  APP_ENV: 'production', LOCAL_RESET_CHANNEL_TEST_ONLY: 'true', MAINTENANCE_MODE: 'true',
  PRODUCTION_RESET_ENABLED: 'true', PRODUCTION_RESET_SECRET: secret,
  PRODUCTION_RESET_ALLOWED_PROJECT_ID: projectId, PRODUCTION_RESET_DATABASE_BINDING: 'DB',
  PRODUCTION_RESET_APPROVED_BACKUP_SHA256: backupSha,
  PRODUCTION_RESET_APPROVED_SITES_VERSION: '41', PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID: deploymentId,
};
const baseConfig = {
  name: `reset-channel-test-${randomUUID()}`, compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: [{ binding: 'DB', database_name: 'local-reset-channel', database_id: '00000000-0000-4000-8000-000000000000' }],
};
await writeFile(config, JSON.stringify({ ...baseConfig, main: join(root, 'scripts/production-reset/local-reset-channel-worker.ts'), vars }));
const d1 = ['d1', 'execute', 'local-reset-channel', '--local', '--config', config, '--persist-to', state];
for (const migration of MIGRATIONS_0010.filter((name) => !name.startsWith('0010_'))) {
  wrangler([...d1, '--file', join(root, 'drizzle', migration)]);
}
for (const fixture of ['local-test-data.sql', 'local-test-data-0010.sql']) {
  wrangler([...d1, '--file', join(root, 'scripts/backup/fixtures', fixture)]);
}
// Populate legacy rows before the data-only 0010 containment migration, just as
// in the real upgrade; never weaken the schema inspector to accept old codes.
wrangler([...d1, '--file', join(root, 'drizzle/0010_security_s0_containment.sql')]);
const setup = join(work, 'local-setup.sql');
await writeFile(setup, [
  'CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);',
  ...MIGRATIONS_0010.map((name, index) => `INSERT INTO d1_migrations(id,name) VALUES(${index + 1},'${name}');`),
  'DELETE FROM user_sessions;',
  ...Object.entries(tokens).map(([id, token]) => `INSERT INTO user_sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES('${createHash('sha256').update(token).digest('base64')}','${id}','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`),
].join('\n'));
wrangler([...d1, '--file', setup]);

let child;
let output = '';
async function start() {
  child = spawn(process.execPath, [cli, 'exec', 'wrangler', 'dev', '--local', '--config', config, '--persist-to', state, '--port', '8830'], {
    cwd: root, env: environment(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (value) => { output = (output + String(value)).slice(-1024 * 1024); });
  child.stderr.on('data', (value) => { output = (output + String(value)).slice(-1024 * 1024); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('本地测试 Worker 退出；未输出运行时配置');
    try { const ready = await fetch(origin, { signal: AbortSignal.timeout(1000), headers: { Connection: 'close' } }); await ready.arrayBuffer(); return; } catch { await new Promise((done) => setTimeout(done, 250)); }
  }
  throw new Error('本地测试 Worker 启动超时');
}
function stop() {
  if (!child) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
}
const body = {
  projectId, databaseBinding: 'DB', schema: '0010', sitesVersion: 41, deploymentId,
  backupSha256: backupSha, confirmation: `RESET_ALL_BUSINESS_DATA:${projectId}`,
};
async function reset(options = {}) {
  const { user = 'u-super', patch = {}, headers = {}, scenario, method = 'POST', raw, query = '' } = options;
  const response = await fetch(origin + path + query, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { Connection: 'close',
      ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: publicOrigin,
        'X-Production-Reset-Secret': secret } : {}),
      ...(user ? { Cookie: `ling_session=${tokens[user]}` } : {}),
      ...(scenario ? { 'X-Local-Test-Scenario': scenario } : {}), ...headers },
    ...(method === 'POST' ? { body: raw ?? JSON.stringify({ ...body, ...patch }) } : {}),
  });
  const text = await response.text();
  ok(!text.includes(secret) && !Object.values(tokens).some((token) => text.includes(token))
    && !text.includes('SELECT ') && !text.includes('DELETE FROM') && !text.includes('local simulated'), '响应不暴露凭证、SQL或原始异常');
  return { status: response.status, data: text && response.headers.get('content-type')?.includes('application/json')
    ? JSON.parse(text) : null, headers: response.headers };
}
async function disabledProbe(options = {}) {
  const { user = 'u-super', scenario, headers = {}, raw = '{}' } = options;
  const response = await fetch(origin + path, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Connection: 'close', 'Content-Type': 'application/json', Origin: publicOrigin,
      'X-Production-Reset-Disabled-Probe': 'v1',
      ...(user ? { Cookie: `ling_session=${tokens[user]}` } : {}),
      ...(scenario ? { 'X-Local-Test-Scenario': scenario } : {}), ...headers },
    body: raw,
  });
  const text = await response.text();
  ok(!text.includes(secret) && !Object.values(tokens).some((token) => text.includes(token)), '自检响应不暴露凭证');
  return { status: response.status, data: JSON.parse(text), headers: response.headers };
}
async function fixture(action) {
  const response = await fetch(origin + '/fixture/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  if (!response.ok) throw new Error('本地夹具操作失败');
}
async function currentState() { return (await fetch(origin + '/fixture/state')).json(); }
function builtRequest(route, method = 'GET', cookie = '', attempt = 0) {
  return new Promise((done, fail) => {
    const request = httpRequest(origin + route, { method, agent: false,
      headers: { Connection: 'close', ...(cookie ? { Cookie: cookie } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': '2', Origin: origin } : {}) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('error', fail);
      response.once('end', () => {
        try { done({ status: response.statusCode, data: JSON.parse(text) }); }
        catch {
          const category = text.includes('worker restarted mid-request') ? 'WORKER_RESTART'
            : text.trimStart().startsWith('<') ? 'HTML' : 'TEXT';
          // Only local read-only checks, or unauthenticated empty-body requests
          // against the explicitly disabled application instance, are retried.
          // The authenticated reset() test helper above never retries.
          const harmless = method === 'GET' || (!cookie && [path, '/api/families'].includes(route));
          if (category === 'WORKER_RESTART' && harmless && attempt < 3) {
            setTimeout(() => { builtRequest(route, method, cookie, attempt + 1).then(done, fail); }, 500);
            return;
          }
          fail(new Error(`实际构建响应不是预期JSON（${response.statusCode}/${category}）`));
        }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error('实际构建本地HTTP超时')));
    request.once('error', fail);
    request.end(method === 'POST' ? '{}' : undefined);
  });
}
async function denial(options, status, code, label) {
  await fixture('clear-operation-state');
  const result = await reset(options);
  ok(result.status === status && result.data?.code === code, label);
  ok(Object.values((await currentState()).counts).every((count) => count > 0), '拒绝请求后原19表数据仍存在');
}
async function probeDenial(options, status, code, label) {
  await fixture('clear-operation-state');
  const before = await currentState();
  const result = await disabledProbe(options);
  const after = await currentState();
  ok(result.status === status && result.data?.code === code, label);
  ok(result.headers.get('Cache-Control') === 'private, no-store', `${label}响应不可缓存`);
  ok(JSON.stringify(before.counts) === JSON.stringify(after.counts)
    && JSON.stringify(before.resetAttempts) === JSON.stringify(after.resetAttempts)
    && JSON.stringify(before.locks) === JSON.stringify(after.locks), `${label}不更改任何表行数或Reset尝试记录`);
}

await start();
let after;
try {
  const before = await currentState();
  ok(Object.keys(before.counts).length === 19 && Object.values(before.counts).every((count) => count > 0), '全新本地0010数据库19表均有夹具数据');
  let result = await reset({ method: 'GET' });
  ok(result.status === 405 && result.data.code === 'METHOD_NOT_ALLOWED', 'GET不执行也不泄露配置');
  await probeDenial({ scenario: 'disabled' }, 503, 'RESET_DISABLED', '已关闭Reset时同源管理员自检返回禁用');
  await probeDenial({}, 409, 'RESET_PROBE_NOT_DISABLED', '误开启Reset时自检仍在核心执行前拒绝');
  await probeDenial({ user: null }, 401, 'UNAUTHORIZED', '匿名用户不能读取Reset禁用状态');
  for (const user of ['u-user', 'u-owner', 'u-admin']) {
    await probeDenial({ user }, 403, 'FORBIDDEN', `${user}不能调用Reset自检`);
  }
  await fixture('disable-super');
  await probeDenial({}, 401, 'UNAUTHORIZED', '已禁用SUPER_ADMIN不能自检');
  await fixture('restore-super');
  await fixture('expire-super-session');
  await probeDenial({}, 401, 'UNAUTHORIZED', '过期SUPER_ADMIN会话不能自检');
  await fixture('restore-super-session');
  await probeDenial({ scenario: 'maintenance-off' }, 503, 'MAINTENANCE_REQUIRED', '非维护模式不能自检');
  await probeDenial({ headers: { Origin: 'https://attacker.example' } }, 403, 'RESET_ORIGIN_INVALID', '跨站请求不能自检');
  await probeDenial({ headers: { Origin: '' } }, 403, 'RESET_ORIGIN_INVALID', '缺少Origin不能自检');
  await probeDenial({ headers: { 'X-Production-Reset-Secret': secret } }, 400, 'RESET_PROBE_INVALID', '自检禁止携带Secret');
  await probeDenial({ headers: { 'X-Production-Reset-Disabled-Probe': 'other' } }, 400, 'RESET_PROBE_INVALID', '错误自检标记被拒绝');
  await probeDenial({ raw: JSON.stringify(body) }, 400, 'RESET_PROBE_INVALID', '自检禁止携带真实Reset参数');
  await denial({ scenario: 'disabled' }, 503, 'RESET_DISABLED', '默认关闭开关拒绝');
  await denial({ scenario: 'maintenance-off' }, 503, 'MAINTENANCE_REQUIRED', '非维护模式拒绝');
  await denial({ user: null }, 401, 'UNAUTHORIZED', '未登录拒绝');
  for (const user of ['u-user', 'u-owner', 'u-admin']) await denial({ user }, 403, 'FORBIDDEN', `${user}没有系统级权限`);
  await fixture('disable-super');
  await denial({}, 401, 'UNAUTHORIZED', '已禁用SUPER_ADMIN的Session失效');
  await fixture('restore-super');
  await fixture('expire-super-session');
  await denial({}, 401, 'UNAUTHORIZED', '过期的SUPER_ADMIN Session拒绝');
  await fixture('restore-super-session');
  await denial({ scenario: 'wrong-environment' }, 409, 'PRODUCTION_TARGET_MISMATCH', '非production环境拒绝');
  await denial({ scenario: 'missing-secret' }, 503, 'RESET_SECRET_INVALID', '服务端Secret缺失拒绝');
  await denial({ scenario: 'weak-secret' }, 503, 'RESET_SECRET_INVALID', '不足32随机字节的Secret格式拒绝');
  await denial({ scenario: 'wrong-config-project' }, 409, 'PRODUCTION_TARGET_MISMATCH', '服务端Project与hosting不一致拒绝');
  await denial({ scenario: 'wrong-config-binding' }, 409, 'PRODUCTION_TARGET_MISMATCH', '服务端DB binding不一致拒绝');
  await denial({ headers: { 'X-Production-Reset-Secret': randomBytes(32).toString('hex') } }, 403, 'RESET_SECRET_INVALID', '错误Secret拒绝');
  await denial({ patch: { confirmation: 'yes' } }, 400, 'RESET_CONFIRMATION_INVALID', '模糊确认文本拒绝');
  await denial({ patch: { projectId: 'another-project' } }, 409, 'PRODUCTION_TARGET_MISMATCH', '错误请求Project拒绝');
  await denial({ patch: { schema: '0006' } }, 409, 'SCHEMA_MISMATCH', '错误请求schema拒绝');
  await denial({ patch: { sitesVersion: 40 } }, 409, 'PRODUCTION_TARGET_MISMATCH', '错误Sites Version拒绝');
  await denial({ patch: { deploymentId: 'appgdep_another0123456789' } }, 409, 'PRODUCTION_TARGET_MISMATCH', '错误Deployment拒绝');
  await denial({ scenario: 'trusted-mismatch' }, 409, 'PRODUCTION_TARGET_MISMATCH', '真实平台元数据若可用必须匹配');
  await denial({ patch: { backupSha256: 'f'.repeat(64) } }, 412, 'BACKUP_APPROVAL_MISMATCH', '错误备份SHA拒绝');
  await denial({ headers: { Origin: 'https://attacker.example' } }, 403, 'RESET_ORIGIN_INVALID', '跨站Origin拒绝');
  await denial({ headers: { Origin: '' } }, 403, 'RESET_ORIGIN_INVALID', '缺少Origin拒绝');
  await denial({ headers: { 'X-Local-Test-Host': 'attacker.example' } }, 403, 'RESET_ORIGIN_INVALID', '错误Host拒绝');
  await denial({ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'RESET_ORIGIN_INVALID', '跨站fetch元数据拒绝');
  await denial({ raw: '{' }, 400, 'RESET_REQUEST_INVALID', '无效JSON拒绝');
  await denial({ raw: 'x'.repeat(2049) }, 413, 'RESET_REQUEST_INVALID', '超长请求在解析前拒绝');
  await denial({ patch: { secret } }, 400, 'RESET_REQUEST_INVALID', '禁止JSON携带Secret或额外字段');
  await denial({ query: '?secret=not-an-actual-secret' }, 403, 'RESET_ORIGIN_INVALID', '任何query参数触发均被拒绝');
  await fixture('unknown-table');
  await denial({}, 409, 'UNKNOWN_TABLES_PRESENT', '未知额外表fail closed');
  await fixture('remove-unknown-table');
  await fixture('old-schema');
  await denial({}, 409, 'SCHEMA_MISMATCH', '当前实际ledger不是0010时拒绝');
  await fixture('restore-schema');
  await fixture('clear-operation-state');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await reset({ headers: { 'X-Production-Reset-Secret': randomBytes(32).toString('hex') } });
    ok(result.status === 403, '错误Secret计入持久化次数');
  }
  stop();
  await start();
  result = await reset();
  ok(result.status === 429 && result.data.code === 'RESET_ATTEMPTS_EXCEEDED', '三次失败后即使正确Secret也锁定');
  await fixture('clear-operation-state');
  await fixture('fail-delete');
  const failureBefore = await currentState();
  result = await reset({ scenario: 'trusted-match' });
  ok(result.status === 500 && result.data.code === 'RESET_FAILED', `模拟任意DELETE失败返回安全错误（${result.status}/${result.data?.code}）`);
  ok(result.headers.get('X-Reset-Deployment-Verification') === 'VERIFIED', '可信平台适配器匹配才标记VERIFIED');
  const failureAfter = await currentState();
  ok(TABLES_0010.filter((table) => table !== 'action_idempotency').every((table) => failureBefore.counts[table] === failureAfter.counts[table]), 'DELETE失败整批回滚，不产生部分清库');
  ok(JSON.stringify(failureBefore.schema) === JSON.stringify(failureAfter.schema), '失败不改变schema/索引/触发器');
  ok(failureAfter.locks.length === 1 && failureAfter.locks[0].status === 'FAILED', '失败操作保持持久化锁且不自动重试');
  result = await reset();
  ok(result.status === 409 && result.data.code === 'RESET_ALREADY_EXECUTED', '失败后的重放明确拒绝');
  await fixture('clear-operation-state');
  await fixture('remove-failure');
  const successBefore = await currentState();
  const responses = await Promise.all([reset(), reset(), reset()]);
  ok(responses.filter((item) => item.status === 200).length === 1, '三个并发请求只有一个成功Reset');
  const success = responses.find((item) => item.status === 200);
  ok(JSON.stringify(success.data) === JSON.stringify({ ok: true, reset: true, schema: '0010', tablesCleared: 19 }), '成功响应只有最小结果');
  ok(success.headers.get('X-Reset-Deployment-Verification') === 'UNAVAILABLE', '没有真实运行时元数据时诚实标记UNAVAILABLE');
  ok(success.headers.get('Cache-Control') === 'private, no-store', 'Reset响应禁止缓存');
  after = await currentState();
  ok(TABLES_0010.every((table) => after.counts[table] === 0), '成功及并发重放结束后19表全部0，无残留限流/锁');
  ok(JSON.stringify(successBefore.schema) === JSON.stringify(after.schema), '表/索引/schema未改变');
  ok(after.migrations.length === 11 && after.migrations.at(-1).name === '0010_security_s0_containment.sql', '0000～0010 migration历史保持完整');
  ok(after.foreignKeyErrors === 0, 'PRAGMA foreign_key_check PASS');
  result = await reset();
  ok(result.status === 401 && result.data.code === 'UNAUTHORIZED', '成功后旧Session失效，不能再次调用');
  ok(TABLES_0010.every((table) => after.counts[table] === 0), '不自动注册用户、Bootstrap、创建OWNER或族谱');
  const routeLogs = output.split('\n').filter((line) => line.includes('"event":"production_reset"'));
  ok(routeLogs.length > 0 && routeLogs.every((line) => !line.includes(secret)
    && !Object.values(tokens).some((token) => line.includes(token))), '结构化应用日志不包含Secret或Session token');
} finally { stop(); }

// Exercise the actual framework route/build as well as the direct handler.
// No Reset opt-in or Secret is configured in this application instance.
await writeFile(config, JSON.stringify({ ...baseConfig, main: join(root, 'dist/server/index.js'),
  assets: { directory: join(root, 'dist/client') }, vars: { MAINTENANCE_MODE: 'true' } }));
await start();
try {
  // A new socket per request avoids reusing a fetch pool across replacement of
  // the local Worker; no POST or DELETE is automatically retried.
  let result = await builtRequest(path);
  ok(result.status === 405 && result.data.code === 'METHOD_NOT_ALLOWED', '正式构建中的GET返回405且不泄露配置');
  result = await builtRequest('/api/health');
  ok(result.status === 200 && result.data.status === 'maintenance', '清空后应用仍处于维护模式');
  result = await builtRequest('/api/auth/session', 'GET', `ling_session=${tokens['u-super']}`);
  ok(result.status === 401, '清空后正式Session API拒绝旧管理员会话');
  result = await builtRequest('/api/families', 'POST');
  ok(result.status === 503 && result.data.code === 'SERVICE_MAINTENANCE', '清空后普通业务仍503');
  result = await builtRequest(path, 'POST');
  ok(result.status === 503 && result.data.code === 'RESET_DISABLED', '正式构建中的POST入口默认关闭');
} finally { stop(); }
// D1 bounds compound SELECT terms, so use scalar COUNT subqueries instead of
// a long UNION chain. This remains a single read-only verification statement.
const countSql = `SELECT ${TABLES_0010.map((table) => `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(',')}`;
const countOutput = wrangler([...d1, '--command', countSql, '--json']);
const finalCounts = JSON.parse(countOutput.slice(countOutput.indexOf('[')))[0].results[0];
ok(Object.keys(finalCounts).length === 19 && Object.values(finalCounts).every((count) => count === 0), '实际应用访问后19表仍为空，没有自动创建User/OWNER/族谱');

async function scan(directory) {
  const findings = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) findings.push(...await scan(file));
    else if (['.html', '.js', '.json'].includes(extname(file))) {
      const text = await readFile(file, 'utf8');
      if (text.includes('addKnownMainFamily') || text.includes('LOCAL_RESET_CHANNEL_TEST_ONLY')
        || text.includes('/fixture/action') || (entry.name === 'family.html'
        && !/window\.NORMALIZED_FAMILY_TREE\s*=\s*null/.test(text))) findings.push(file);
    }
  }
  return findings;
}
ok((await scan(join(root, 'public'))).length === 0, '公开静态文件无旧族谱生成器或测试入口，静态初始树为空');
ok((await scan(join(root, 'dist/client'))).length === 0, '客户端构建无旧族谱生成器或测试入口，静态初始树为空');
console.log(`PASS Reset channel: ${assertions} checks; local only; no deployment or production data.`);
console.log(JSON.stringify({ schema: '0010', counts: after.counts, foreignKeyViolations: after.foreignKeyErrors }));
