import { authApiError, authSuccess } from '../../../../../lib/auth-api';
import { loginPhoneCode } from '../../../../../lib/phone-auth';
import { maintenanceResponse } from '../../../../../lib/maintenance';

export async function POST(request: Request) {
  const maintenance = maintenanceResponse();
  if (maintenance) return maintenance;
  try { return authSuccess(await loginPhoneCode(await request.json() as Record<string, unknown>, request)); }
  catch (error) { return authApiError(error); }
}
