import { authApiError, authSuccess } from '../../../../../lib/auth-api';
import { registerPhoneUser } from '../../../../../lib/phone-auth';

export async function POST(request: Request) {
  try { return authSuccess(await registerPhoneUser(await request.json() as Record<string, unknown>, request), 201); }
  catch (error) { return authApiError(error); }
}
