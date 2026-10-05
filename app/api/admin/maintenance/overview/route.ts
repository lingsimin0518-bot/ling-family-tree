import { env } from 'cloudflare:workers';
import { requireSuperAdmin } from '../../../../../lib/auth';
import { isMaintenanceMode } from '../../../../../lib/maintenance';
import { inspectProductionSchema } from '../../../../../lib/production-schema';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  if (!isMaintenanceMode()) {
    return Response.json({ error: '页面不存在' }, { status: 404, headers: NO_STORE });
  }

  try {
    await requireSuperAdmin(request);
    const binding = (env as unknown as { DB?: D1Database }).DB;
    if (!binding) throw new Error('数据库未绑定');

    const inspection = await inspectProductionSchema(binding);

    return Response.json({
      schemaVersion: inspection.schemaVersion,
      schemaRecognitionMethod: inspection.schemaRecognitionMethod,
      tableCount: inspection.businessTables.length,
      tables: inspection.businessTables,
      platformTables: inspection.platformTables,
      unknownTables: inspection.unknownTables,
      missingTables: inspection.missingTables,
      matchesExpected0006: inspection.matchesExpected0006,
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Response) {
      return Response.json({ error: await error.text() }, { status: error.status, headers: NO_STORE });
    }
    console.error('maintenance overview unavailable');
    return Response.json({ error: '暂时无法读取数据库概况' }, { status: 500, headers: NO_STORE });
  }
}
