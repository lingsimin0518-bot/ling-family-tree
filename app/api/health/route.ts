import { isMaintenanceMode } from '../../../lib/maintenance';

export async function GET() {
  return Response.json(
    { status: isMaintenanceMode() ? 'maintenance' : 'operational' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
