import { requireSuperAdmin, authDb } from '../../../../../lib/auth';
import { assertControlledSmsTestAdministrator, controlledSmsTestStatus } from '../../../../../lib/controlled-sms-test';
import { controlledSmsTestConfig } from '../../../../../lib/controlled-sms-test-runtime';

export async function GET(request: Request) {
  try {
    assertControlledSmsTestAdministrator(await requireSuperAdmin(request));
    return Response.json(await controlledSmsTestStatus(authDb(), controlledSmsTestConfig()), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: await error.text() }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    return Response.json({ error: '短信联调状态暂时不可用' }, { status: 500 });
  }
}
