import hosting from '../.openai/hosting.json';
import { prepareUserRegistration, userRegistrationInsert } from './auth';
import { constantTimeEqual } from './production-lifecycle';
import { inspectProductionSchema, PRODUCTION_BACKUP_TABLES_0010 } from './production-schema';

export const INITIAL_USER_ORIGIN = 'https://family-tree.lingsimin0518.chatgpt.site';
export const INITIAL_USER_PATH = '/api/admin/operations/initial-user';
export const INITIAL_USER_AVAILABILITY_HEADER = 'X-Initial-User-Availability-Check';
const GUARD_ID = 'initial-user-registration:atomic-guard:v1';
const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Initial-User-Deployment-Verification': 'UNAVAILABLE' };

export type InitialUserEnvironment = {
  DB?: D1Database;
  APP_ENV?: string;
  MAINTENANCE_MODE?: string;
  INITIAL_USER_REGISTRATION_ENABLED?: string;
  INITIAL_USER_REGISTRATION_SECRET?: string;
  INITIAL_USER_REGISTRATION_ALLOWED_PROJECT_ID?: string;
  PRODUCTION_RESET_ENABLED?: string;
  PRODUCTION_RESET_SECRET?: string;
};

class InitialUserError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function reject(status: number, code: string): never { throw new InitialUserError(status, code); }
function response(body: Record<string, unknown>, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}
export function initialUserMethodNotAllowed() {
  return response({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
}
function secretFormat(value: string) { return /^[a-f0-9]{64,128}$/.test(value) && value.length % 2 === 0; }

function checkConfiguration(settings: InitialUserEnvironment) {
  if (settings.INITIAL_USER_REGISTRATION_ENABLED !== 'true') reject(503, 'INITIAL_USER_REGISTRATION_DISABLED');
  if (settings.MAINTENANCE_MODE !== 'true') reject(503, 'MAINTENANCE_REQUIRED');
  if (settings.APP_ENV !== 'production' || !settings.DB || hosting.d1 !== 'DB'
    || settings.INITIAL_USER_REGISTRATION_ALLOWED_PROJECT_ID !== hosting.project_id) reject(409, 'INITIAL_USER_TARGET_MISMATCH');
  // This capability never arms Reset and must not overlap an armed Reset.
  if (settings.PRODUCTION_RESET_ENABLED !== 'false' || settings.PRODUCTION_RESET_SECRET) reject(503, 'INITIAL_USER_RESET_NOT_DISARMED');
  if (!secretFormat(settings.INITIAL_USER_REGISTRATION_SECRET ?? '')) reject(503, 'INITIAL_USER_SECRET_NOT_CONFIGURED');
  return settings.DB;
}

function checkOrigin(request: Request) {
  const url = new URL(request.url);
  const fetchSite = request.headers.get('sec-fetch-site');
  if (url.origin !== INITIAL_USER_ORIGIN || url.pathname !== INITIAL_USER_PATH
    || url.search || request.headers.get('host')?.toLowerCase() !== new URL(INITIAL_USER_ORIGIN).host
    || request.headers.get('origin') !== INITIAL_USER_ORIGIN
    || (fetchSite !== null && fetchSite !== 'same-origin')) reject(403, 'INITIAL_USER_ORIGIN_INVALID');
}

async function inspectEmptyDatabase(db: D1Database) {
  const inspection = await inspectProductionSchema(db);
  if (inspection.unknownTables.length) reject(409, 'INITIAL_USER_UNKNOWN_TABLES');
  if (inspection.businessTables.length !== 19 || !inspection.matchesExpected0010) reject(409, 'INITIAL_USER_SCHEMA_MISMATCH');
  const results = await db.batch<{ present: number }>(PRODUCTION_BACKUP_TABLES_0010.map((table) =>
    db.prepare(`SELECT EXISTS(SELECT 1 FROM "${table}") AS present`)));
  const populated = PRODUCTION_BACKUP_TABLES_0010.filter((_, index) => Number(results[index].results[0]?.present) !== 0);
  if (populated.includes('users')) reject(409, 'INITIAL_USER_ALREADY_EXISTS');
  if (populated.length) reject(409, 'INITIAL_USER_DATABASE_NOT_EMPTY');
}

async function readJsonObject(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, 'INITIAL_USER_REQUEST_INVALID');
  const reader = request.body?.getReader();
  if (!reader) reject(400, 'INITIAL_USER_REQUEST_INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); reject(413, 'INITIAL_USER_REQUEST_INVALID'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject(400, 'INITIAL_USER_REQUEST_INVALID'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'INITIAL_USER_REQUEST_INVALID');
  return input as Record<string, unknown>;
}

async function readAccount(request: Request) {
  const input = await readJsonObject(request);
  const keys = ['projectId', 'username', 'password', 'confirmPassword', 'email'];
  if (Object.keys(input).length !== keys.length || keys.some((key) => typeof input[key] !== 'string')) reject(400, 'INITIAL_USER_REQUEST_INVALID');
  const values = input as Record<string, string>;
  if (values.projectId !== hosting.project_id) reject(409, 'INITIAL_USER_TARGET_MISMATCH');
  // Preserve normal username/password registration's contact requirement.
  // No SMS/identity provider, email delivery, supplied user_id or role is accepted.
  return { username: values.username, password: values.password, confirmPassword: values.confirmPassword, email: values.email };
}

function errorResponse(error: unknown) {
  if (error instanceof InitialUserError) return response({ ok: false, code: error.code }, error.status);
  if (error instanceof Response && [400, 409].includes(error.status)) {
    return error.text().then((message) => response({ ok: false, code: 'INITIAL_USER_VALIDATION_FAILED', error: message }, error.status));
  }
  // Never log or return Request, credentials, D1 SQL/parameters or raw exceptions.
  return response({ ok: false, code: 'INITIAL_USER_CREATION_FAILED' }, 500);
}

async function initialUserAvailability(request: Request, db: D1Database) {
  if (request.headers.get(INITIAL_USER_AVAILABILITY_HEADER) !== 'v1'
    || request.headers.has('X-Initial-User-Registration-Secret')
    || Object.keys(await readJsonObject(request)).length !== 0) reject(400, 'INITIAL_USER_AVAILABILITY_INVALID');
  await inspectEmptyDatabase(db);
  // This private helper is reachable only after the shared environment/origin
  // gates. It discloses availability, never account data, counts or credentials.
  return response({ available: true, projectId: hosting.project_id, runtimeDeploymentVerification: 'UNAVAILABLE' });
}

export async function handleInitialUserRegistration(request: Request, settings: InitialUserEnvironment) {
  if (request.method !== 'POST') return initialUserMethodNotAllowed();
  try {
    const db = checkConfiguration(settings);
    checkOrigin(request);
    // Both branches share every deployment gate. An availability probe then
    // terminates here and can never reach account creation, even with a secret.
    if (request.headers.has(INITIAL_USER_AVAILABILITY_HEADER)) return await initialUserAvailability(request, db);
    const supplied = request.headers.get('x-initial-user-registration-secret') ?? '';
    if (!secretFormat(supplied) || !(await constantTimeEqual(supplied, settings.INITIAL_USER_REGISTRATION_SECRET!))) reject(403, 'INITIAL_USER_SECRET_INVALID');
    const input = await readAccount(request);
    await inspectEmptyDatabase(db);
    let account;
    try { account = await prepareUserRegistration(input, db); }
    catch (error) {
      if (error instanceof Response && error.status === 409) await inspectEmptyDatabase(db);
      throw error;
    }
    // All 19 emptiness conditions are rechecked inside the same real D1 batch
    // as the shared USER/ACTIVE insert. The NOT NULL guard aborts a lost race;
    // it is removed on success, so only one complete users row persists.
    const empty = PRODUCTION_BACKUP_TABLES_0010.map((table) => `NOT EXISTS(SELECT 1 FROM "${table}")`).join(' AND ');
    const noBusinessWrites = PRODUCTION_BACKUP_TABLES_0010.filter((table) => table !== 'users' && table !== 'action_idempotency')
      .map((table) => `NOT EXISTS(SELECT 1 FROM "${table}")`).join(' AND ');
    const guard = db.prepare(`INSERT INTO action_idempotency
      (id,actor_key,family_key,action_type,idempotency_key,status,created_at)
      VALUES(CASE WHEN ${empty} THEN ? ELSE NULL END,?,'','INITIAL_USER_REGISTRATION',?,'IN_PROGRESS',?)`)
      .bind(GUARD_ID, account.id, GUARD_ID, account.createdAt);
    try {
      await db.batch([
        guard,
        userRegistrationInsert(db, account),
        // A failed/ignored/altered insert must abort rather than commit a guard
        // or a user with incorrect account/security fields.
        db.prepare(`INSERT INTO action_idempotency
          (id,actor_key,family_key,action_type,idempotency_key,status,created_at)
          VALUES(CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM users
            WHERE id=? AND username=? AND password_hash=? AND status='ACTIVE' AND system_role='USER')
            AND (SELECT COUNT(*) FROM users)=1 AND (SELECT COUNT(*) FROM action_idempotency)=1
            AND ${noBusinessWrites}
            THEN ? ELSE NULL END,?,'','INITIAL_USER_REGISTRATION',?,'VERIFIED',?)`)
          .bind(account.id, account.username, account.passwordHash, `${GUARD_ID}:verified`, account.id, `${GUARD_ID}:verified`, account.createdAt),
        db.prepare('DELETE FROM action_idempotency WHERE id IN (?,?)').bind(GUARD_ID, `${GUARD_ID}:verified`),
      ]);
    } catch {
      // A concurrent winner is a conflict, never a second account or a session.
      await inspectEmptyDatabase(db);
      reject(500, 'INITIAL_USER_CREATION_FAILED');
    }
    return response({ ok: true, user: { id: account.id, username: account.username, system_role: 'USER', status: 'ACTIVE' } }, 201);
  } catch (error) { return errorResponse(error); }
}
