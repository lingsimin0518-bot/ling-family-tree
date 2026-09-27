import { authApiError, authSuccess } from '../../../../../lib/auth-api';
import { resetPhonePassword } from '../../../../../lib/phone-auth';

export async function POST(request: Request) {
  try { return authSuccess(await resetPhonePassword(await request.json() as Record<string, unknown>, request)); }
  catch (error) { return authApiError(error); }
}
