import { authApiError } from '../../../../../lib/auth-api';
import { requireUser } from '../../../../../lib/auth';
import { bindPhone } from '../../../../../lib/phone-auth';

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json(await bindPhone(user, await request.json() as Record<string, unknown>), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return authApiError(error); }
}
