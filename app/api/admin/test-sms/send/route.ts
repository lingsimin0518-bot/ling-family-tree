import { requireSuperAdmin, authDb } from '../../../../../lib/auth';
import { assertControlledSmsTestAdministrator, sendControlledSmsTest } from '../../../../../lib/controlled-sms-test';
import { controlledSmsTestConfig } from '../../../../../lib/controlled-sms-test-runtime';
import { hashRequestIp } from '../../../../../lib/phone-auth';
import { smsProvider } from '../../../../../lib/sms-provider';
import { authApiError } from '../../../../../lib/auth-api';

export async function POST(request: Request) {
  try {
    assertControlledSmsTestAdministrator(await requireSuperAdmin(request));
    return Response.json(await sendControlledSmsTest({ db: authDb(), config: controlledSmsTestConfig(), provider: smsProvider(), requestedIpHash: await hashRequestIp(request) }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return authApiError(error); }
}
