import { env } from 'cloudflare:workers';

const SESSION_COOKIE = 'ling_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  phone: string;
  nickname: string;
  avatar: string;
  status: string;
};

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('族谱数据库尚未绑定');
  return binding;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(byteLength)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256(value: string) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt, iterations:PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, iterationsText, saltText, expectedText] = storedHash.split('$');
  const iterations = Number(iterationsText);
  if (algorithm !== 'pbkdf2_sha256' || !Number.isSafeInteger(iterations) || iterations < 100_000 || !saltText || !expectedText) return false;
  try {
    const salt = base64ToBytes(saltText);
    const expected = base64ToBytes(expectedText);
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt, iterations }, key, expected.length * 8));
    if (actual.length !== expected.length) return false;
    let difference = 0;
    actual.forEach((byte, index) => { difference |= byte ^ expected[index]; });
    return difference === 0;
  } catch {
    return false;
  }
}

function parseCookies(request: Request) {
  const result = new Map<string,string>();
  for (const item of (request.headers.get('cookie') ?? '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) result.set(item.slice(0,index).trim(), decodeURIComponent(item.slice(index + 1).trim()));
  }
  return result;
}

function publicUser(row: Record<string, unknown>): AuthUser {
  return {
    id:String(row.id),
    username:String(row.username ?? ''),
    email:String(row.email ?? ''),
    phone:String(row.phone ?? ''),
    nickname:String(row.nickname ?? row.display_name ?? row.username ?? '族人'),
    avatar:String(row.avatar ?? ''),
    status:String(row.status ?? 'ACTIVE'),
  };
}

function normalizeEmail(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizePhone(value: unknown) {
  const source = String(value ?? '').trim();
  if (!source) return '';
  const prefix = source.startsWith('+') ? '+' : '';
  return prefix + source.replace(/\D/g, '');
}

function validateRegistration(input: Record<string,unknown>) {
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const confirmPassword = String(input.confirmPassword ?? '');
  const email = normalizeEmail(input.email);
  const rawPhone = String(input.phone ?? '').trim();
  const phone = normalizePhone(rawPhone);
  if (username.length < 1 || username.length > 32) throw new Response('用户名长度需要为1至32个字符', {status:400});
  if (!/^[\p{L}\p{N}_]+$/u.test(username)) throw new Response('用户名只能包含中文、字母、数字或下划线', {status:400});
  if (password.length < 8 || password.length > 128) throw new Response('密码长度需要为8至128个字符', {status:400});
  if (password !== confirmPassword) throw new Response('两次输入的密码不一致', {status:400});
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Response('邮箱格式不正确', {status:400});
  if (rawPhone && (!/^\+?[0-9][0-9\s()-]{5,24}$/.test(rawPhone) || !/^\+?\d{6,20}$/.test(phone))) throw new Response('手机号格式不正确', {status:400});
  if (!email && !phone) throw new Response('邮箱或手机号至少填写一种', {status:400});
  return {username,password,email,phone,nickname:username};
}

function registrationConflictMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/users\.username|idx_users_username_unique/i.test(message)) return '该用户名已被使用';
  if (/users\.email|idx_users_email_unique/i.test(message)) return '该邮箱已被注册';
  if (/users\.phone|idx_users_phone_unique/i.test(message)) return '该手机号已被注册';
  return '';
}

async function createSession(userId: string, request: Request) {
  const token = randomToken();
  const id = await sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db().batch([
    db().prepare('DELETE FROM user_sessions WHERE expires_at<=?').bind(now.toISOString()),
    db().prepare('INSERT INTO user_sessions (id,user_id,expires_at,created_at,last_seen_at,user_agent) VALUES (?,?,?,?,?,?)')
      .bind(id,userId,expiresAt,now.toISOString(),now.toISOString(),(request.headers.get('user-agent') ?? '').slice(0,255)),
  ]);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function registerUser(input: Record<string,unknown>, request: Request) {
  const values = validateRegistration(input);
  const binding = db();
  const usernameMatch = await binding.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').bind(values.username).first();
  if (usernameMatch) throw new Response('该用户名已被使用', {status:409});
  if (values.phone) {
    const phoneMatch = await binding.prepare('SELECT id FROM users WHERE phone=?').bind(values.phone).first();
    if (phoneMatch) throw new Response('该手机号已被注册', {status:409});
  }
  let existing: {id:string;password_hash?:string|null}|null = null;
  if (values.email) existing = await binding.prepare('SELECT id,password_hash FROM users WHERE email=? COLLATE NOCASE').bind(values.email).first<{id:string;password_hash?:string|null}>();
  if (existing?.password_hash) throw new Response('该邮箱已被注册', {status:409});
  const id = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(values.password);
  try {
    if (existing) {
      await binding.prepare('UPDATE users SET username=?,password_hash=?,email=?,phone=?,nickname=?,display_name=?,status=\'ACTIVE\',updated_at=? WHERE id=? AND password_hash IS NULL')
        .bind(values.username,passwordHash,values.email || null,values.phone || null,values.nickname,values.nickname,now,id).run();
    } else {
      await binding.prepare('INSERT INTO users (id,username,password_hash,email,phone,nickname,avatar,status,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'ACTIVE\',?,?,?)')
        .bind(id,values.username,passwordHash,values.email || null,values.phone || null,values.nickname,'',values.nickname,now,now).run();
    }
  } catch (error) {
    console.error('registration insert failed', error);
    const conflict = registrationConflictMessage(error);
    if (conflict) throw new Response(conflict, {status:409});
    throw new Response('账号创建失败，请稍后重试', {status:500});
  }
  const row = await binding.prepare('SELECT id,username,email,phone,nickname,avatar,status,display_name FROM users WHERE id=?').bind(id).first<Record<string,unknown>>();
  if (!row) throw new Error('注册完成后无法读取账号');
  return {user:publicUser(row),cookie:await createSession(id,request)};
}

export async function loginUser(input: Record<string,unknown>, request: Request) {
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  if (!username || !password) throw new Response('请输入用户名和密码', {status:400});
  const row = await db().prepare('SELECT id,username,password_hash,email,phone,nickname,avatar,status,display_name FROM users WHERE username=? COLLATE NOCASE')
    .bind(username).first<Record<string,unknown>>();
  if (!row || !row.password_hash || !(await verifyPassword(password,String(row.password_hash)))) throw new Response('用户名或密码不正确', {status:401});
  if (String(row.status ?? 'ACTIVE') !== 'ACTIVE') throw new Response('该账号当前不可登录，请联系管理员', {status:403});
  return {user:publicUser(row),cookie:await createSession(String(row.id),request)};
}

export async function getSessionUser(request: Request) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256(token);
  const now = new Date().toISOString();
  const row = await db().prepare(`SELECT u.id,u.username,u.email,u.phone,u.nickname,u.avatar,u.status,u.display_name
    FROM user_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.expires_at>? AND u.status='ACTIVE'`).bind(id,now).first<Record<string,unknown>>();
  if (!row) return null;
  await db().prepare('UPDATE user_sessions SET last_seen_at=? WHERE id=?').bind(now,id).run();
  return publicUser(row);
}

export async function requireUser(request: Request) {
  const user = await getSessionUser(request);
  if (!user) throw new Response('请先登录后使用族谱管理功能', {status:401});
  return user;
}

export async function logoutUser(request: Request) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) await db().prepare('DELETE FROM user_sessions WHERE id=?').bind(await sha256(token)).run();
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
