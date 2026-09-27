import type { SmsVerificationPurpose } from './sms-verification.ts';

export type SmsProviderName = 'MOCK' | 'ALIYUN_SMS_AUTH';
export type SmsSendResult = { cooldownSeconds: number; expiresInSeconds: number; provider: SmsProviderName; providerRequestId?: string; providerChallengeId?: string; acceptedAt: string; providerStatus: string };
export interface SmsVerificationProvider {
  sendCode(input: { db: D1Database; phoneE164: string; purpose: SmsVerificationPurpose; requestedIpHash: string; now?: Date }): Promise<SmsSendResult>;
  verifyCode(input: { db: D1Database; phoneE164: string; purpose: SmsVerificationPurpose; code: string; now?: Date }): Promise<void>;
}
export class SmsProviderError extends Error {
  readonly code: 'SMS_TOO_FREQUENT'|'SMS_PROVIDER_UNAVAILABLE'|'SMS_CODE_INVALID'|'SMS_CODE_EXPIRED'|'SMS_ATTEMPTS_EXCEEDED'|'SMS_PROVIDER_REJECTED';
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: SmsProviderError['code'], status: number, retryAfterSeconds?: number) { super(code); this.code=code; this.status=status; this.retryAfterSeconds=retryAfterSeconds; }
}
export async function assertSmsSendAllowed(input: { db: D1Database; phoneE164: string; requestedIpHash: string; now: Date }) {
  const hourAgo = new Date(input.now.getTime()-3_600_000).toISOString();
  const dayAgo = new Date(input.now.getTime()-86_400_000).toISOString();
  const latest = await input.db.prepare('SELECT created_at FROM sms_verifications WHERE phone_e164=? ORDER BY created_at DESC LIMIT 1').bind(input.phoneE164).first<{created_at:string}>();
  if (latest && input.now.getTime()-new Date(latest.created_at).getTime()<60_000) {
    const retry=Math.max(1,Math.ceil((60_000-(input.now.getTime()-new Date(latest.created_at).getTime()))/1000));
    throw new SmsProviderError('SMS_TOO_FREQUENT',429,retry);
  }
  const queries=[
    input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE phone_e164=? AND created_at>=?').bind(input.phoneE164,hourAgo),
    input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE phone_e164=? AND created_at>=?').bind(input.phoneE164,dayAgo),
    input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE requested_ip_hash=? AND created_at>=?').bind(input.requestedIpHash,hourAgo),
    input.db.prepare('SELECT COUNT(*) total FROM sms_verifications WHERE requested_ip_hash=? AND created_at>=?').bind(input.requestedIpHash,dayAgo),
  ];
  const counts=await Promise.all(queries.map((query)=>query.first<{total:number}>()));
  if (counts.some((row,index)=>Number(row?.total??0)>=[5,10,20,50][index])) throw new SmsProviderError('SMS_TOO_FREQUENT',429,3600);
}
