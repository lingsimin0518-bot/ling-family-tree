import { env } from 'cloudflare:workers';
import { handleInitialUserRegistration, initialUserMethodNotAllowed, type InitialUserEnvironment } from '../../../../../lib/initial-user-registration';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return await handleInitialUserRegistration(request, env as unknown as InitialUserEnvironment);
}
export const GET = initialUserMethodNotAllowed;
export const HEAD = initialUserMethodNotAllowed;
export const PUT = initialUserMethodNotAllowed;
export const PATCH = initialUserMethodNotAllowed;
export const DELETE = initialUserMethodNotAllowed;
export const OPTIONS = initialUserMethodNotAllowed;
