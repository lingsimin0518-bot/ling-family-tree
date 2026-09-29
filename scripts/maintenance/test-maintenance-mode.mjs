import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:maintenance 运行测试');
const work = await mkdtemp(join(tmpdir(), 'maintenance-mode-test-'));
const state = join(work, 'state');
const config = join(work, 'wrangler.jsonc');
const origin = 'http://127.0.0.1:8820';
const superToken = 'local-maintenance-super-session';
const superSessionId = createHash('sha256').update(superToken).digest('base64');
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
        SMS_MODE: 'mock',
        SMS_CODE_PEPPER: 'maintenance-test-pepper-at-least-32-characters',
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('本地维护模式 Worker 提前退出');
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
    const response = await fetch(origin + path, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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

await writeConfig(true);
for (const migration of migrations) run([...d1, '--file', join(root, 'drizzle', migration)]);
run([...d1, '--file', join(root, 'scripts', 'backup', 'fixtures', 'local-test-data.sql')]);
const ledger = join(work, 'migration-ledger.sql');
await writeFile(
  ledger,
  `CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);\n${migrations
    .map((name, index) => `INSERT INTO d1_migrations(id,name) VALUES(${index + 1},'${name}');`)
    .join('\n')}\nUPDATE user_sessions SET id='${superSessionId}' WHERE user_id='u-super';\n`,
);
run([...d1, '--file', ledger]);

const superCookie = `ling_session=${superToken}`;
let server = await startServer();
try {
  let result = await request('/');
  ok(
    result.response.status === 200 && String(result.data).includes('系统维护中'),
    '维护期间首页显示明确维护页面',
  );
  result = await request('/api/health');
  ok(result.response.status === 200 && result.data.status === 'maintenance', 'health 报告维护状态');
  result = await request('/api/families');
  ok(
    result.response.status === 503 && result.data.code === 'SERVICE_MAINTENANCE',
    '普通族谱读取 fail closed，不暴露旧数据',
  );

  /** @type {Array<[string, string, Record<string, unknown>]>} */
  const blockedRequests = [
    ['/api/auth/register', 'POST', { username: 'blocked', password: 'password1', confirmPassword: 'password1', email: 'blocked@example.test' }],
    ['/api/auth/register/phone', 'POST', {}],
    ['/api/auth/sms/send', 'POST', {}],
    ['/api/auth/login/phone-code', 'POST', {}],
    ['/api/auth/password/reset', 'POST', {}],
    ['/api/account/phone/bind', 'POST', {}],
    ['/api/account/phone/change/verify-old', 'POST', {}],
    ['/api/account/phone/change/confirm', 'POST', {}],
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
} finally {
  await stopServer(server);
}

server = await startServer();
try {
  console.log('检查维护模式下的SUPER_ADMIN运维边界…');
  const result = await request('/api/admin', 'POST', { action: 'FORCE_LOGOUT' }, superCookie);
  ok(
    result.response.status === 503 && result.data.code === 'SERVICE_MAINTENANCE',
    'SUPER_ADMIN 普通后台写入也不能绕过维护模式',
  );
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
  result = await request('/api/auth/register', 'POST', {
    username: 'maintenance_reopen',
    password: 'password1',
    confirmPassword: 'password1',
    email: 'maintenance-reopen@example.test',
  });
  ok(result.response.status === 201, '关闭维护模式后注册恢复');
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  result = await request('/api/families', 'GET', undefined, cookie);
  ok(result.response.status === 200, '关闭维护模式后族谱业务读取恢复');
} finally {
  await stopServer(server);
}

console.log('PASS：维护模式写入阻断、数据读取 fail closed、运维白名单与关闭恢复全部通过。');
