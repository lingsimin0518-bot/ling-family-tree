import { authApiError } from '../../../../../lib/auth-api';
import { getSessionUser } from '../../../../../lib/auth';
import { authDb } from '../../../../../lib/auth';
import { normalizeMainlandChinaPhone } from '../../../../../lib/user-identity';
import { assertPhoneChangeToken, sendPhoneCode } from '../../../../../lib/phone-auth';
import { assertSmsPurpose } from '../../../../../lib/sms-provider';

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const purpose = assertSmsPurpose(body.purpose);
    if (purpose === 'BIND_PHONE' || purpose === 'CHANGE_PHONE') {
      const user = await getSessionUser(request);
      if (!user) throw new Response('请先登录', { status: 401 });
      if (purpose === 'CHANGE_PHONE' && typeof body.changeToken === 'string') {
        await assertPhoneChangeToken(user.id, body.changeToken);
      } else if (purpose === 'CHANGE_PHONE') {
        const identity = await authDb().prepare("SELECT provider_user_id FROM user_identities WHERE user_id=? AND provider='PHONE' LIMIT 1").bind(user.id).first<{ provider_user_id: string }>();
        const requestedPhone = typeof body.phone === 'string' ? body.phone : '';
        if (!identity || identity.provider_user_id !== normalizeMainlandChinaPhone(requestedPhone)) throw new Response('只能先验证当前绑定手机号', { status: 400 });
      }
    }
    const result = await sendPhoneCode({ request, phone: body.phone, purpose });
    return Response.json({ ok: true, cooldownSeconds: result.cooldownSeconds, expiresInSeconds: result.expiresInSeconds }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return authApiError(error);
  }
}
