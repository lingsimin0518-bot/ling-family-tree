import { createStoredZipStream } from '../../../../../lib/backup-archive';
import {
  BackupLimitError,
  BackupSchemaMismatchError,
  createProductionBackup,
} from '../../../../../lib/production-backup';
import { requireSuperAdmin } from '../../../../../lib/auth';

function backupFilename(date = new Date()) {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, 'Z');
  return `production-schema-0006-${stamp}.zip`;
}

function failure(message: string, status: number) {
  return Response.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    const backup = await createProductionBackup();
    const stream = createStoredZipStream(backup.files);
    return new Response(stream, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${backupFilename()}"`,
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      return failure(await error.text(), error.status);
    }
    if (error instanceof BackupLimitError) return failure(error.message, 413);
    if (error instanceof BackupSchemaMismatchError) return failure(error.message, 409);
    // Do not log row contents or the original error object: it can contain sensitive data.
    console.error('production backup export failed');
    return failure('生产备份生成失败，未返回不完整文件', 500);
  }
}
