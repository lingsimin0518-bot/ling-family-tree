import { env } from 'cloudflare:workers';
import {
  hashSmsCode,
  SMS_VERIFICATION_PURPOSES,
  type SmsVerificationPurpose,
  verifyAndConsumeSmsVerification,
} from './sms-verification';
import { AliyunSmsAuthenticationProvider } from './aliyun-sms-authentication';
import { assertSmsSendAllowed, SmsProviderError, type SmsVerificationProvider } from './sms-provider-shared';
export { SmsProviderError, type SmsSendResult, type SmsVerificationProvider } from './sms-provider-shared';

const MOCK_CODES: Record<string, string> = {
  '+8613800138000': '123456',
  '+8613900139000': '123456',
  '+8613600136000': '123456',
};

type SmsEnvironment = {
  SMS_MODE?: string;
  APP_ENV?: string;
  SMS_CODE_PEPPER?: string;
  ALIYUN_SMS_ACCESS_KEY_ID?: string;
  ALIYUN_SMS_ACCESS_KEY_SECRET?: string;
  ALIYUN_SMS_ENDPOINT?: string;
  ALIYUN_SMS_REGION_ID?: string;
  ALIYUN_SMS_SIGNATURE?: string;
  ALIYUN_SMS_TEMPLATE_REGISTER?: string;
  ALIYUN_SMS_TEMPLATE_LOGIN?: string;
  ALIYUN_SMS_TEMPLATE_RESET_PASSWORD?: string;
  ALIYUN_SMS_TEMPLATE_BIND_PHONE?: string;
  ALIYUN_SMS_TEMPLATE_CHANGE_PHONE?: string;
};


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
  }): Promise<import('./sms-provider-shared').SmsSendResult> {
    ensureMockAllowed();
    const now = input.now ?? new Date();
    if (input.phoneE164 === '+8613700137000') throw new Response('短信发送失败，请稍后重试', { status: 503 });
    await assertSmsSendAllowed({ ...input, now });
    if (input.phoneE164 === '+8613600136000') throw new SmsProviderError('SMS_TOO_FREQUENT', 429, 3600);
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
    return { cooldownSeconds: 60, expiresInSeconds: 300, provider: 'MOCK', acceptedAt: now.toISOString(), providerStatus: 'ACCEPTED' };
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
  const settings = smsEnvironment();
  if ((settings.SMS_MODE || '').toLowerCase() === 'aliyun') {
    return new AliyunSmsAuthenticationProvider(settings);
  }
  return new MockSmsProvider();
}
