import { authApiError } from '../../../../../../lib/auth-api';
import { requireUser } from '../../../../../../lib/auth';
import { confirmPhoneChange } from '../../../../../../lib/phone-auth';
import { maintenanceResponse } from '../../../../../../lib/maintenance';

export async function POST(request: Request) {
  const maintenance = maintenanceResponse();
  if (maintenance) return maintenance;
  try {
    const user = await requireUser(request);
    return Response.json(await confirmPhoneChange(user, await request.json() as Record<string, unknown>), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return authApiError(error); }
}
