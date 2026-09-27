import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  assertSmsVerificationUsable,
  hashSmsCode,
  verifySmsCodeHash,
} from '../../lib/sms-verification.ts';
import { normalizePhoneToE164 } from '../../lib/user-identity.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function runWrangler(args) {
  const environment = { ...process.env };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) fail('请通过 pnpm test:auth-foundation 运行测试');
  const result = spawnSync(process.execPath, [packageManagerCli, 'exec', 'wrangler', ...args], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result;
}

function expectSuccess(result, label) {
  if (result.status !== 0) fail(`${label}失败：${result.stderr || result.stdout}`);
  return result.stdout;
}

function resultRows(output) {
  const start = output.indexOf('[');
  if (start < 0) fail(`无法解析 D1 输出：${output}`);
  const parsed = JSON.parse(output.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

function expectThrows(callback, expected, label) {
  try {
    callback();
  } catch (error) {
    if (String(error).includes(expected)) return;
    fail(`${label}抛出了非预期错误：${String(error)}`);
  }
  fail(`${label}没有拒绝无效输入`);
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'auth-foundation-'));
  const state = join(work, 'state');
  const config = join(work, 'wrangler.jsonc');
  await writeFile(
    config,
    JSON.stringify({
      name: 'auth-foundation-test',
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'auth-foundation-test',
          database_id: '00000000-0000-4000-8000-000000000000',
        },
      ],
    }),
  );
  const base = [
    'd1',
    'execute',
    'auth-foundation-test',
    '--local',
    '--config',
    config,
    '--persist-to',
    state,
  ];
  const migrations = [
    '0000_multi_family.sql',
    '0001_real_user_auth.sql',
    '0002_wechat_identity.sql',
    '0003_system_admin.sql',
    '0004_unified_person_operations.sql',
    '0005_creation_cooldown.sql',
    '0006_collaboration_persistence.sql',
  ];
  for (const migration of migrations) {
    expectSuccess(
      runWrangler([...base, '--file', join(projectRoot, 'drizzle', migration)]),
      migration,
    );
  }

  const beforeSql = join(work, 'before-0007.sql');
  await writeFile(
    beforeSql,
    `INSERT INTO users(id,email,display_name,created_at,username,password_hash,phone,nickname,status,updated_at,wechat_openid,wechat_unionid,phone_verified_at,system_role)
VALUES
('verified-e164',NULL,'Verified','2026-01-01T00:00:00Z','legacy_verified','hash-a','+8613800138000','Verified','ACTIVE','2026-01-02T00:00:00Z','legacy-openid','legacy-unionid','2026-01-02T00:00:00Z','USER'),
('unverified',NULL,'Unverified','2026-01-01T00:00:00Z','legacy_unverified','hash-b','+8613900139000','Unverified','ACTIVE','2026-01-02T00:00:00Z',NULL,NULL,NULL,'USER'),
('verified-local',NULL,'Local','2026-01-01T00:00:00Z','legacy_local','hash-c','09012345678','Local','ACTIVE','2026-01-02T00:00:00Z',NULL,NULL,'2026-01-02T00:00:00Z','USER');
INSERT INTO user_sessions(id,user_id,expires_at,created_at,last_seen_at,user_agent)
VALUES('session-a','verified-e164','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','test');\n`,
  );
  expectSuccess(runWrangler([...base, '--file', beforeSql]), '测试数据准备');

  const beforeUsers = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        'SELECT id,username,password_hash,phone,wechat_openid,wechat_unionid FROM users ORDER BY id',
        '--json',
      ]),
      '0007前快照',
    ),
  );
  const beforeSessions = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        'SELECT id,user_id,expires_at,created_at,last_seen_at,user_agent FROM user_sessions ORDER BY id',
        '--json',
      ]),
      '0007前会话快照',
    ),
  );
  expectSuccess(
    runWrangler([
      ...base,
      '--file',
      join(projectRoot, 'drizzle', '0007_auth_identity_foundation.sql'),
    ]),
    '0007 migration',
  );

  const identities = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        'SELECT user_id,provider,provider_user_id,verified_at FROM user_identities ORDER BY user_id',
        '--json',
      ]),
      '身份回填查询',
    ),
  );
  if (
    identities.length !== 1 ||
    identities[0].user_id !== 'verified-e164' ||
    identities[0].provider_user_id !== '+8613800138000'
  ) {
    fail(`保守回填结果不正确：${JSON.stringify(identities)}`);
  }

  const afterUsers = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        'SELECT id,username,password_hash,phone,wechat_openid,wechat_unionid FROM users ORDER BY id',
        '--json',
      ]),
      '0007后快照',
    ),
  );
  const afterSessions = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        'SELECT id,user_id,expires_at,created_at,last_seen_at,user_agent FROM user_sessions ORDER BY id',
        '--json',
      ]),
      '0007后会话快照',
    ),
  );
  if (JSON.stringify(beforeUsers) !== JSON.stringify(afterUsers)) {
    fail('0007 修改了旧 users 数据');
  }
  if (JSON.stringify(beforeSessions) !== JSON.stringify(afterSessions)) {
    fail('0007 修改了旧 user_sessions 数据');
  }

  const duplicatePhone = runWrangler([
    ...base,
    '--command',
    "INSERT INTO user_identities(id,user_id,provider,provider_user_id,verified_at,created_at) VALUES('duplicate-phone','unverified','PHONE','+8613800138000','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')",
  ]);
  if (duplicatePhone.status === 0) fail('PHONE 唯一约束未生效');
  console.log('PASS 冲突报告：重复 PHONE identity 被唯一约束拒绝，未合并用户。');

  expectSuccess(
    runWrangler([
      ...base,
      '--command',
      "INSERT INTO user_identities(id,user_id,provider,provider_app_id,provider_user_id,created_at) VALUES('web-a','verified-e164','WECHAT_WEB','web-app','openid-a','2026-01-02T00:00:00Z'),('mini-a','unverified','WECHAT_MINI','mini-app','openid-a','2026-01-02T00:00:00Z')",
    ]),
    '微信身份准备',
  );
  const duplicateWechat = runWrangler([
    ...base,
    '--command',
    "INSERT INTO user_identities(id,user_id,provider,provider_app_id,provider_user_id,created_at) VALUES('web-duplicate','unverified','WECHAT_WEB','web-app','openid-a','2026-01-02T00:00:00Z')",
  ]);
  if (duplicateWechat.status === 0) fail('微信身份唯一约束未生效');

  if (normalizePhoneToE164('09012345678', 'JP') !== '+819012345678') {
    fail('日本手机号规范化失败');
  }
  if (normalizePhoneToE164('13800138000', 'CN') !== '+8613800138000') {
    fail('中国手机号规范化失败');
  }
  expectThrows(
    () => normalizePhoneToE164('09012345678'),
    '国家或地区',
    '未指定地区的本地手机号',
  );

  const pepper = 'test-only-pepper-with-at-least-32-characters';
  const challengeId = 'challenge-1';
  const hash = await hashSmsCode('123456', challengeId, 'LOGIN', pepper);
  if (!(await verifySmsCodeHash('123456', challengeId, 'LOGIN', hash, pepper))) {
    fail('验证码哈希验证失败');
  }
  if (await verifySmsCodeHash('654321', challengeId, 'LOGIN', hash, pepper)) {
    fail('错误验证码被接受');
  }
  if (await verifySmsCodeHash('123456', challengeId, 'REGISTER', hash, pepper)) {
    fail('验证码用途隔离失败');
  }
  const validState = {
    purpose: 'LOGIN',
    expiresAt: '2030-01-01T00:00:00Z',
    attemptCount: 0,
    maxAttempts: 5,
    usedAt: null,
  };
  assertSmsVerificationUsable(validState, 'LOGIN', new Date('2029-01-01T00:00:00Z'));
  expectThrows(
    () => assertSmsVerificationUsable({ ...validState, usedAt: '2029-01-01T00:00:00Z' }, 'LOGIN'),
    '已使用',
    '一次性消费',
  );
  expectThrows(
    () => assertSmsVerificationUsable({ ...validState, attemptCount: 5 }, 'LOGIN'),
    '次数',
    '尝试次数限制',
  );
  expectThrows(
    () => assertSmsVerificationUsable(validState, 'LOGIN', new Date('2031-01-01T00:00:00Z')),
    '已过期',
    '过期判断',
  );

  expectSuccess(
    runWrangler([
      ...base,
      '--file',
      join(projectRoot, 'db', 'rollback', '0007_auth_identity_foundation.rollback.sql'),
    ]),
    '0007 rollback',
  );
  const remaining = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        "SELECT COUNT(*) total FROM sqlite_schema WHERE type='table' AND name IN ('user_identities','sms_verifications')",
        '--json',
      ]),
      'rollback结构检查',
    ),
  );
  if (Number(remaining[0]?.total ?? -1) !== 0) fail('rollback 未删除0007表');
  const preserved = resultRows(
    expectSuccess(
      runWrangler([
        ...base,
        '--command',
        "SELECT COUNT(*) total FROM users WHERE id='verified-e164' AND password_hash='hash-a';",
        '--json',
      ]),
      'rollback数据检查',
    ),
  );
  if (Number(preserved[0]?.total ?? 0) !== 1) fail('rollback 破坏了旧用户数据');

  console.log('PASS：0000—0007、保守回填、身份唯一性、手机号规范化、验证码安全和0007 rollback全部通过。');
  console.log(`隔离的本地测试目录：${work}`);
}

main().catch((error) => {
  console.error(`FAIL：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
