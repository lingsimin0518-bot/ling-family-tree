import { requireSuperAdmin } from '../../lib/auth';
import { BUSINESS_TABLES } from '../../lib/production-lifecycle';
import { handleProductionReset, RESET_ORIGIN, RESET_PATH, type ResetChannelEnvironment } from '../../lib/production-reset-channel';
import { GET } from '../../app/api/admin/operations/production-reset/route';

// Only the local test harness bundles this file. It is not an app route and is
// not part of dist. The fixture actions below never accept SQL from a caller.
type TestEnvironment = ResetChannelEnvironment & {
  DB: D1Database;
  LOCAL_RESET_CHANNEL_TEST_ONLY: string;
};

const worker = {
  async fetch(request: Request, env: TestEnvironment) {
    if (env.LOCAL_RESET_CHANNEL_TEST_ONLY !== 'true') return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === RESET_PATH) {
      if (request.method === 'GET') return GET();
      const scenario = request.headers.get('x-local-test-scenario');
      const settings = { ...env };
      if (scenario === 'maintenance-off') settings.MAINTENANCE_MODE = 'false';
      if (scenario === 'disabled') settings.PRODUCTION_RESET_ENABLED = 'false';
      if (scenario === 'wrong-environment') settings.APP_ENV = 'test';
      if (scenario === 'missing-secret') settings.PRODUCTION_RESET_SECRET = '';
      if (scenario === 'weak-secret') settings.PRODUCTION_RESET_SECRET = 'test-only-weak';
      if (scenario === 'wrong-config-project') settings.PRODUCTION_RESET_ALLOWED_PROJECT_ID = 'wrong-project';
      if (scenario === 'wrong-config-binding') settings.PRODUCTION_RESET_DATABASE_BINDING = 'OTHER';
      // Simulate the HTTPS transport envelope without connecting to that URL.
      const target = new Request(RESET_ORIGIN + RESET_PATH + new URL(request.url).search, request);
      target.headers.set('host', request.headers.get('x-local-test-host') ?? new URL(RESET_ORIGIN).host);
      const readTrustedDeployment = scenario === 'trusted-match' || scenario === 'trusted-mismatch'
        ? async () => ({ sitesVersion: scenario === 'trusted-match' ? 41 : 42,
          deploymentId: env.PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID! }) : undefined;
      return handleProductionReset(target, settings, { requireSuperAdmin, readTrustedDeployment });
    }
    if (path === '/fixture/state') {
      const results = await env.DB.batch<{ n: number }>(BUSINESS_TABLES.map((table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`)));
      const counts = Object.fromEntries(BUSINESS_TABLES.map((table, index) => [table, results[index].results[0].n]));
      const schema = (await env.DB.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name").all()).results;
      const foreignKeyErrors = (await env.DB.prepare('PRAGMA foreign_key_check').all()).results.length;
      const locks = (await env.DB.prepare("SELECT status FROM action_idempotency WHERE action_type='PRODUCTION_RESET_OPERATION'").all()).results;
      const migrations = (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results;
      return Response.json({ counts, schema, foreignKeyErrors, locks, migrations });
    }
    if (path === '/fixture/action' && request.method === 'POST') {
      const { action } = await request.json<{ action: string }>();
      if (action === 'clear-operation-state') {
        await env.DB.prepare("DELETE FROM action_idempotency WHERE action_type IN ('PRODUCTION_RESET_ATTEMPTS','PRODUCTION_RESET_OPERATION','PRODUCTION_RESET_ATOMIC_GUARD')").run();
      } else if (action === 'unknown-table') {
        await env.DB.prepare('CREATE TABLE unexpected_table(id TEXT)').run();
      } else if (action === 'remove-unknown-table') {
        await env.DB.prepare('DROP TABLE unexpected_table').run();
      } else if (action === 'old-schema') {
        await env.DB.prepare("DELETE FROM d1_migrations WHERE name='0010_security_s0_containment.sql'").run();
      } else if (action === 'restore-schema') {
        await env.DB.prepare("INSERT INTO d1_migrations(id,name) VALUES(11,'0010_security_s0_containment.sql')").run();
      } else if (action === 'fail-delete') {
        await env.DB.prepare("CREATE TRIGGER local_fail_reset BEFORE DELETE ON persons BEGIN SELECT RAISE(ABORT,'local simulated DELETE failure'); END").run();
      } else if (action === 'remove-failure') {
        await env.DB.prepare('DROP TRIGGER local_fail_reset').run();
      } else if (action === 'disable-super') {
        await env.DB.prepare("UPDATE users SET status='DISABLED' WHERE id='u-super'").run();
      } else if (action === 'restore-super') {
        await env.DB.prepare("UPDATE users SET status='ACTIVE' WHERE id='u-super'").run();
      } else if (action === 'expire-super-session') {
        await env.DB.prepare("UPDATE user_sessions SET expires_at='2020-01-01T00:00:00.000Z' WHERE user_id='u-super'").run();
      } else if (action === 'restore-super-session') {
        await env.DB.prepare("UPDATE user_sessions SET expires_at='2099-01-01T00:00:00.000Z' WHERE user_id='u-super'").run();
      } else return new Response(null, { status: 400 });
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  },
};
export default worker;
