import { createAliyunAcs3Request } from './aliyun-openapi.ts';
import {
  assertSmsSendAllowed,
  SmsProviderError,
  type SmsSendResult,
  type SmsVerificationProvider,
} from './sms-provider-shared.ts';
import type { SmsVerificationPurpose } from './sms-verification.ts';

type AliyunEnvironment = {
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

type AliyunResult = {
  Code?: string; Message?: string; RequestId?: string; Success?: boolean;
  Model?: { OutId?: string; VerifyResult?: string };
};

const TEMPLATE_KEYS: Record<SmsVerificationPurpose, keyof AliyunEnvironment> = {
  REGISTER: 'ALIYUN_SMS_TEMPLATE_REGISTER', LOGIN: 'ALIYUN_SMS_TEMPLATE_LOGIN',
  RESET_PASSWORD: 'ALIYUN_SMS_TEMPLATE_RESET_PASSWORD', BIND_PHONE: 'ALIYUN_SMS_TEMPLATE_BIND_PHONE',
  CHANGE_PHONE: 'ALIYUN_SMS_TEMPLATE_CHANGE_PHONE',
};

function required(settings: AliyunEnvironment, key: keyof AliyunEnvironment) {
  const value = settings[key]?.trim();
  if (!value) throw new SmsProviderError('SMS_PROVIDER_UNAVAILABLE', 503);
  return value;
}

export function mapAliyunSmsError(code = '', message = '') {
  const value = `${code} ${message}`.toUpperCase();
  if (/FREQUENCY|THROTTL|BUSINESS_LIMIT/.test(value)) return new SmsProviderError('SMS_TOO_FREQUENT', 429, 60);
  if (/EXPIRED/.test(value)) return new SmsProviderError('SMS_CODE_EXPIRED', 400);
  if (/VERIFY|CODE.*(ERROR|INVALID)|INVALID.*CODE/.test(value)) return new SmsProviderError('SMS_CODE_INVALID', 400);
  if (/TIMEOUT|UNAVAILABLE|INTERNAL|SYSTEM_ERROR|SERVICE/.test(value)) return new SmsProviderError('SMS_PROVIDER_UNAVAILABLE', 503);
  return new SmsProviderError('SMS_PROVIDER_REJECTED', 502);
}

export class AliyunSmsAuthenticationProvider implements SmsVerificationProvider {
  private readonly settings: AliyunEnvironment;
  private readonly fetcher: typeof fetch;
  constructor(settings: AliyunEnvironment, fetcher: typeof fetch = fetch) { this.settings=settings; this.fetcher=fetcher; }

  private async request(action: string, query: Record<string, string>): Promise<AliyunResult> {
    const request = await createAliyunAcs3Request({
      endpoint: this.settings.ALIYUN_SMS_ENDPOINT || 'https://dypnsapi.aliyuncs.com',
      accessKeyId: required(this.settings, 'ALIYUN_SMS_ACCESS_KEY_ID'),
      accessKeySecret: required(this.settings, 'ALIYUN_SMS_ACCESS_KEY_SECRET'),
      action, version: '2017-05-25', query,
    });
    let response: Response;
    try { response = await this.fetcher(request.url, request.init); }
    catch { throw new SmsProviderError('SMS_PROVIDER_UNAVAILABLE', 503); }
    let result: AliyunResult;
    try { result = await response.json<AliyunResult>(); }
    catch { throw new SmsProviderError('SMS_PROVIDER_UNAVAILABLE', 503); }
    if (!response.ok || result.Code !== 'OK' || result.Success === false) throw mapAliyunSmsError(result.Code, result.Message);
    return result;
  }

  async sendCode(input: { db: D1Database; phoneE164: string; purpose: SmsVerificationPurpose; requestedIpHash: string; now?: Date }): Promise<SmsSendResult> {
    const now = input.now ?? new Date();
    await assertSmsSendAllowed({ ...input, now });
    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + 300_000);
    const result = await this.request('SendSmsVerifyCode', {
      CountryCode: '86', PhoneNumber: input.phoneE164.replace(/^\+86/, ''),
      SignName: required(this.settings, 'ALIYUN_SMS_SIGNATURE'),
      TemplateCode: required(this.settings, TEMPLATE_KEYS[input.purpose]),
      TemplateParam: JSON.stringify({ code: '##code##', min: '5' }),
      CodeType: '1', CodeLength: '6', ValidTime: '300', DuplicatePolicy: '1', Interval: '60',
      ReturnVerifyCode: 'false', OutId: challengeId,
      RegionId: this.settings.ALIYUN_SMS_REGION_ID || 'cn-hangzhou',
    });
    const providerChallengeId = result.Model?.OutId || challengeId;
    await input.db.prepare(`INSERT INTO sms_verifications
      (id,phone_e164,purpose,code_hash,expires_at,attempt_count,max_attempts,used_at,created_at,requested_ip_hash,provider,provider_request_id,provider_challenge_id,provider_status)
      VALUES (?,?,?,'provider_managed',?,0,5,NULL,?,?,'ALIYUN_SMS_AUTH',?,?, 'ACCEPTED')`).bind(
        challengeId, input.phoneE164, input.purpose, expiresAt.toISOString(), now.toISOString(), input.requestedIpHash,
        result.RequestId || null, providerChallengeId,
      ).run();
    return { cooldownSeconds: 60, expiresInSeconds: 300, provider: 'ALIYUN_SMS_AUTH', providerRequestId: result.RequestId, providerChallengeId, acceptedAt: now.toISOString(), providerStatus: 'ACCEPTED' };
  }

  async verifyCode(input: { db: D1Database; phoneE164: string; purpose: SmsVerificationPurpose; code: string; now?: Date }) {
    const now = input.now ?? new Date();
    const row = await input.db.prepare(`SELECT id,expires_at,attempt_count,max_attempts,used_at,provider_challenge_id
      FROM sms_verifications WHERE phone_e164=? AND purpose=? AND provider='ALIYUN_SMS_AUTH' AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`).bind(input.phoneE164, input.purpose).first<{ id: string; expires_at: string; attempt_count: number; max_attempts: number; used_at: string | null; provider_challenge_id: string }>();
    if (!row) throw new SmsProviderError('SMS_CODE_INVALID', 400);
    if (row.used_at) throw new SmsProviderError('SMS_CODE_INVALID', 400);
    if (row.attempt_count >= row.max_attempts) throw new SmsProviderError('SMS_ATTEMPTS_EXCEEDED', 429);
    if (new Date(row.expires_at).getTime() <= now.getTime()) throw new SmsProviderError('SMS_CODE_EXPIRED', 400);
    const result = await this.request('CheckSmsVerifyCode', {
      CountryCode: '86', PhoneNumber: input.phoneE164.replace(/^\+86/, ''), VerifyCode: input.code,
      OutId: row.provider_challenge_id, CaseAuthPolicy: '1',
      RegionId: this.settings.ALIYUN_SMS_REGION_ID || 'cn-hangzhou',
    });
    if (result.Model?.VerifyResult !== 'PASS') {
      await input.db.prepare(`UPDATE sms_verifications SET attempt_count=attempt_count+1,provider_request_id=?,provider_status='INVALID'
        WHERE id=? AND used_at IS NULL AND attempt_count<max_attempts`).bind(result.RequestId || null, row.id).run();
      if (row.attempt_count + 1 >= row.max_attempts) throw new SmsProviderError('SMS_ATTEMPTS_EXCEEDED', 429);
      throw new SmsProviderError('SMS_CODE_INVALID', 400);
    }
    const consumed = await input.db.prepare(`UPDATE sms_verifications SET used_at=?,provider_request_id=?,provider_status='VERIFIED'
      WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>? AND attempt_count<max_attempts`).bind(
        now.toISOString(), result.RequestId || null, row.id, input.purpose, now.toISOString(),
      ).run();
    if (Number(consumed.meta.changes ?? 0) !== 1) throw new SmsProviderError('SMS_CODE_EXPIRED', 400);
  }
}
