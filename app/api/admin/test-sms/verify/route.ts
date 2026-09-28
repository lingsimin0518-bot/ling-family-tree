import { requireSuperAdmin, authDb } from '../../../../../lib/auth';
import { assertControlledSmsTestAdministrator, verifyControlledSmsTest } from '../../../../../lib/controlled-sms-test';
import { controlledSmsTestConfig } from '../../../../../lib/controlled-sms-test-runtime';
import { smsProvider } from '../../../../../lib/sms-provider';
import { authApiError } from '../../../../../lib/auth-api';

export async function POST(request: Request) {
  try {
    assertControlledSmsTestAdministrator(await requireSuperAdmin(request));
    const body = await request.json() as Record<string, unknown>;
    const extraKeys = Object.keys(body).filter((key) => key !== 'code');
    if (extraKeys.length) throw new Response('测试校验只接受验证码', { status: 400 });
    return Response.json(await verifyControlledSmsTest({ db: authDb(), config: controlledSmsTestConfig(), provider: smsProvider(), code: body.code }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return authApiError(error); }
}
