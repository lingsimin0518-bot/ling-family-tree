import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:maintenance 运行测试');
const work = await mkdtemp(join(tmpdir(), 'maintenance-mode-test-'));
const state = join(work, 'state');
const config = join(work, 'wrangler.jsonc');
const origin = 'http://127.0.0.1:8820';
const sessionTokens = {
  super: 'local-maintenance-super-session',
  user: 'local-maintenance-user-session',
  owner: 'local-maintenance-owner-session',
  admin: 'local-maintenance-admin-session',
};
let workerOutput = '';
const migrations = [
  '0000_multi_family.sql',
  '0001_real_user_auth.sql',
  '0002_wechat_identity.sql',
  '0003_system_admin.sql',
  '0004_unified_person_operations.sql',
  '0005_creation_cooldown.sql',
  '0006_collaboration_persistence.sql',
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
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || '本地命令失败');
  return result.stdout;
}

async function writeConfig(maintenanceMode) {
  await writeFile(
    config,
    JSON.stringify({
      name: `maintenance-test-${randomUUID()}`,
      main: join(root, 'dist', 'server', 'index.js'),
      compatibility_date: '2026-05-15',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: join(root, 'dist', 'client') },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'maintenance-test',
          database_id: '00000000-0000-4000-8000-000000000000',
        },
      ],
      vars: {
        APP_ENV: 'test',
        MAINTENANCE_MODE: maintenanceMode ? 'true' : 'false',
      },
    }),
  );
}

const d1 = [
  'd1',
  'execute',
  'maintenance-test',
  '--local',
  '--config',
  config,
  '--persist-to',
  state,
];

async function startServer() {
  const child = spawn(
    process.execPath,
    [
      cli,
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--config',
      config,
      '--persist-to',
      state,
      '--port',
      '8820',
    ],
    {
      cwd: root,
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  workerOutput = '';
  child.stdout.on('data', (chunk) => { workerOutput = (workerOutput + chunk.toString()).slice(-8000); });
  child.stderr.on('data', (chunk) => { workerOutput = (workerOutput + chunk.toString()).slice(-8000); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`本地维护模式 Worker 提前退出：\n${workerOutput}`);
    try {
      await fetch(origin + '/api/health');
      return child;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  child.kill();
  throw new Error('本地维护模式 Worker 启动超时');
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

async function request(path, method = 'GET', body, cookie = '') {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetch(origin + path, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        Connection: 'close',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`${method} ${path} 请求失败: ${String(error)}\n${workerOutput}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (
      typeof data !== 'string' ||
      !data.includes('worker restarted mid-request') ||
      attempt === 3
    ) {
      return { response, data };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('本地 Worker 重启后请求仍未返回');
}

function storedZipEntries(bytes) {
  const files = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const signature = view.getUint32(0, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > bytes.length) throw new Error('本地备份 ZIP 结构无效');
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    const end = dataStart + size;
    if (end > bytes.length) throw new Error('本地备份 ZIP 不完整');
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    files.set(name, bytes.subarray(dataStart, end));
    offset = end;
  }
  return files;
}

async function checkLocalExport(cookie) {
  const response = await fetch(origin + '/api/admin/backups/export', {
    method: 'POST',
    headers: { cookie },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new Error(`本地导出返回 HTTP ${response.status}`);
  const files = storedZipEntries(new Uint8Array(await response.arrayBuffer()));
  const expected = new Set([
    'manifest.json', 'checksums.json', 'schema/schema.json', 'schema/README.md',
    ...[
      'action_idempotency', 'action_rate_limit', 'announcements', 'families',
      'family_activities', 'family_users', 'generations', 'media', 'person_claims',
      'persons', 'relationships', 'review_requests', 'system_audit_logs',
      'user_messages', 'user_sessions', 'users',
    ].map((name) => `tables/${name}.json`),
  ]);
  ok(files.size === expected.size && [...files.keys()].every((name) => expected.has(name)), '实际本地导出 ZIP 恰好包含 16 张业务表，无平台元数据表');
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  ok(manifest.schema_version === '0006' && manifest.schema_recognition_method === 'structural_inference' && manifest.tables.length === 16, '实际本地导出 manifest 标明 0006（结构推断）及 16 张业务表');
  const checksums = JSON.parse(new TextDecoder().decode(files.get('checksums.json')));
  ok(Object.entries(checksums).every(([path, expectedHash]) => files.has(path) && createHash('sha256').update(files.get(path)).digest('hex') === expectedHash), '实际本地导出 ZIP 的所有 SHA-256 校验通过');
}

await writeConfig(true);
for (const migration of migrations) run([...d1, '--file', join(root, 'drizzle', migration)]);
run([...d1, '--file', join(root, 'scripts', 'backup', 'fixtures', 'local-test-data.sql')]);
const legacySeed = join(work, 'legacy-account-seed.sql');
await writeFile(legacySeed, `INSERT INTO users(id,email,display_name,created_at,username,password_hash,status,updated_at,system_role) VALUES
('legacy-user','legacy-user@example.test','Legacy user','2026-01-01T00:00:00Z','legacy_user',NULL,'ACTIVE','2026-01-01T00:00:00Z','USER'),
('legacy-super','legacy-super@example.test','Legacy super','2026-01-01T00:00:00Z','legacy_super',NULL,'ACTIVE','2026-01-01T00:00:00Z','SUPER_ADMIN'),
('legacy-disabled','legacy-disabled@example.test','Legacy disabled','2026-01-01T00:00:00Z','legacy_disabled',NULL,'DISABLED','2026-01-01T00:00:00Z','USER');`);
run([...d1, '--file', legacySeed]);
const ledger = join(work, 'sites-metadata-and-sessions.sql');
await writeFile(
  ledger,
  `CREATE TABLE __appgarden_migrations(id INTEGER PRIMARY KEY, opaque_record TEXT NOT NULL);\nINSERT INTO __appgarden_migrations(id,opaque_record) VALUES(1,'unrecognized-platform-format');\n${Object.entries(sessionTokens).map(([role, token]) =>
      `UPDATE user_sessions SET id='${createHash('sha256').update(token).digest('base64')}' WHERE user_id='u-${role}';`,
    ).join('\n')}\nUPDATE users SET password_hash='pbkdf2_sha256$100000$${Buffer.from('maintenance-salt').toString('base64')}$${pbkdf2Sync('local-test-password', 'maintenance-salt', 100_000, 32, 'sha256').toString('base64')}' WHERE id='u-super';\n`,
);
run([...d1, '--file', ledger]);

const superCookie = `ling_session=${sessionTokens.super}`;
const userCookie = `ling_session=${sessionTokens.user}`;
const ownerCookie = `ling_session=${sessionTokens.owner}`;
const adminCookie = `ling_session=${sessionTokens.admin}`;
let server = await startServer();
try {
  let result = await request('/');
  ok(
    result.response.status === 200 && String(result.data).includes('系统维护中'),
    '维护期间首页显示明确维护页面',
  );
  result = await request('/family.html?family_id=f-legacy');
  ok(result.response.status === 200 && typeof result.data === 'string' && !result.data.includes('凌玉禾') && !result.data.includes('凌氏先祖（姓名待考）') && !result.data.includes("|| 'family-lingshi-existing'"), '公开静态族谱 HTML 不包含真实人物或旧主谱回退');
  result = await request('/api/health');
  ok(result.response.status === 200 && result.data.status === 'maintenance', 'health 报告维护状态');
  result = await request('/maintenance-admin');
  ok(result.response.status === 200 && String(result.data).includes('管理员安全检查'), '维护期间管理员同源页面可访问');
  result = await request('/api/admin/maintenance/overview');
  ok(result.response.status === 401, '未登录不能读取维护期数据库概况');
  for (const [role, cookie] of [['USER', userCookie], ['OWNER', ownerCookie], ['ADMIN', adminCookie]]) {
    result = await request('/api/admin/maintenance/overview', 'GET', undefined, cookie);
    ok(result.response.status === 403, `${role} 不能读取维护期数据库概况`);
  }
  result = await request('/api/admin/maintenance/overview', 'GET', undefined, superCookie);
  ok(result.response.status === 200 && result.data.schemaVersion === '0006' && result.data.schemaRecognitionMethod === 'structural_inference' && result.data.tableCount === 16 && result.data.matchesExpected0006 === true && result.data.tables.length === 16 && result.data.platformTables.includes('__appgarden_migrations'), 'A：Sites 元数据单列且结构版本明确标记为 0006（推断），16 张业务表可备份');
  ok(result.response.headers.get('cache-control') === 'private, no-store', '维护期数据库概况禁止缓存');
  result = await request('/api/auth/login', 'POST', { username: 'super', password: 'local-test-password' });
  ok(result.response.status === 200 && Boolean(result.response.headers.get('set-cookie')), '维护期间沿用原用户名密码登录');
  const loginCookie = result.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  result = await request('/api/auth/session', 'GET', undefined, loginCookie);
  ok(result.response.status === 200 && result.data.user?.systemRole === 'SUPER_ADMIN', '登录后须经原 Session 接口确认身份');
  result = await request('/api/auth/session');
  ok(result.response.status === 401, '维护期间未登录 Session 检查正常');
  result = await request('/api/auth/session', 'GET', undefined, superCookie);
  ok(result.response.status === 200 && result.data.user?.systemRole === 'SUPER_ADMIN', '维护期间 Session 检查可用');
  result = await request('/api/admin?view=overview', 'GET', undefined, superCookie);
  ok(result.response.status === 200, '维护期间 SUPER_ADMIN 只读后台可用');
  result = await request('/api/families');
  ok(
    result.response.status === 503 && result.data.code === 'SERVICE_MAINTENANCE',
    '普通族谱读取 fail closed，不暴露旧数据',
  );

  /** @type {Array<[string, string, Record<string, unknown>]>} */
  const blockedRequests = [
    ['/api/auth/register', 'POST', { username: 'blocked', password: 'password1', confirmPassword: 'password1', email: 'blocked@example.test' }],
    ['/api/families', 'POST', { action: 'CREATE_FAMILY' }],
    ['/api/families', 'POST', { action: 'JOIN_FAMILY' }],
    ['/api/families', 'POST', { action: 'DELETE_FAMILY' }],
    ['/api/families', 'POST', { action: 'ADD_PERSON' }],
    ['/api/families', 'POST', { action: 'UPDATE_PERSON' }],
    ['/api/families', 'POST', { action: 'ADD_RELATIONSHIP' }],
    ['/api/families', 'POST', { action: 'CLAIM_PERSON' }],
    ['/api/families', 'POST', { action: 'SET_MEMBER_ROLE' }],
    ['/api/families', 'POST', { action: 'REVIEW_CLAIM' }],
    ['/api/announcements', 'POST', {}],
    ['/api/announcements', 'PATCH', {}],
    ['/api/announcements', 'DELETE', {}],
    ['/api/activities', 'POST', {}],
    ['/api/reviews', 'POST', {}],
    ['/api/messages', 'POST', {}],
  ];
  for (const [path, method, body] of blockedRequests) {
    result = await request(path, method, body);
    ok(
      result.response.status === 503 && result.data.code === 'SERVICE_MAINTENANCE',
      `${method} ${path} 在维护模式下被拒绝（实际 ${result.response.status} / ${JSON.stringify(result.data)}）`,
    );
  }
  console.log('检查维护模式下的SUPER_ADMIN运维边界…');
  /** @type {Array<[string, Record<string, unknown>]>} */
  const adminBlockedRequests = [
    ['/api/families', { action: 'CREATE_FAMILY' }],
    ['/api/announcements', {}],
    ['/api/reviews', {}],
  ];
  for (const [path, body] of adminBlockedRequests) {
    result = await request(path, 'POST', body, superCookie);
    ok(result.response.status === 503 && result.data.code === 'SERVICE_MAINTENANCE', `SUPER_ADMIN 不能绕过 ${path} 的维护门禁`);
  }
  result = await request('/api/admin', 'POST', { action: 'FORCE_LOGOUT' }, superCookie);
  ok(
    result.response.status === 503 && result.data.code === 'SERVICE_MAINTENANCE',
    'SUPER_ADMIN 普通后台写入也不能绕过维护模式',
  );
  result = await request('/api/admin/backups/export', 'POST');
  ok(result.response.status === 401, '未登录不能导出生产备份');
  for (const [role, cookie] of [['USER', userCookie], ['OWNER', ownerCookie], ['ADMIN', adminCookie]]) {
    result = await request('/api/admin/backups/export', 'POST', undefined, cookie);
    ok(result.response.status === 403, `${role} 不能导出生产备份`);
  }
  result = await request('/api/admin/backups/export', 'POST', undefined, superCookie);
  ok(result.response.status === 200 && result.response.headers.get('content-type')?.includes('application/zip') && typeof result.data === 'string' && result.data.length > 0, `维护期间 SUPER_ADMIN 可导出完整 ZIP（状态 ${result.response.status}，类型 ${result.response.headers.get('content-type')}，响应长度 ${typeof result.data === 'string' ? result.data.length : 0}）`);
  await checkLocalExport(superCookie);
  result = await request('/api/admin/maintenance/overview', 'GET', undefined, superCookie);
  ok(result.response.status === 200 && result.data.tableCount === 16 && result.data.matchesExpected0006 && result.data.platformTables.includes('_cf_METADATA') && result.data.platformTables.includes('__appgarden_migrations'), 'B：_cf_METADATA 与 Sites migration 元数据均不计入 16 张业务表');
  result = await request('/api/admin/backups/export', 'POST', undefined, superCookie);
  ok(result.response.status === 200 && result.response.headers.get('content-type')?.includes('application/zip'), 'B：两个已知平台表同时存在时仍允许严格 16 表备份');
  run([...d1, '--command', 'CREATE TABLE unexpected_table(id TEXT PRIMARY KEY)']);
  result = await request('/api/admin/maintenance/overview', 'GET', undefined, superCookie);
  ok(result.response.status === 200 && !result.data.matchesExpected0006 && result.data.unknownTables.includes('unexpected_table'), 'C：维护页显式报告未知额外表并禁用备份');
  result = await request('/api/admin/backups/export', 'POST', undefined, superCookie);
  ok(result.response.status === 409 && result.data.error.includes('unexpected_table'), 'C：未知额外表使备份 fail closed，且安全报告表名');
  const adminRoute = await readFile(join(root, 'app', 'api', 'admin', 'route.ts'), 'utf8');
  const backupRoute = await readFile(
    join(root, 'app', 'api', 'admin', 'backups', 'export', 'route.ts'),
    'utf8',
  );
  ok(
    /export async function GET[\s\S]+export async function POST[\s\S]+maintenanceResponse/.test(
      adminRoute,
    ),
    '系统后台只读 GET 保留，维护门禁只作用于后台写入',
  );
  ok(
    backupRoute.includes('requireSuperAdmin(request)') &&
      !backupRoute.includes('maintenanceResponse'),
    '生产备份只由 SUPER_ADMIN 权限保护，不受业务维护门禁影响',
  );
} finally {
  await stopServer(server);
}

await writeConfig(false);
server = await startServer();
try {
  let result = await request('/api/health');
  ok(result.response.status === 200 && result.data.status === 'operational', '关闭维护模式后 health 恢复');
  result = await request('/maintenance-admin');
  ok(result.response.status === 404, '维护模式关闭后维护期管理员页面不存在');
  result = await request('/api/admin/maintenance/overview', 'GET', undefined, superCookie);
  ok(result.response.status === 404, '维护模式关闭后专用数据库概况接口不存在');
  for (const [label, email] of [
    ['无密码普通旧账号', 'legacy-user@example.test'],
    ['无密码 SUPER_ADMIN 旧账号', 'legacy-super@example.test'],
    ['已禁用旧账号', 'legacy-disabled@example.test'],
  ]) {
    result = await request('/api/auth/register', 'POST', {
      username: `attacker_${email.split('@')[0].replaceAll('-', '_')}`,
      password: 'password1',
      confirmPassword: 'password1',
      email,
    });
    ok(result.response.status === 409 && !result.response.headers.get('set-cookie'), `${label}不能凭邮箱注册接管`);
  }
  const duplicateAttempts = await Promise.all([1, 2].map((index) => request('/api/auth/register', 'POST', {
    username: `concurrent_${index}`,
    password: 'password1',
    confirmPassword: 'password1',
    email: 'legacy-user@example.test',
  })));
  ok(duplicateAttempts.every(({ response }) => response.status === 409 && !response.headers.get('set-cookie')), '并发注册已有邮箱均不能取得旧账号 Session');
  result = await request('/api/auth/register', 'POST', {
    username: 'maintenance_reopen',
    password: 'password1',
    confirmPassword: 'password1',
    email: 'maintenance-reopen@example.test',
  });
  ok(result.response.status === 201, '关闭维护模式后注册恢复');
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  result = await request('/api/families', 'GET', undefined, cookie);
  ok(result.response.status === 200 && result.data.families?.length === 0, '关闭维护模式后业务读取恢复且新账号没有默认族谱或 OWNER');
  result = await request('/api/families', 'POST', { action: 'JOIN_FAMILY', code: 'LINGSHI' }, cookie);
  ok(result.response.status === 404, '旧固定主谱加入码不能加入族谱');
  result = await request('/api/families?family_id=f-legacy', 'GET', undefined, cookie);
  ok(result.response.status === 403, '非本族谱成员读取继续被拒绝');
} finally {
  await stopServer(server);
}

console.log('PASS：维护模式写入阻断、数据读取 fail closed、运维白名单与关闭恢复全部通过。');
