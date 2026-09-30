import { env } from 'cloudflare:workers';
import { requireSuperAdmin } from '../../../../../lib/auth';
import { isMaintenanceMode } from '../../../../../lib/maintenance';
import { PRODUCTION_BACKUP_TABLES } from '../../../../../lib/production-backup';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  if (!isMaintenanceMode()) {
    return Response.json({ error: '页面不存在' }, { status: 404, headers: NO_STORE });
  }

  try {
    await requireSuperAdmin(request);
    const binding = (env as unknown as { DB?: D1Database }).DB;
    if (!binding) throw new Error('数据库未绑定');

    const result = await binding.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('d1_migrations', '_cf_KV', '_cf_METADATA')
      ORDER BY name`).all<{ name: string }>();
    const tables = result.results.map((row) => row.name);
    const expectedTables = [...PRODUCTION_BACKUP_TABLES].sort();
    const matchesExpected0006 = tables.length === expectedTables.length &&
      tables.every((table, index) => table === expectedTables[index]);

    const migrations = await binding.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'd1_migrations'`).first<{ name: string }>();
    const latestMigration = migrations
      ? await binding.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>()
      : null;
    const schemaVersion = latestMigration?.name?.match(/^(\d{4})/)?.[1] ?? '未记录';

    return Response.json({
      schemaVersion,
      tableCount: tables.length,
      tables,
      matchesExpected0006,
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Response) {
      return Response.json({ error: await error.text() }, { status: error.status, headers: NO_STORE });
    }
    console.error('maintenance overview unavailable');
    return Response.json({ error: '暂时无法读取数据库概况' }, { status: 500, headers: NO_STORE });
  }
}
