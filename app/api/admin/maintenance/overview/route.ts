import { env } from 'cloudflare:workers';
import { requireSuperAdmin } from '../../../../../lib/auth';
import { isMaintenanceMode } from '../../../../../lib/maintenance';
import { inspectProductionSchema } from '../../../../../lib/production-schema';
import hosting from '../../../../../.openai/hosting.json';

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
    const resetSettings = env as unknown as {
      PRODUCTION_RESET_ENABLED?: string;
      PRODUCTION_RESET_SECRET?: string;
      PRODUCTION_RESET_ALLOWED_PROJECT_ID?: string;
      PRODUCTION_RESET_DATABASE_BINDING?: string;
      PRODUCTION_RESET_APPROVED_BACKUP_SHA256?: string;
      PRODUCTION_RESET_APPROVED_SITES_VERSION?: string;
      PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID?: string;
    };
    const resetEnabled = resetSettings.PRODUCTION_RESET_ENABLED === 'true';
    const resetSecretConfigured = Boolean(resetSettings.PRODUCTION_RESET_SECRET);
    const approvedVersion = Number(resetSettings.PRODUCTION_RESET_APPROVED_SITES_VERSION);
    const approvedBackup = resetSettings.PRODUCTION_RESET_APPROVED_BACKUP_SHA256 ?? '';
    const approvedDeployment = resetSettings.PRODUCTION_RESET_APPROVED_DEPLOYMENT_ID ?? '';
    const resetTarget = resetEnabled && resetSecretConfigured && inspection.matchesExpected0010
      && inspection.businessTables.length === 19 && inspection.unknownTables.length === 0
      && resetSettings.PRODUCTION_RESET_ALLOWED_PROJECT_ID === hosting.project_id
      && hosting.d1 === 'DB' && resetSettings.PRODUCTION_RESET_DATABASE_BINDING === 'DB'
      && Number.isSafeInteger(approvedVersion) && approvedVersion > 0
      && /^[a-f0-9]{64}$/i.test(approvedBackup)
      && /^appgdep_[a-zA-Z0-9]{16,64}$/.test(approvedDeployment)
      ? {
        projectId: resetSettings.PRODUCTION_RESET_ALLOWED_PROJECT_ID,
        databaseBinding: 'DB' as const,
        schema: '0010' as const,
        sitesVersion: approvedVersion,
        deploymentId: approvedDeployment,
        backupSha256: approvedBackup,
      } : null;

    return Response.json({
      maintenanceMode: true,
      productionResetEnabled: resetEnabled,
      resetSecretConfigured,
      resetTarget,
      runtimeDeploymentVerification: 'UNAVAILABLE',
      schemaVersion: inspection.schemaVersion,
      schemaRecognitionMethod: inspection.schemaRecognitionMethod,
      profileVersion: inspection.profileVersion,
      tableCount: inspection.businessTables.length,
      tables: inspection.businessTables,
      platformTables: inspection.platformTables,
      unknownTables: inspection.unknownTables,
      missingTables: inspection.missingTables,
      matchesExpected0006: inspection.matchesExpected0006,
      matchesExpected0010: inspection.matchesExpected0010,
      matchesExpectedBackup: inspection.matchesExpectedBackup,
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Response) {
      return Response.json({ error: await error.text() }, { status: error.status, headers: NO_STORE });
    }
    console.error('maintenance overview unavailable');
    return Response.json({ error: '暂时无法读取数据库概况' }, { status: 500, headers: NO_STORE });
  }
}
