import hosting from '../.openai/hosting.json';
import type { AuthUser } from './auth';
import { constantTimeEqual, resetAllBusinessData } from './production-lifecycle';
import { inspectProductionSchema } from './production-schema';

// This temporary channel has no UI, no public configuration endpoint and no
// deployment-time side effect. Remove the route and this module after use.
export const RESET_ORIGIN = 'https://lingshi-family-tree.lingsimin0518.chatgpt.site';
export const RESET_PATH = '/api/admin/operations/production-reset';
const MAX_BODY_BYTES = 2048;
const MAX_ATTEMPTS = 3;
const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export type ResetChannelEnvironment = {
  DB?: D1Database;
  APP_ENV?: string;
  MAINTENANCE_MODE?: string;
  PRODUCTION_RESET_ENABLED?: string;
  PRODUCTION_RESET_SECRET?: string;
  PRODUCTION_RESET_ALLOWED_PROJECT_ID?: string;
  PRODUCTION_RESET_DATABASE_BINDING?: string;
  PRODUCTION_RESET_APPROVED_BACKUP_SHA256?: string;
  PRODUCTION_RESET_APPROVED_SITES_VERSION?: string;
  PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID?: string;
};

type TrustedDeployment = { sitesVersion: number; deploymentId: string };
type Dependencies = {
  requireSuperAdmin: (request: Request) => Promise<AuthUser>;
  // Only a trusted platform adapter may supply this. Configuration or request
  // headers are NOT evidence of the running Sites Version/Deployment.
  readTrustedDeployment?: () => Promise<TrustedDeployment | null>;
};

class ResetChannelError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function reject(status: number, code: string): never { throw new ResetChannelError(status, code); }

function validSecretFormat(value: string) {
  // Encodes 32-64 random bytes. Randomness must come from the operator's secure
  // generator; format validation cannot establish a configured value's entropy.
  return /^[a-f0-9]{64,128}$/.test(value) && value.length % 2 === 0;
}

function checkOrigin(request: Request) {
  const target = new URL(request.url);
  const host = new URL(RESET_ORIGIN).host;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (target.origin !== RESET_ORIGIN || target.pathname !== RESET_PATH || target.search
    || request.headers.get('origin') !== RESET_ORIGIN
    || request.headers.get('host')?.toLowerCase() !== host
    || (fetchSite !== null && fetchSite !== 'same-origin')) reject(403, 'RESET_ORIGIN_INVALID');
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    reject(415, 'RESET_REQUEST_INVALID');
  }
  const reader = request.body?.getReader();
  if (!reader) reject(400, 'RESET_REQUEST_INVALID');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        reject(413, 'RESET_REQUEST_INVALID');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'RESET_REQUEST_INVALID');
    const record = body as Record<string, unknown>;
    const fields = ['projectId', 'databaseBinding', 'schema', 'sitesVersion', 'deploymentId', 'backupSha256', 'confirmation'];
    if (Object.keys(record).length !== fields.length || fields.some((key) => !Object.hasOwn(record, key))) {
      reject(400, 'RESET_REQUEST_INVALID');
    }
    return record;
  } catch (error) {
    if (error instanceof ResetChannelError) throw error;
    reject(400, 'RESET_REQUEST_INVALID');
  } finally { reader.releaseLock(); }
}

async function operationId(projectId: string, version: number, deployment: string, backup: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify([projectId, '0010', version, deployment, backup]),
  ));
  return `production-reset:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function consumeAttempt(db: D1Database, id: string, operatorId: string) {
  // A global cap of three authenticated attempts is stricter than a per-IP or
  // per-session window, and survives Worker restarts/session changes. No TTL or
  // automatic cleanup: only a separately approved operator can reset failures.
  const result = await db.prepare(`INSERT INTO action_idempotency
    (id,actor_key,family_key,action_type,idempotency_key,status,response_json,created_at)
    SELECT ?,?,'','PRODUCTION_RESET_ATTEMPTS',?,'ATTEMPTS','1',?
    WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='ACTIVE' AND system_role='SUPER_ADMIN')
    ON CONFLICT(id) DO UPDATE SET response_json=CAST(CAST(response_json AS INTEGER)+1 AS TEXT)
    WHERE status='ATTEMPTS' AND response_json IN ('1','2')
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='ACTIVE' AND system_role='SUPER_ADMIN')`)
    .bind(`${id}:attempts`, operatorId, id, new Date().toISOString(), operatorId, operatorId).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    if (!(await db.prepare("SELECT id FROM users WHERE id=? AND status='ACTIVE' AND system_role='SUPER_ADMIN'")
      .bind(operatorId).first())) reject(401, 'UNAUTHORIZED');
    reject(429, 'RESET_ATTEMPTS_EXCEEDED');
  }
  const row = await db.prepare('SELECT response_json FROM action_idempotency WHERE id=?')
    .bind(`${id}:attempts`).first<{ response_json: string }>();
  if (!row || !/^[1-3]$/.test(row.response_json) || Number(row.response_json) > MAX_ATTEMPTS) {
    reject(429, 'RESET_ATTEMPTS_EXCEEDED');
  }
}

export async function handleProductionReset(request: Request, settings: ResetChannelEnvironment, dependencies: Dependencies) {
  const requestId = crypto.randomUUID();
  let operatorId: string | undefined;
  let deploymentVerification: 'VERIFIED' | 'UNAVAILABLE' = 'UNAVAILABLE';
  const respond = (body: Record<string, unknown>, status: number) => Response.json(body, {
    status, headers: { ...NO_STORE, 'X-Request-ID': requestId,
      'X-Reset-Deployment-Verification': deploymentVerification },
  });
  try {
    if (request.method !== 'POST') return respond({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
    if (settings.PRODUCTION_RESET_ENABLED !== 'true') reject(503, 'RESET_DISABLED');
    if (settings.MAINTENANCE_MODE !== 'true') reject(503, 'MAINTENANCE_REQUIRED');
    checkOrigin(request);
    const user = await dependencies.requireSuperAdmin(request);
    if (user.systemRole !== 'SUPER_ADMIN' || user.status !== 'ACTIVE') reject(403, 'FORBIDDEN');
    operatorId = user.id;
    const db = settings.DB;
    const projectId = settings.PRODUCTION_RESET_ALLOWED_PROJECT_ID;
    const version = Number(settings.PRODUCTION_RESET_APPROVED_SITES_VERSION);
    const deployment = settings.PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID;
    const approvedBackup = settings.PRODUCTION_RESET_APPROVED_BACKUP_SHA256?.toLowerCase();
    const expectedSecret = settings.PRODUCTION_RESET_SECRET ?? '';
    if (settings.APP_ENV !== 'production' || !db || projectId !== hosting.project_id
      || hosting.d1 !== 'DB' || settings.PRODUCTION_RESET_DATABASE_BINDING !== 'DB'
      || !Number.isSafeInteger(version) || version < 1 || !deployment || !/^appgdep_[a-zA-Z0-9]{16,64}$/.test(deployment)) {
      reject(409, 'PRODUCTION_TARGET_MISMATCH');
    }
    if (!validSecretFormat(expectedSecret)) reject(503, 'RESET_SECRET_INVALID');
    if (!approvedBackup || !/^[a-f0-9]{64}$/.test(approvedBackup)) reject(412, 'BACKUP_APPROVAL_MISMATCH');
    const id = await operationId(projectId, version, deployment, approvedBackup);
    const existing = await db.prepare('SELECT id FROM action_idempotency WHERE id=?').bind(id).first();
    if (existing) reject(409, 'RESET_ALREADY_EXECUTED');
    await consumeAttempt(db, id, operatorId);
    const suppliedSecret = request.headers.get('x-production-reset-secret') ?? '';
    if (!validSecretFormat(suppliedSecret) || !(await constantTimeEqual(suppliedSecret, expectedSecret))) {
      reject(403, 'RESET_SECRET_INVALID');
    }
    const body = await readBody(request);
    if (body.projectId !== projectId || body.databaseBinding !== 'DB'
      || body.sitesVersion !== version || body.deploymentId !== deployment) reject(409, 'PRODUCTION_TARGET_MISMATCH');
    if (body.schema !== '0010') reject(409, 'SCHEMA_MISMATCH');
    if (body.confirmation !== `RESET_ALL_BUSINESS_DATA:${projectId}`) reject(400, 'RESET_CONFIRMATION_INVALID');
    if (typeof body.backupSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.backupSha256)
      || !(await constantTimeEqual(body.backupSha256.toLowerCase(), approvedBackup))) reject(412, 'BACKUP_APPROVAL_MISMATCH');
    const runtimeDeployment = await dependencies.readTrustedDeployment?.();
    if (runtimeDeployment) {
      if (runtimeDeployment.sitesVersion !== version || runtimeDeployment.deploymentId !== deployment) {
        reject(409, 'PRODUCTION_TARGET_MISMATCH');
      }
      deploymentVerification = 'VERIFIED';
    }
    const inspection = await inspectProductionSchema(db);
    if (inspection.unknownTables.length) reject(409, 'UNKNOWN_TABLES_PRESENT');
    if (inspection.schemaVersion !== '0010' || !inspection.matchesExpected0010
      || inspection.businessTables.length !== 19) reject(409, 'SCHEMA_MISMATCH');
    if ((await db.prepare('PRAGMA foreign_key_check').all()).results.length) reject(409, 'RESET_PREFLIGHT_FAILED');
    const nonce = crypto.randomUUID();
    const claim = await db.prepare(`INSERT INTO action_idempotency
      (id,actor_key,family_key,action_type,idempotency_key,status,response_json,created_at)
      SELECT ?,?,'','PRODUCTION_RESET_OPERATION',?,'IN_PROGRESS',?,?
      WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='ACTIVE' AND system_role='SUPER_ADMIN')
      ON CONFLICT(id) DO NOTHING`)
      .bind(id, operatorId, id, nonce, new Date().toISOString(), operatorId).run();
    if (Number(claim.meta.changes ?? 0) !== 1) {
      if (!(await db.prepare("SELECT id FROM users WHERE id=? AND status='ACTIVE' AND system_role='SUPER_ADMIN'")
        .bind(operatorId).first())) reject(401, 'UNAUTHORIZED');
      reject(409, 'RESET_ALREADY_EXECUTED');
    }
    try {
      await resetAllBusinessData(db, {
        environment: settings.APP_ENV, expectedEnvironment: 'production',
        projectId, expectedProjectId: hosting.project_id, operatorUserId: operatorId,
        confirmation: `RESET_ALL_BUSINESS_DATA:${projectId}`,
        secret: suppliedSecret, expectedSecret, verifiedBackupSha256: body.backupSha256.toLowerCase(),
        expectedBackupSha256: approvedBackup, executionGuard: { id, nonce },
      });
    } catch {
      // Keep the failed operation locked. Never automatically retry DELETE.
      await db.prepare("UPDATE action_idempotency SET status='FAILED',completed_at=? WHERE id=? AND response_json=?")
        .bind(new Date().toISOString(), id, nonce).run().catch(() => undefined);
      reject(500, 'RESET_FAILED');
    }
    console.info(JSON.stringify({ event: 'production_reset', outcome: 'SUCCEEDED', requestId,
      operatorUserId: operatorId, schema: '0010', tablesCleared: 19, deploymentVerification }));
    return respond({ ok: true, reset: true, schema: '0010', tablesCleared: 19 }, 200);
  } catch (error) {
    const status = error instanceof ResetChannelError ? error.status
      : error instanceof Response && (error.status === 401 || error.status === 403) ? error.status : 500;
    const code = error instanceof ResetChannelError ? error.code
      : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'RESET_FAILED';
    console.info(JSON.stringify({ event: 'production_reset', outcome: 'REJECTED', requestId,
      operatorUserId: operatorId, code, deploymentVerification }));
    return respond({ ok: false, code }, status);
  }
}
