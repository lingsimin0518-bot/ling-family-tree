import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:security-s0 运行测试');
const work = await mkdtemp(join(tmpdir(), 'security-s0-'));
const state = join(work, 'state');
const config = join(work, 'wrangler.json');
const port = 8801;
const origin = `http://127.0.0.1:${port}`;

await writeFile(config, JSON.stringify({
  name: 'security-s0-test',
  compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'],
  main: join(root, 'dist/server/index.js'),
  assets: { directory: join(root, 'dist/client') },
  vars: { SMS_MODE: 'mock', APP_ENV: 'test', SMS_CODE_PEPPER: 'security-s0-test-pepper-at-least-32-characters' },
  d1_databases: [{ binding: 'DB', database_name: 'security-s0-test', database_id: '00000000-0000-4000-8000-000000000000' }],
}));

function run(args) {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const result = spawnSync(process.execPath, [cli, 'exec', 'wrangler', ...args], {
    cwd: root, env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

const d1 = ['d1', 'execute', 'security-s0-test', '--local', '--config', config, '--persist-to', state];
for (const file of [
  '0000_multi_family.sql', '0001_real_user_auth.sql', '0002_wechat_identity.sql',
  '0003_system_admin.sql', '0004_unified_person_operations.sql', '0005_creation_cooldown.sql',
  '0006_collaboration_persistence.sql', '0007_auth_identity_foundation.sql',
  '0008_phone_change_challenges.sql', '0009_aliyun_sms_provider.sql',
]) run([...d1, '--file', join(root, 'drizzle', file)]);

const seed = join(work, 'seed.sql');
await writeFile(seed, `
INSERT INTO users(id,email,display_name,created_at,username,password_hash,status,updated_at,system_role)
VALUES
('legacy-user','legacy-user@example.test','Legacy User','2026-01-01T00:00:00Z','legacy_user',NULL,'ACTIVE','2026-01-01T00:00:00Z','USER'),
('legacy-super','legacy-super@example.test','Legacy Super','2026-01-01T00:00:00Z','legacy_super',NULL,'ACTIVE','2026-01-01T00:00:00Z','SUPER_ADMIN'),
('legacy-disabled','legacy-disabled@example.test','Legacy Disabled','2026-01-01T00:00:00Z','legacy_disabled',NULL,'DISABLED','2026-01-01T00:00:00Z','USER'),
('family-creator','creator@example.test','Creator','2026-01-01T00:00:00Z','creator',NULL,'ACTIVE','2026-01-01T00:00:00Z','USER');
INSERT INTO families(id,name,description,join_code,source_type,created_by,created_at)
VALUES
('family-lingshi-existing','Legacy protected family','', 'LINGSHI','LEGACY_STATIC','family-creator','2026-01-01T00:00:00Z'),
('family-private-test','Private family','', 'PRIVATE8','DATABASE','family-creator','2026-01-01T00:00:00Z');
INSERT INTO family_users(user_id,family_id,role,joined_at)
VALUES('family-creator','family-private-test','OWNER','2026-01-01T00:00:00Z');
`);
run([...d1, '--file', seed]);
run([...d1, '--file', join(root, 'drizzle', '0010_security_s0_containment.sql')]);

const wranglerCli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const server = spawn(process.execPath, [wranglerCli, 'dev', '--config', config, '--persist-to', state, '--port', String(port)], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
const pause = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { const response = await fetch(origin); if (response.status < 500) break; } catch { /* wait */ }
  await pause(250);
  if (attempt === 39) throw new Error(`本地服务未启动：${serverOutput}`);
}

function ok(value, label) {
  if (!value) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}
function sql(command) { return run([...d1, '--command', command, '--json']); }
async function post(path, body, { cookie = '', ip = '198.51.100.10' } = {}) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function register(username, email, ip) {
  return post('/api/auth/register', { username, password: 'password-123', confirmPassword: 'password-123', email }, { ip });
}

try {
  let response = await register('takeover_user', 'legacy-user@example.test', '198.51.100.11');
  ok(response.status === 409 && !response.cookie, '已有无密码普通账号不能被邮箱注册接管');
  response = await register('takeover_super', 'legacy-super@example.test', '198.51.100.12');
  ok(response.status === 409 && !response.cookie, '无密码 SUPER_ADMIN 不能被邮箱注册接管');
  response = await register('takeover_disabled', 'legacy-disabled@example.test', '198.51.100.13');
  ok(response.status === 409 && !response.cookie, 'DISABLED 账号不能通过注册恢复');
  const preserved = sql("SELECT id,username,password_hash,status,system_role FROM users WHERE id IN ('legacy-user','legacy-super','legacy-disabled') ORDER BY id");
  ok(preserved.includes('legacy_super') && preserved.includes('SUPER_ADMIN') && preserved.includes('DISABLED') && !preserved.includes('takeover_'), '旧账号身份与状态保持不变');
  ok(sql("SELECT COUNT(*) total FROM user_sessions WHERE user_id IN ('legacy-user','legacy-super','legacy-disabled')").includes('"total": 0'), '旧账号未被签发 Session');

  const concurrentExisting = await Promise.all([
    register('race_existing_a', 'legacy-user@example.test', '198.51.100.14'),
    register('race_existing_b', 'legacy-user@example.test', '198.51.100.15'),
  ]);
  ok(concurrentExisting.every(item => item.status === 409 && !item.cookie), '并发注册不能取得已有邮箱身份');
  const concurrentNew = await Promise.all([
    register('race_new_a', 'race-new@example.test', '198.51.100.16'),
    register('race_new_b', 'race-new@example.test', '198.51.100.17'),
  ]);
  ok(concurrentNew.filter(item => item.status === 201).length === 1 && concurrentNew.filter(item => item.status === 409).length === 1, '并发新邮箱只创建并签发一个账号');
  ok(sql("SELECT COUNT(*) total FROM users WHERE email='race-new@example.test'").includes('"total": 1'), '并发注册唯一约束生效');

  const firstVisit = await register('first_visit', 'first-visit@example.test', '198.51.100.18');
  ok(firstVisit.status === 201, '首访测试账号创建');
  const firstReads = await Promise.all([
    fetch(origin + '/api/families', { headers: { cookie: firstVisit.cookie } }),
    fetch(origin + '/api/families', { headers: { cookie: firstVisit.cookie } }),
  ]);
  ok(firstReads.every(item => item.status === 200), '并发首访读取成功');
  ok(sql("SELECT COUNT(*) total FROM family_users WHERE family_id='family-lingshi-existing'").includes('"total": 0'), '普通及并发首访不会产生 OWNER');

  response = await post('/api/families', { action: 'JOIN_FAMILY', code: 'LINGSHI' }, { cookie: firstVisit.cookie, ip: '198.51.100.19' });
  ok(response.status === 404, '旧固定主谱加入码失效');
  ok(sql("SELECT COUNT(*) total FROM family_users WHERE user_id IN (SELECT id FROM users WHERE username='first_visit')").includes('"total": 0'), '固定码失败不创建成员关系');

  const unauthorized = await fetch(origin + '/api/families?family_id=family-private-test', { headers: { cookie: firstVisit.cookie } });
  ok(unauthorized.status === 403, '非本族谱成员读取继续拒绝');
  const anonymous = await fetch(origin + '/api/families?family_id=family-lingshi-existing');
  ok(anonymous.status === 401, '未登录族谱读取返回 401');
  const familyHtml = await (await fetch(origin + '/family.html?family_id=family-lingshi-existing')).text();
  const forbiddenMarkers = ['addKnownMainFamily'];
  ok(forbiddenMarkers.every(marker => !familyHtml.includes(marker))
    && /S0 containment[\s\S]*NORMALIZED_FAMILY_TREE\s*=\s*null/.test(familyHtml),
  '直接请求 HTML 不包含旧主谱生成器且静态初始树为空');
  ok(familyHtml.includes('return null;') && !familyHtml.includes("source_type === 'LEGACY_STATIC'"), '401/403/API 失败没有主谱回退路径');
  const unauthorizedText = await unauthorized.text();
  ok(forbiddenMarkers.every(marker => !unauthorizedText.includes(marker)), '403 响应不返回主谱资料');

  run([...d1, '--file', join(root, 'db', 'rollback', '0010_security_s0_containment.rollback.sql')]);
  ok(sql("SELECT COUNT(*) total FROM families WHERE id='family-lingshi-existing' AND join_code='LINGSHI'").includes('"total": 1'), '0010 rollback 可执行');
  console.log('PASS：S0 高危问题止血回归测试全部通过。');
} finally {
  server.kill();
  server.stdout.destroy();
  server.stderr.destroy();
  server.unref();
}
