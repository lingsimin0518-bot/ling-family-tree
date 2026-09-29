export const BUSINESS_TABLES = [
  'action_idempotency',
  'action_rate_limit',
  'announcements',
  'families',
  'family_activities',
  'family_users',
  'generations',
  'media',
  'person_claims',
  'phone_change_challenges',
  'persons',
  'relationships',
  'review_requests',
  'sms_verifications',
  'system_audit_logs',
  'user_identities',
  'user_messages',
  'user_sessions',
  'users',
] as const;

// Children are deleted before their parents. The list is fixed in server code;
// callers cannot choose tables or inject identifiers.
export const BUSINESS_TABLE_DELETE_ORDER = [
  'user_messages',
  'review_requests',
  'family_activities',
  'person_claims',
  'media',
  'relationships',
  'announcements',
  'generations',
  'phone_change_challenges',
  'user_identities',
  'user_sessions',
  'action_rate_limit',
  'action_idempotency',
  'family_users',
  'persons',
  'system_audit_logs',
  'sms_verifications',
  'families',
  'users',
] as const;

const BOOTSTRAP_AUDIT_ID = 'system-bootstrap-super-admin-v1';
const encoder = new TextEncoder();

export class LifecycleError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function constantTimeEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function requireSecret(provided: string, expected: string) {
  if (expected.length < 32 || !(await constantTimeEqual(provided, expected))) {
    throw new LifecycleError(403, 'INVALID_LIFECYCLE_SECRET', '生命周期操作凭证无效');
  }
}

async function tableCounts(binding: D1Database) {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_TABLES) {
    const row = await binding.prepare(`SELECT COUNT(*) total FROM "${table}"`).first<{ total: number }>();
    counts[table] = Number(row?.total ?? 0);
  }
  return counts;
}

export type ProductionResetInput = {
  environment: string;
  expectedEnvironment: string;
  projectId: string;
  expectedProjectId: string;
  operatorUserId: string;
  confirmation: string;
  secret: string;
  expectedSecret: string;
  verifiedBackupSha256: string;
  expectedBackupSha256: string;
};

export async function resetAllBusinessData(binding: D1Database, input: ProductionResetInput) {
  if (!input.expectedEnvironment || input.environment !== input.expectedEnvironment) {
    throw new LifecycleError(409, 'WRONG_ENVIRONMENT', '目标环境与重置配置不一致');
  }
  if (!input.expectedProjectId || input.projectId !== input.expectedProjectId) {
    throw new LifecycleError(409, 'WRONG_PROJECT', '目标项目与重置配置不一致');
  }
  if (input.confirmation !== `RESET_ALL_BUSINESS_DATA:${input.projectId}`) {
    throw new LifecycleError(400, 'CONFIRMATION_MISMATCH', '生产重置确认文本不正确');
  }
  await requireSecret(input.secret, input.expectedSecret);
  if (!/^[a-f0-9]{64}$/i.test(input.expectedBackupSha256)
    || !(await constantTimeEqual(input.verifiedBackupSha256, input.expectedBackupSha256))) {
    throw new LifecycleError(412, 'BACKUP_ATTESTATION_REQUIRED', '未确认经过恢复验证的最终备份');
  }
  const operator = await binding.prepare(
    "SELECT id FROM users WHERE id=? AND status='ACTIVE' AND system_role='SUPER_ADMIN'",
  ).bind(input.operatorUserId).first<{ id: string }>();
  if (!operator) {
    throw new LifecycleError(403, 'SUPER_ADMIN_REQUIRED', '只有现有系统超级管理员可以执行正式重置');
  }

  const before = await tableCounts(binding);
  // D1 batch is transactional: if a DELETE statement fails, the whole batch is rolled back.
  await binding.batch(BUSINESS_TABLE_DELETE_ORDER.map((table) => binding.prepare(`DELETE FROM "${table}"`)));
  const after = await tableCounts(binding);
  const remaining = Object.entries(after).filter(([, count]) => count !== 0);
  if (remaining.length) {
    throw new LifecycleError(500, 'RESET_VERIFICATION_FAILED', '重置完成后的逐表核对失败');
  }
  const foreignKeys = await binding.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.results.length) {
    throw new LifecycleError(500, 'FOREIGN_KEY_CHECK_FAILED', '重置后的外键检查失败');
  }
  return { before, after, foreignKeyViolations: 0 };
}

export type SuperAdminBootstrapInput = {
  targetUserId: string;
  confirmation: string;
  secret: string;
  expectedSecret: string;
};

export async function bootstrapSuperAdmin(binding: D1Database, input: SuperAdminBootstrapInput) {
  if (!input.targetUserId || input.confirmation !== `BOOTSTRAP_SUPER_ADMIN:${input.targetUserId}`) {
    throw new LifecycleError(400, 'CONFIRMATION_MISMATCH', '超级管理员初始化确认文本不正确');
  }
  await requireSecret(input.secret, input.expectedSecret);
  const existingLock = await binding.prepare('SELECT id FROM system_audit_logs WHERE id=?')
    .bind(BOOTSTRAP_AUDIT_ID).first();
  if (existingLock) {
    throw new LifecycleError(409, 'BOOTSTRAP_ALREADY_USED', '超级管理员初始化已永久锁定');
  }
  const count = await binding.prepare("SELECT COUNT(*) total FROM users WHERE system_role='SUPER_ADMIN'")
    .first<{ total: number }>();
  if (Number(count?.total ?? 0) !== 0) {
    throw new LifecycleError(409, 'SUPER_ADMIN_ALREADY_EXISTS', '系统中已经存在超级管理员');
  }
  const target = await binding.prepare("SELECT id FROM users WHERE id=? AND status='ACTIVE' AND system_role='USER'")
    .bind(input.targetUserId).first<{ id: string }>();
  if (!target) {
    throw new LifecycleError(404, 'TARGET_USER_NOT_ELIGIBLE', '未找到符合条件的目标用户');
  }

  const now = new Date().toISOString();
  const results = await binding.batch([
    binding.prepare(`UPDATE users SET system_role='SUPER_ADMIN',updated_at=?
      WHERE id=? AND status='ACTIVE' AND system_role='USER'
      AND NOT EXISTS (SELECT 1 FROM users WHERE system_role='SUPER_ADMIN')
      AND NOT EXISTS (SELECT 1 FROM system_audit_logs WHERE id=?)`)
      .bind(now, input.targetUserId, BOOTSTRAP_AUDIT_ID),
    binding.prepare(`INSERT INTO system_audit_logs
      (id,operator_user_id,action_type,target_user_id,old_value,new_value,created_at,reason)
      VALUES (?,?, 'SUPER_ADMIN_BOOTSTRAP',?,'USER','SUPER_ADMIN',?,?)`)
      .bind(
        BOOTSTRAP_AUDIT_ID,
        input.targetUserId,
        input.targetUserId,
        now,
        '正式环境一次性超级管理员初始化；目标按 user_id 明确指定。',
      ),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new LifecycleError(409, 'BOOTSTRAP_RACE_REJECTED', '初始化状态已变化，请停止并核对');
  }
  const verified = await binding.prepare("SELECT id FROM users WHERE id=? AND system_role='SUPER_ADMIN'")
    .bind(input.targetUserId).first();
  if (!verified) {
    throw new LifecycleError(500, 'BOOTSTRAP_VERIFICATION_FAILED', '超级管理员初始化后的验证失败');
  }
  return { targetUserId: input.targetUserId, systemRole: 'SUPER_ADMIN', locked: true } as const;
}
