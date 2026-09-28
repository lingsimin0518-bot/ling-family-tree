import type { SmsVerificationProvider } from './sms-provider-shared.ts';

export type ControlledSmsTestState = 'NOT_SENT' | 'SENT' | 'VERIFIED';
export type ControlledSmsTestConfig = {
  enabled: boolean;
  smsMode: string;
  phoneE164: string;
  cycleId: string;
};

const ACTOR_KEY = 'system:aliyun-sms-test';
const ACTION_TYPE = 'ALIYUN_SMS_REAL_TEST';

type StatePayload = { state: ControlledSmsTestState; challengeId?: string; locked?: boolean };

export function assertControlledSmsTestAdministrator(user: { systemRole: string }) {
  if (user.systemRole !== 'SUPER_ADMIN') throw new Response('无权使用短信联调功能', { status: 403 });
}

function assertConfig(config: ControlledSmsTestConfig) {
  if (!config.enabled) throw new Response('临时短信联调功能未启用', { status: 404 });
  if (config.smsMode !== 'aliyun') throw new Response('临时短信联调只允许阿里云模式', { status: 503 });
  if (!/^\+861[3-9]\d{9}$/.test(config.phoneE164)) throw new Response('测试手机号白名单未正确配置', { status: 503 });
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(config.cycleId)) throw new Response('测试轮次未正确配置', { status: 503 });
}

function maskPhone(phone: string) {
  return `${phone.slice(3, 6)}****${phone.slice(-4)}`;
}

function parsePayload(value: string | null): StatePayload {
  if (!value) return { state: 'NOT_SENT', locked: true };
  try {
    const parsed = JSON.parse(value) as Partial<StatePayload>;
    if (parsed.state === 'SENT' || parsed.state === 'VERIFIED' || parsed.state === 'NOT_SENT') return parsed as StatePayload;
  } catch { /* invalid rows remain locked */ }
  return { state: 'NOT_SENT', locked: true };
}

async function stateRow(db: D1Database, config: ControlledSmsTestConfig) {
  return db.prepare(`SELECT id,status,response_json FROM action_idempotency
    WHERE actor_key=? AND family_key='' AND action_type=? AND idempotency_key=? LIMIT 1`)
    .bind(ACTOR_KEY, ACTION_TYPE, config.cycleId)
    .first<{ id: string; status: string; response_json: string | null }>();
}

export async function controlledSmsTestStatus(db: D1Database, config: ControlledSmsTestConfig) {
  assertConfig(config);
  const row = await stateRow(db, config);
  return { enabled: true, configured: true, phone: maskPhone(config.phoneE164), state: row ? parsePayload(row.response_json).state : 'NOT_SENT' as ControlledSmsTestState };
}

export async function sendControlledSmsTest(input: { db: D1Database; config: ControlledSmsTestConfig; provider: SmsVerificationProvider; requestedIpHash: string }) {
  assertConfig(input.config);
  if (await stateRow(input.db, input.config)) throw new Response('本轮测试已经发送或已锁定，不能重复计费', { status: 409 });
  const reservationId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await input.db.prepare(`INSERT INTO action_idempotency
      (id,actor_key,family_key,action_type,idempotency_key,status,response_json,created_at)
      VALUES (?,?,'',?,?,'PENDING',?,?)`).bind(
        reservationId, ACTOR_KEY, ACTION_TYPE, input.config.cycleId,
        JSON.stringify({ state: 'NOT_SENT', locked: true } satisfies StatePayload), now,
      ).run();
  } catch {
    throw new Response('本轮测试已经发送或正在处理', { status: 409 });
  }
  const result = await input.provider.sendCode({
    db: input.db, phoneE164: input.config.phoneE164, purpose: 'REGISTER', requestedIpHash: input.requestedIpHash,
  });
  const payload: StatePayload = { state: 'SENT', challengeId: result.providerChallengeId };
  const updated = await input.db.prepare(`UPDATE action_idempotency SET status='COMPLETED',response_json=?,completed_at=?
    WHERE id=? AND status='PENDING'`).bind(JSON.stringify(payload), new Date().toISOString(), reservationId).run();
  if (Number(updated.meta.changes ?? 0) !== 1) throw new Response('测试状态保存失败；本轮已锁定，请勿重发', { status: 500 });
  return { ok: true, phone: maskPhone(input.config.phoneE164), expiresInSeconds: result.expiresInSeconds };
}

export async function verifyControlledSmsTest(input: { db: D1Database; config: ControlledSmsTestConfig; provider: SmsVerificationProvider; code: unknown }) {
  assertConfig(input.config);
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new Response('请输入6位验证码', { status: 400 });
  const row = await stateRow(input.db, input.config);
  const payload = row ? parsePayload(row.response_json) : { state: 'NOT_SENT' as const };
  if (!row || payload.state !== 'SENT') throw new Response(payload.state === 'VERIFIED' ? '本轮验证码已经使用' : '本轮尚未成功发送验证码', { status: 409 });
  await input.provider.verifyCode({ db: input.db, phoneE164: input.config.phoneE164, purpose: 'REGISTER', code });
  const updated = await input.db.prepare(`UPDATE action_idempotency SET response_json=?,completed_at=?
    WHERE id=? AND response_json=?`).bind(
      JSON.stringify({ ...payload, state: 'VERIFIED' } satisfies StatePayload), new Date().toISOString(), row.id, row.response_json,
    ).run();
  if (Number(updated.meta.changes ?? 0) !== 1) throw new Response('验证码已被消费', { status: 409 });
  return { ok: true, phone: maskPhone(input.config.phoneE164), state: 'VERIFIED' as const };
}
