export const IDENTITY_PROVIDERS = ['PHONE', 'WECHAT_WEB', 'WECHAT_MINI'] as const;

export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];
export type PhoneRegion = 'CN' | 'JP';

export type UserIdentity = {
  id: string;
  userId: string;
  provider: IdentityProvider;
  providerAppId: string | null;
  providerUserId: string;
  unionId: string | null;
  unionScope: string | null;
  verifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

type IdentityRow = {
  id: string;
  user_id: string;
  provider: IdentityProvider;
  provider_app_id: string | null;
  provider_user_id: string;
  union_id: string | null;
  union_scope: string | null;
  verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
};

export type CreateIdentityInput = {
  userId: string;
  provider: IdentityProvider;
  providerAppId?: string | null;
  providerUserId: string;
  unionId?: string | null;
  unionScope?: string | null;
  verifiedAt?: string | null;
  createdAt?: string;
};

export class IdentityConflictError extends Error {
  constructor() {
    super('该登录身份已绑定其他账号');
    this.name = 'IdentityConflictError';
  }
}

function cleanDigits(value: string) {
  return value.replace(/[\s()-]/g, '');
}

function assertE164(value: string) {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error('手机号必须是有效的 E.164 格式');
  }
  return value;
}

export function normalizePhoneToE164(input: string, region?: PhoneRegion) {
  const source = cleanDigits(input.trim());
  if (!source) throw new Error('请输入手机号');
  if (source.startsWith('+')) return assertE164(source);
  if (!region) throw new Error('本地手机号必须明确选择国家或地区');

  if (region === 'CN') {
    if (!/^1[3-9]\d{9}$/.test(source)) throw new Error('中国大陆手机号格式不正确');
    return `+86${source}`;
  }

  if (!/^0[789]0\d{8}$/.test(source)) throw new Error('日本手机号格式不正确');
  return `+81${source.slice(1)}`;
}

export function normalizeMainlandChinaPhone(input: string) {
  const source = cleanDigits(input.trim());
  if (!/^1[3-9]\d{9}$/.test(source)) {
    throw new Error('请输入11位中国大陆手机号');
  }
  return normalizePhoneToE164(source, 'CN');
}

export function maskMainlandChinaPhone(phoneE164: string) {
  const normalized = normalizePhoneToE164(phoneE164);
  if (!/^\+861[3-9]\d{9}$/.test(normalized)) throw new Error('中国大陆手机号格式不正确');
  return `${normalized.slice(3, 6)}****${normalized.slice(-4)}`;
}

function mapIdentity(row: IdentityRow | null): UserIdentity | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerAppId: row.provider_app_id,
    providerUserId: row.provider_user_id,
    unionId: row.union_id,
    unionScope: row.union_scope,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function findPhoneIdentity(db: D1Database, phoneE164: string) {
  const phone = normalizePhoneToE164(phoneE164);
  const row = await db
    .prepare("SELECT * FROM user_identities WHERE provider='PHONE' AND provider_user_id=? LIMIT 1")
    .bind(phone)
    .first<IdentityRow>();
  return mapIdentity(row);
}

export async function findWechatIdentity(
  db: D1Database,
  provider: Extract<IdentityProvider, 'WECHAT_WEB' | 'WECHAT_MINI'>,
  providerAppId: string,
  openId: string,
) {
  if (!providerAppId.trim() || !openId.trim()) throw new Error('微信身份参数不完整');
  const row = await db
    .prepare(
      'SELECT * FROM user_identities WHERE provider=? AND provider_app_id=? AND provider_user_id=? LIMIT 1',
    )
    .bind(provider, providerAppId.trim(), openId.trim())
    .first<IdentityRow>();
  return mapIdentity(row);
}

export async function findUserByIdentity(
  db: D1Database,
  provider: IdentityProvider,
  providerUserId: string,
  providerAppId?: string | null,
) {
  const identity =
    provider === 'PHONE'
      ? await findPhoneIdentity(db, providerUserId)
      : await findWechatIdentity(
          db,
          provider,
          providerAppId ?? '',
          providerUserId,
        );
  return identity?.userId ?? null;
}

function isUniqueConstraintError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}

export async function createIdentity(db: D1Database, input: CreateIdentityInput) {
  const providerAppId = input.providerAppId?.trim() || null;
  const providerUserId =
    input.provider === 'PHONE'
      ? normalizePhoneToE164(input.providerUserId)
      : input.providerUserId.trim();
  if (!input.userId.trim() || !providerUserId) throw new Error('身份参数不完整');
  if (input.provider !== 'PHONE' && !providerAppId) throw new Error('微信身份必须提供 AppID');
  if (input.provider === 'PHONE' && !input.verifiedAt) throw new Error('手机号身份必须先完成验证');

  const now = input.createdAt ?? new Date().toISOString();
  try {
    await db
      .prepare(`INSERT INTO user_identities
        (id,user_id,provider,provider_app_id,provider_user_id,union_id,union_scope,verified_at,created_at,last_login_at)
        VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
      .bind(
        crypto.randomUUID(),
        input.userId,
        input.provider,
        providerAppId,
        providerUserId,
        input.provider === 'PHONE' ? null : input.unionId?.trim() || null,
        input.provider === 'PHONE' ? null : input.unionScope?.trim() || null,
        input.verifiedAt ?? null,
        now,
      )
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new IdentityConflictError();
    throw error;
  }

  const identity =
    input.provider === 'PHONE'
      ? await findPhoneIdentity(db, providerUserId)
      : await findWechatIdentity(db, input.provider, providerAppId ?? '', providerUserId);
  if (!identity || identity.userId !== input.userId) throw new IdentityConflictError();
  return identity;
}

export async function touchIdentityLastLogin(
  db: D1Database,
  identityId: string,
  lastLoginAt = new Date().toISOString(),
) {
  const result = await db
    .prepare('UPDATE user_identities SET last_login_at=? WHERE id=?')
    .bind(lastLoginAt, identityId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error('登录身份不存在');
}
