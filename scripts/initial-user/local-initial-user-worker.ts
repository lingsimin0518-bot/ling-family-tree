import { verifyPassword } from '../../lib/auth';
import { POST as ordinaryRegister } from '../../app/api/auth/register/route';
import { POST as phoneRegister } from '../../app/api/auth/register/phone/route';
import { BUSINESS_TABLES, BUSINESS_TABLE_DELETE_ORDER } from '../../lib/production-lifecycle';
import { handleInitialUserRegistration, INITIAL_USER_ORIGIN,
  INITIAL_USER_PATH, type InitialUserEnvironment } from '../../lib/initial-user-registration';

type TestEnv = InitialUserEnvironment & { DB: D1Database; LOCAL_INITIAL_USER_TEST_ONLY: string; LOCAL_TEST_PASSWORD: string };
let removedSchema: string[] = [];

// Local test fixture only: never an application route or deployment entrypoint.
const localInitialUserWorker = {
  async fetch(request: Request, env: TestEnv) {
    if (env.LOCAL_INITIAL_USER_TEST_ONLY !== 'true') return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === '/fixture/ready') return Response.json({ ready: true });
    if (path === '/api/auth/register') return ordinaryRegister(request);
    if (path === '/api/auth/register/phone') return phoneRegister(request);
    if (path === INITIAL_USER_PATH) {
      const settings = { ...env };
      const scenario = request.headers.get('x-local-test-scenario');
      if (scenario === 'disabled') settings.INITIAL_USER_REGISTRATION_ENABLED = 'false';
      if (scenario === 'missing-enabled') delete settings.INITIAL_USER_REGISTRATION_ENABLED;
      if (scenario === 'maintenance-off') settings.MAINTENANCE_MODE = 'false';
      if (scenario === 'wrong-environment') settings.APP_ENV = 'test';
      if (scenario === 'wrong-project') settings.INITIAL_USER_REGISTRATION_ALLOWED_PROJECT_ID = 'not-this-project';
      if (scenario === 'missing-secret') delete settings.INITIAL_USER_REGISTRATION_SECRET;
      if (scenario === 'weak-secret') settings.INITIAL_USER_REGISTRATION_SECRET = 'test-only-weak';
      if (scenario === 'reset-enabled') settings.PRODUCTION_RESET_ENABLED = 'true';
      if (scenario === 'old-reset-secret') settings.PRODUCTION_RESET_SECRET = 'local-only-old-reset-secret';
      const forwarded = new Request(INITIAL_USER_ORIGIN + path + new URL(request.url).search, request);
      forwarded.headers.set('host', request.headers.get('x-local-test-host') ?? new URL(INITIAL_USER_ORIGIN).host);
      return handleInitialUserRegistration(forwarded, settings);
    }
    if (path === '/fixture/state') {
      const schema = (await env.DB.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name").all<{ type: string; name: string; sql: string }>()).results;
      const present = BUSINESS_TABLES.filter((table) => schema.some((row) => row.type === 'table' && row.name === table));
      const results = await env.DB.batch<{ n: number }>(present.map((table) => env.DB.prepare(`SELECT COUNT(*) n FROM "${table}"`)));
      const counts = Object.fromEntries(present.map((table, index) => [table, results[index].results[0].n]));
      const users = (await env.DB.prepare('SELECT id,username,status,system_role,password_hash FROM users ORDER BY id').all<Record<string, unknown>>()).results;
      const safeUsers = await Promise.all(users.map(async (user) => ({ id: user.id, username: user.username,
        status: user.status, system_role: user.system_role,
        passwordMatches: typeof user.password_hash === 'string' && await verifyPassword(env.LOCAL_TEST_PASSWORD, user.password_hash),
        saltedHash: typeof user.password_hash === 'string' && user.password_hash.startsWith('pbkdf2_sha256$100000$') })));
      const migrations = (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results;
      const foreignKeys = (await env.DB.prepare('PRAGMA foreign_key_check').all()).results;
      return Response.json({ counts, users: safeUsers, schema, migrations, foreignKeys });
    }
    if (path === '/fixture/action' && request.method === 'POST') {
      const { action } = await request.json<{ action: string }>();
      if (action === 'clear') {
        await env.DB.batch(BUSINESS_TABLE_DELETE_ORDER.map((table) => env.DB.prepare(`DELETE FROM "${table}"`)));
      } else if (action === 'add-family') {
        await env.DB.prepare("INSERT INTO families(id,name,join_code,source_type,created_by,created_at) VALUES('local-family','Local','LOCAL123','DATABASE','local-creator','2026-01-01')").run();
      } else if (action === 'add-user') {
        await env.DB.prepare("INSERT INTO users(id,username,password_hash,email,status,system_role,created_at,updated_at) VALUES('existing-user','existing','fixture-hash','existing@example.test','ACTIVE','USER','2026-01-01','2026-01-01')").run();
      } else if (action === 'unknown-table') {
        await env.DB.prepare('CREATE TABLE unexpected_table(id TEXT)').run();
      } else if (action === 'remove-unknown') {
        await env.DB.prepare('DROP TABLE unexpected_table').run();
      } else if (action === 'old-schema') {
        await env.DB.prepare("DELETE FROM d1_migrations WHERE name='0010_security_s0_containment.sql'").run();
      } else if (action === 'restore-schema') {
        await env.DB.prepare("INSERT INTO d1_migrations(id,name) VALUES(11,'0010_security_s0_containment.sql')").run();
      } else if (action === 'missing-table') {
        removedSchema = (await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='phone_change_challenges' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all<{ sql: string }>()).results.map((row) => row.sql);
        await env.DB.prepare('DROP TABLE phone_change_challenges').run();
      } else if (action === 'restore-table') {
        await env.DB.batch(removedSchema.map((sql) => env.DB.prepare(sql)));
      } else if (action === 'fail-insert') {
        await env.DB.prepare("CREATE TRIGGER local_initial_failure AFTER INSERT ON users BEGIN SELECT RAISE(ABORT,'local insert failure'); END").run();
      } else if (action === 'ignore-insert') {
        await env.DB.prepare("CREATE TRIGGER local_initial_failure BEFORE INSERT ON users BEGIN SELECT RAISE(IGNORE); END").run();
      } else if (action === 'promote-insert') {
        await env.DB.prepare("CREATE TRIGGER local_initial_failure AFTER INSERT ON users BEGIN UPDATE users SET system_role='SUPER_ADMIN' WHERE id=NEW.id; END").run();
      } else if (action === 'family-insert') {
        await env.DB.prepare("CREATE TRIGGER local_initial_failure AFTER INSERT ON users BEGIN INSERT INTO families(id,name,join_code,source_type,created_by,created_at) VALUES('automatic-family','Local','AUTO1234','DATABASE',NEW.id,'2026-01-01'); END").run();
      } else if (action === 'remove-failure') {
        await env.DB.prepare('DROP TRIGGER local_initial_failure').run();
      } else return new Response(null, { status: 400 });
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  },
};
export default localInitialUserWorker;
