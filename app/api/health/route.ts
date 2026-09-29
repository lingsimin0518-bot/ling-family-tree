import { isMaintenanceMode } from '../../../lib/maintenance';

export function GET() {
  const maintenance = isMaintenanceMode();
  return Response.json(
    {
      ok: true,
      status: maintenance ? 'maintenance' : 'operational',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
