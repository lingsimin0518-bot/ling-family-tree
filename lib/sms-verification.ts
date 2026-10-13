export const SMS_VERIFICATION_PURPOSES = [
  'REGISTER',
  'LOGIN',
  'RESET_PASSWORD',
  'BIND_PHONE',
  'CHANGE_PHONE',
] as const;

export type SmsVerificationPurpose = (typeof SMS_VERIFICATION_PURPOSES)[number];

export type SmsVerificationState = {
  purpose: SmsVerificationPurpose;
  expiresAt: string;
  attemptCount: number;
  maxAttempts: number;
  usedAt: string | null;
};

type SmsVerificationRow = {
  id: string;
  phone_e164: string;
  purpose: SmsVerificationPurpose;
  code_hash: string;
  expires_at: string;
  attempt_count: number;
  max_attempts: number;
  used_at: string | null;
};

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function hmacSha256(value: string, pepper: string) {
  if (pepper.length < 32) throw new Error('短信验证码密钥长度不足');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hashSmsCode(
  code: string,
  challengeId: string,
  purpose: SmsVerificationPurpose,
  pepper: string,
) {
  if (!/^\d{4,8}$/.test(code)) throw new Error('短信验证码格式不正确');
  if (!challengeId) throw new Error('验证码挑战 ID 不能为空');
  return `hmac_sha256$${await hmacSha256(`${challengeId}:${purpose}:${code}`, pepper)}`;
}

export async function verifySmsCodeHash(
  code: string,
  challengeId: string,
  purpose: SmsVerificationPurpose,
  storedHash: string,
  pepper: string,
) {
  if (!storedHash.startsWith('hmac_sha256$')) return false;
  try {
    const actual = await hashSmsCode(code, challengeId, purpose, pepper);
    return constantTimeEqual(actual, storedHash);
  } catch {
    return false;
  }
}

export function assertSmsVerificationUsable(
  state: SmsVerificationState,
  expectedPurpose: SmsVerificationPurpose,
  now = new Date(),
) {
  if (state.purpose !== expectedPurpose) throw new Error('验证码用途不匹配');
  if (state.usedAt) throw new Error('验证码已使用');
  if (state.attemptCount >= state.maxAttempts) throw new Error('验证码尝试次数已用完');
  if (new Date(state.expiresAt).getTime() <= now.getTime()) throw new Error('验证码已过期');
}

export async function verifyAndConsumeSmsVerification(
  db: D1Database,
  input: {
    challengeId: string;
    phoneE164: string;
    purpose: SmsVerificationPurpose;
    code: string;
    pepper: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const row = await db
    .prepare(`SELECT id,phone_e164,purpose,code_hash,expires_at,attempt_count,max_attempts,used_at
      FROM sms_verifications WHERE id=? AND phone_e164=? LIMIT 1`)
    .bind(input.challengeId, input.phoneE164)
    .first<SmsVerificationRow>();
  if (!row) throw new Error('验证码不存在');
  assertSmsVerificationUsable(
    {
      purpose: row.purpose,
      expiresAt: row.expires_at,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      usedAt: row.used_at,
    },
    input.purpose,
    now,
  );

  const valid = await verifySmsCodeHash(
    input.code,
    row.id,
    input.purpose,
    row.code_hash,
    input.pepper,
  );
  if (!valid) {
    await db
      .prepare(`UPDATE sms_verifications SET attempt_count=attempt_count+1
        WHERE id=? AND used_at IS NULL AND attempt_count<max_attempts`)
      .bind(row.id)
      .run();
    return false;
  }

  const consumed = await db
    .prepare(`UPDATE sms_verifications SET used_at=?
      WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>? AND attempt_count<max_attempts`)
    .bind(now.toISOString(), row.id, input.purpose, now.toISOString())
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) throw new Error('验证码已失效，请重新获取');
  return true;
}
