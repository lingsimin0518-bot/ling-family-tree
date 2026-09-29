import {
  bootstrapSuperAdmin,
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
      if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405);
      const body = await request.json<Record<string, string>>();
      const path = new URL(request.url).pathname;
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
