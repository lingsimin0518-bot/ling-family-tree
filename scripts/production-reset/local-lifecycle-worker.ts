import {
  bootstrapSuperAdmin,
  BUSINESS_TABLES,
  LifecycleError,
  resetAllBusinessData,
} from '../../lib/production-lifecycle';

type TestEnv = {
  DB: D1Database;
  APP_ENV: string;
  PROJECT_ID: string;
  RESET_SECRET: string;
  RESET_BACKUP_SHA256: string;
  BOOTSTRAP_SECRET: string;
};

function reply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

const localLifecycleWorker = {
  async fetch(request: Request, env: TestEnv) {
    try {
      if (env.APP_ENV !== 'local-reset-test') return reply({ error: 'not found' }, 404);
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/test/health') return reply({ ready: 'local-lifecycle' });
      // Fixed local fixture inspection uses the same running D1 runtime as the
      // real core. Never start a second SQLite owner just to inspect its state.
      if (request.method === 'GET' && path === '/test/state') {
        const results = await env.DB.batch(BUSINESS_TABLES.map((table) => env.DB.prepare(`SELECT * FROM "${table}"`)));
        const rows = Object.fromEntries(BUSINESS_TABLES.map((table, index) => [table, results[index].results]));
        const counts = Object.fromEntries(BUSINESS_TABLES.map((table) => [table, rows[table].length]));
        const schema = (await env.DB.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name").all()).results;
        const migrations = (await env.DB.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results;
        const foreignKeys = (await env.DB.prepare('PRAGMA foreign_key_check').all()).results;
        return reply({ rows, counts, schema, migrations, foreignKeys });
      }
      if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405);
      const body = await request.json<Record<string, string>>();
      if (path === '/test/fail-delete') {
        await env.DB.prepare("CREATE TRIGGER local_fail_lifecycle BEFORE DELETE ON persons BEGIN SELECT RAISE(ABORT,'local DELETE failure'); END").run();
        return reply({ ok: true });
      }
      if (path === '/test/remove-failure') {
        await env.DB.prepare('DROP TRIGGER local_fail_lifecycle').run();
        return reply({ ok: true });
      }
      if (path === '/test/reset') {
        return reply(await resetAllBusinessData(env.DB, {
          environment: env.APP_ENV,
          expectedEnvironment: 'local-reset-test',
          projectId: env.PROJECT_ID,
          expectedProjectId: 'local-reset-fixture',
          operatorUserId: body.operatorUserId ?? '',
          confirmation: body.confirmation ?? '',
          secret: body.secret ?? '',
          expectedSecret: env.RESET_SECRET,
          verifiedBackupSha256: body.verifiedBackupSha256 ?? '',
          expectedBackupSha256: env.RESET_BACKUP_SHA256,
        }));
      }
      if (path === '/test/bootstrap') {
        return reply(await bootstrapSuperAdmin(env.DB, {
          targetUserId: body.targetUserId ?? '',
          confirmation: body.confirmation ?? '',
          secret: body.secret ?? '',
          expectedSecret: env.BOOTSTRAP_SECRET,
        }));
      }
      return reply({ error: 'not found' }, 404);
    } catch (error) {
      if (error instanceof LifecycleError) return reply({ error: error.message, code: error.code }, error.status);
      return reply({ error: 'local lifecycle test failed' }, 500);
    }
  },
};

export default localLifecycleWorker;
