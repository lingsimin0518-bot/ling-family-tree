import { env } from 'cloudflare:workers';

export const MAINTENANCE_ERROR_CODE = 'SERVICE_MAINTENANCE';

type MaintenanceEnvironment = {
  MAINTENANCE_MODE?: string;
};

function runtimeEnvironment() {
  return env as unknown as MaintenanceEnvironment;
}

export function isMaintenanceMode(
  settings: MaintenanceEnvironment = runtimeEnvironment(),
) {
  return (settings.MAINTENANCE_MODE ?? '').trim().toLowerCase() === 'true';
}

export function maintenanceResponse(
  settings: MaintenanceEnvironment = runtimeEnvironment(),
): Response | null {
  if (!isMaintenanceMode(settings)) return null;
  return Response.json(
    {
      error: '系统维护中，请稍后再试',
      code: MAINTENANCE_ERROR_CODE,
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'private, no-store',
        'Retry-After': '300',
      },
    },
  );
}
