import { authApiError, authSuccess } from '../../../../../lib/auth-api';
import { loginPhoneCode } from '../../../../../lib/phone-auth';

export async function POST(request: Request) {
  try { return authSuccess(await loginPhoneCode(await request.json() as Record<string, unknown>, request)); }
  catch (error) { return authApiError(error); }
}
