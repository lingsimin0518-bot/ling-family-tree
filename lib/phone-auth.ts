import {
  authDb,
  createAuthSession,
  hashPassword,
  publicAuthUser,
  validateAccountPassword,
  verifyPassword,
  type AuthUser,
} from './auth';
import { findPhoneIdentity, maskMainlandChinaPhone, normalizeMainlandChinaPhone, touchIdentityLastLogin } from './user-identity';
import { smsProvider, type SmsVerificationProvider } from './sms-provider';
import type { SmsVerificationPurpose } from './sms-verification';

type UserRow = Record<string, unknown> & { id: string; password_hash?: string | null; status?: string | null };
const encoder = new TextEncoder();

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function phone(value: unknown) {
  try {
    return normalizeMainlandChinaPhone(text(value));
  } catch (error) {
    throw new Response(error instanceof Error ? error.message : '手机号格式不正确', { status: 400 });
  }
}

function code(value: unknown) {
  const result = text(value).trim();
  if (!/^\d{6}$/.test(result)) throw new Response('请输入6位验证码', { status: 400 });
  return result;
}

async function userRow(db: D1Database, userId: string) {
  return db.prepare(`SELECT id,username,password_hash,email,phone,phone_verified_at,nickname,avatar,status,system_role,display_name
    FROM users WHERE id=?`).bind(userId).first<UserRow>();
}

function ensureActive(row: UserRow | null) {
  if (!row || text(row.status || 'ACTIVE') !== 'ACTIVE') throw new Response('账号当前不可登录', { status: 403 });
  return row;
}

function authResult(row: UserRow, cookie: string) {
  return { user: publicAuthUser(row), cookie };
}

export async function hashRequestIp(request: Request) {
  const raw = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(raw));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}

export async function sendPhoneCode(input: {
  request: Request;
  phone: unknown;
  purpose: SmsVerificationPurpose;
  provider?: SmsVerificationProvider;
}) {
  const db = authDb();
  const phoneE164 = phone(input.phone);
  const identity = await findPhoneIdentity(db, phoneE164);
  if (input.purpose === 'REGISTER' && identity) throw new Response('该手机号已注册', { status: 409 });
  return (input.provider ?? smsProvider()).sendCode({
    db,
    phoneE164,
    purpose: input.purpose,
    requestedIpHash: await hashRequestIp(input.request),
  });
}

export async function registerPhoneUser(input: Record<string, unknown>, request: Request, provider = smsProvider()) {
  const db = authDb();
  const phoneE164 = phone(input.phone);
  const password = text(input.password);
  validateAccountPassword(password);
  if (input.confirmPassword !== undefined && password !== text(input.confirmPassword)) {
    throw new Response('两次输入的密码不一致', { status: 400 });
  }
  if (await findPhoneIdentity(db, phoneE164)) throw new Response('该手机号已注册', { status: 409 });
  await provider.verifyCode({ db, phoneE164, purpose: 'REGISTER', code: code(input.code) });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  try {
    await db.batch([
      db.prepare(`INSERT INTO users
        (id,username,password_hash,email,phone,phone_verified_at,nickname,avatar,status,system_role,display_name,created_at,updated_at)
        VALUES (?,NULL,?,NULL,?,?,NULL,'','ACTIVE','USER',NULL,?,?)`).bind(id, passwordHash, phoneE164, now, now, now),
      db.prepare(`INSERT INTO user_identities
        (id,user_id,provider,provider_app_id,provider_user_id,union_id,union_scope,verified_at,created_at,last_login_at)
        VALUES (?,?,'PHONE',NULL,?,NULL,NULL,?,?,?)`).bind(crypto.randomUUID(), id, phoneE164, now, now, now),
    ]);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(error instanceof Error ? error.message : '')) throw new Response('该手机号已注册', { status: 409 });
    throw error;
  }
  const row = ensureActive(await userRow(db, id));
  return authResult(row, await createAuthSession(id, request));
}

export async function loginPhonePassword(input: Record<string, unknown>, request: Request) {
  const db = authDb();
  const phoneE164 = phone(input.phone);
  const identity = await findPhoneIdentity(db, phoneE164);
  const row = identity ? await userRow(db, identity.userId) : null;
  const passwordHash = row?.password_hash;
  if (!row || !passwordHash || !(await verifyPassword(text(input.password), passwordHash))) {
    throw new Response('账号或密码错误', { status: 401 });
  }
  ensureActive(row);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?').bind(now, now, row.id),
    db.prepare('UPDATE user_identities SET last_login_at=? WHERE id=?').bind(now, identity!.id),
  ]);
  return authResult(row, await createAuthSession(row.id, request));
}

export async function loginPhoneCode(input: Record<string, unknown>, request: Request, provider = smsProvider()) {
  const db = authDb();
  const phoneE164 = phone(input.phone);
  await provider.verifyCode({ db, phoneE164, purpose: 'LOGIN', code: code(input.code) });
  const identity = await findPhoneIdentity(db, phoneE164);
  const candidate = identity ? await userRow(db, identity.userId) : null;
  if (!candidate || text(candidate.status || 'ACTIVE') !== 'ACTIVE') throw new Response('手机号或验证码不正确', { status: 401 });
  const row = candidate;
  const now = new Date().toISOString();
  await db.prepare('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?').bind(now, now, row.id).run();
  if (identity) await touchIdentityLastLogin(db, identity.id, now);
  return authResult(row, await createAuthSession(row.id, request));
}

export async function resetPhonePassword(input: Record<string, unknown>, request: Request, provider = smsProvider()) {
  const db = authDb();
  const phoneE164 = phone(input.phone);
  const newPassword = text(input.newPassword);
  validateAccountPassword(newPassword);
  await provider.verifyCode({ db, phoneE164, purpose: 'RESET_PASSWORD', code: code(input.code) });
  const identity = await findPhoneIdentity(db, phoneE164);
  const candidate = identity ? await userRow(db, identity.userId) : null;
  if (!candidate || text(candidate.status || 'ACTIVE') !== 'ACTIVE') throw new Response('手机号或验证码不正确', { status: 401 });
  const row = candidate;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').bind(await hashPassword(newPassword), now, row.id),
    db.prepare('DELETE FROM user_sessions WHERE user_id=?').bind(row.id),
  ]);
  return authResult(row, await createAuthSession(row.id, request));
}

export async function bindPhone(user: AuthUser, input: Record<string, unknown>, provider = smsProvider()) {
  const db = authDb();
  const phoneE164 = phone(input.phone);
  if (await findPhoneIdentity(db, phoneE164)) throw new Response('PHONE_ALREADY_BOUND', { status: 409 });
  const current = await db.prepare("SELECT id FROM user_identities WHERE user_id=? AND provider='PHONE'").bind(user.id).first();
  if (current) throw new Response('当前账号已经绑定手机号', { status: 409 });
  await provider.verifyCode({ db, phoneE164, purpose: 'BIND_PHONE', code: code(input.code) });
  const now = new Date().toISOString();
  const password = text(input.password);
  if (password) validateAccountPassword(password);
  try {
    await db.batch([
      db.prepare(`INSERT INTO user_identities
        (id,user_id,provider,provider_app_id,provider_user_id,union_id,union_scope,verified_at,created_at,last_login_at)
        VALUES (?,?,'PHONE',NULL,?,NULL,NULL,?,?,NULL)`).bind(crypto.randomUUID(), user.id, phoneE164, now, now),
      password
        ? db.prepare('UPDATE users SET phone=?,phone_verified_at=?,password_hash=?,updated_at=? WHERE id=?').bind(phoneE164, now, await hashPassword(password), now, user.id)
        : db.prepare('UPDATE users SET phone=?,phone_verified_at=?,updated_at=? WHERE id=?').bind(phoneE164, now, now, user.id),
    ]);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(error instanceof Error ? error.message : '')) throw new Response('PHONE_ALREADY_BOUND', { status: 409 });
    throw error;
  }
  return { ok: true, phone: maskMainlandChinaPhone(phoneE164) };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (item) => item.toString(16).padStart(2, '0')).join('');
}

export async function verifyOldPhoneForChange(user: AuthUser, input: Record<string, unknown>, provider = smsProvider()) {
  const db = authDb();
  const identity = await db.prepare("SELECT id,provider_user_id FROM user_identities WHERE user_id=? AND provider='PHONE' LIMIT 1").bind(user.id).first<{ id: string; provider_user_id: string }>();
  if (!identity) throw new Response('当前账号尚未绑定手机号', { status: 400 });
  await provider.verifyCode({ db, phoneE164: identity.provider_user_id, purpose: 'CHANGE_PHONE', code: code(input.code) });
  const token = randomToken();
  const now = new Date();
  await db.prepare(`INSERT INTO phone_change_challenges
    (id,user_id,old_phone_e164,token_hash,expires_at,used_at,created_at)
    VALUES (?,?,?,?,?,NULL,?)`).bind(
      crypto.randomUUID(), user.id, identity.provider_user_id, await sha256(token), new Date(now.getTime() + 600_000).toISOString(), now.toISOString(),
    ).run();
  return { changeToken: token, expiresInSeconds: 600 };
}

export async function assertPhoneChangeToken(userId: string, token: string) {
  const row = await authDb().prepare(`SELECT id,old_phone_e164,expires_at,used_at FROM phone_change_challenges
    WHERE user_id=? AND token_hash=? LIMIT 1`).bind(userId, await sha256(token)).first<{ id: string; old_phone_e164: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) throw new Response('更换手机号验证已失效', { status: 400 });
  return row;
}

export async function confirmPhoneChange(user: AuthUser, input: Record<string, unknown>, provider = smsProvider()) {
  const db = authDb();
  const token = text(input.changeToken);
  const challenge = await assertPhoneChangeToken(user.id, token);
  const newPhone = phone(input.newPhone);
  if (newPhone === challenge.old_phone_e164) throw new Response('新手机号不能与原手机号相同', { status: 400 });
  if (await findPhoneIdentity(db, newPhone)) throw new Response('PHONE_ALREADY_BOUND', { status: 409 });
  await provider.verifyCode({ db, phoneE164: newPhone, purpose: 'CHANGE_PHONE', code: code(input.code) });
  const now = new Date().toISOString();
  try {
    const results = await db.batch([
      db.prepare("UPDATE user_identities SET provider_user_id=?,verified_at=? WHERE user_id=? AND provider='PHONE' AND provider_user_id=?").bind(newPhone, now, user.id, challenge.old_phone_e164),
      db.prepare('UPDATE users SET phone=?,phone_verified_at=?,updated_at=? WHERE id=?').bind(newPhone, now, now, user.id),
      db.prepare('UPDATE phone_change_challenges SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').bind(now, challenge.id, now),
    ]);
    if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) throw new Error('手机号更换未完整完成');
  } catch (error) {
    if (/UNIQUE|constraint/i.test(error instanceof Error ? error.message : '')) throw new Response('PHONE_ALREADY_BOUND', { status: 409 });
    throw error;
  }
  return { ok: true, phone: maskMainlandChinaPhone(newPhone) };
}
