import { env } from 'cloudflare:workers';
import {
  hashSmsCode,
  SMS_VERIFICATION_PURPOSES,
  type SmsVerificationPurpose,
  verifyAndConsumeSmsVerification,
} from './sms-verification';

const MOCK_CODES: Record<string, string> = {
  '+8613800138000': '123456',
  '+8613900139000': '123456',
  '+8613600136000': '123456',
};

type SmsEnvironment = {
  SMS_MODE?: string;
  APP_ENV?: string;
  SMS_CODE_PEPPER?: string;
};

export interface SmsVerificationProvider {
  sendCode(input: {
    db: D1Database;
    phoneE164: string;
    purpose: SmsVerificationPurpose;
    requestedIpHash: string;
    now?: Date;
  }): Promise<{ cooldownSeconds: number; expiresInSeconds: number }>;
  verifyCode(input: {
    db: D1Database;
    phoneE164: string;
    purpose: SmsVerificationPurpose;
    code: string;
    now?: Date;
  }): Promise<void>;
}

function smsEnvironment() {
  return env as unknown as SmsEnvironment;
}

export function assertSmsPurpose(value: unknown): SmsVerificationPurpose {
  if (typeof value !== 'string' || !SMS_VERIFICATION_PURPOSES.includes(value as SmsVerificationPurpose)) {
    throw new Response('验证码用途不正确', { status: 400 });
  }
  return value as SmsVerificationPurpose;
}

function pepper() {
  const value = smsEnvironment().SMS_CODE_PEPPER || 'local-mock-sms-pepper-change-before-production';
  if (value.length < 32) throw new Error('短信验证码密钥长度不足');
  return value;
}

function ensureMockAllowed() {
  const settings = smsEnvironment();
  if (settings.SMS_MODE !== 'mock') throw new Response('短信服务尚未配置', { status: 503 });
  if (!['development', 'test'].includes((settings.APP_ENV || '').toLowerCase())) {
    throw new Response('生产环境禁止使用模拟短信服务', { status: 503 });
  }
}

async function latestChallenge(db: D1Database, phoneE164: string, purpose: SmsVerificationPurpose) {
  return db.prepare(`SELECT id FROM sms_verifications
    WHERE phone_e164=? AND purpose=? AND used_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).bind(phoneE164, purpose).first<{ id: string }>();
}

export class MockSmsProvider implements SmsVerificationProvider {
  async sendCode(input: {
    db: D1Database;
    phoneE164: string;
    purpose: SmsVerificationPurpose;
    requestedIpHash: string;
    now?: Date;
  }) {
    ensureMockAllowed();
    const now = input.now ?? new Date();
    if (input.phoneE164 === '+8613700137000') throw new Response('短信发送失败，请稍后重试', { status: 503 });
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const latest = await input.db.prepare(`SELECT created_at FROM sms_verifications
      WHERE phone_e164=? ORDER BY created_at DESC LIMIT 1`).bind(input.phoneE164).first<{ created_at: string }>();
    if (latest && now.getTime() - new Date(latest.created_at).getTime() < 60_000) {
      const retry = Math.max(1, Math.ceil((60_000 - (now.getTime() - new Date(latest.created_at).getTime())) / 1000));
      throw new Response(`验证码发送过于频繁，请在${retry}秒后再试`, { status: 429, headers: { 'Retry-After': String(retry) } });
    }
    const phoneHour = await input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE phone_e164=? AND created_at>=?').bind(input.phoneE164, hourAgo).first<{ total: number }>();
    const phoneDay = await input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE phone_e164=? AND created_at>=?').bind(input.phoneE164, dayAgo).first<{ total: number }>();
    const ipHour = await input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE requested_ip_hash=? AND created_at>=?').bind(input.requestedIpHash, hourAgo).first<{ total: number }>();
    const ipDay = await input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE requested_ip_hash=? AND created_at>=?').bind(input.requestedIpHash, dayAgo).first<{ total: number }>();
    if (input.phoneE164 === '+8613600136000' || Number(phoneHour?.total ?? 0) >= 5 || Number(phoneDay?.total ?? 0) >= 10 || Number(ipHour?.total ?? 0) >= 20 || Number(ipDay?.total ?? 0) >= 50) {
      throw new Response('验证码请求过于频繁，请稍后再试', { status: 429, headers: { 'Retry-After': '3600' } });
    }
    const challengeId = crypto.randomUUID();
    const code = MOCK_CODES[input.phoneE164] ?? '123456';
    const expiresAt = input.phoneE164 === '+8613900139000'
      ? new Date(now.getTime() - 1000)
      : new Date(now.getTime() + 300_000);
    const codeHash = await hashSmsCode(code, challengeId, input.purpose, pepper());
    await input.db.prepare(`INSERT INTO sms_verifications
      (id,phone_e164,purpose,code_hash,expires_at,attempt_count,max_attempts,used_at,created_at,requested_ip_hash)
      VALUES (?,?,?,?,?,0,5,NULL,?,?)`).bind(
        challengeId, input.phoneE164, input.purpose, codeHash, expiresAt.toISOString(), now.toISOString(), input.requestedIpHash,
      ).run();
    return { cooldownSeconds: 60, expiresInSeconds: 300 };
  }

  async verifyCode(input: {
    db: D1Database;
    phoneE164: string;
    purpose: SmsVerificationPurpose;
    code: string;
    now?: Date;
  }) {
    ensureMockAllowed();
    const challenge = await latestChallenge(input.db, input.phoneE164, input.purpose);
    if (!challenge) throw new Response('验证码无效或已过期', { status: 400 });
    try {
      const valid = await verifyAndConsumeSmsVerification(input.db, {
        challengeId: challenge.id,
        phoneE164: input.phoneE164,
        purpose: input.purpose,
        code: input.code,
        pepper: pepper(),
        now: input.now,
      });
      if (!valid) throw new Response('验证码不正确', { status: 400 });
    } catch (error) {
      if (error instanceof Response) throw error;
      throw new Response(error instanceof Error ? error.message : '验证码校验失败', { status: 400 });
    }
  }
}

export function smsProvider(): SmsVerificationProvider {
  return new MockSmsProvider();
}
