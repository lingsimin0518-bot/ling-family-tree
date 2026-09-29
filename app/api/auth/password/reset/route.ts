import { authApiError, authSuccess } from '../../../../../lib/auth-api';
import { resetPhonePassword } from '../../../../../lib/phone-auth';
import { maintenanceResponse } from '../../../../../lib/maintenance';

export async function POST(request: Request) {
  const maintenance = maintenanceResponse();
  if (maintenance) return maintenance;
  try { return authSuccess(await resetPhonePassword(await request.json() as Record<string, unknown>, request)); }
  catch (error) { return authApiError(error); }
}
