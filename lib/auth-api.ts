import { SmsProviderError } from './sms-provider-shared';

export async function authApiError(error: unknown) {
  if (error instanceof SmsProviderError) {
    const messages = {
      SMS_TOO_FREQUENT: '验证码请求过于频繁，请稍后再试',
      SMS_PROVIDER_UNAVAILABLE: '短信服务暂时不可用，请稍后重试',
      SMS_CODE_INVALID: '验证码不正确',
      SMS_CODE_EXPIRED: '验证码已过期，请重新获取',
      SMS_ATTEMPTS_EXCEEDED: '验证码尝试次数已用完，请重新获取',
      SMS_PROVIDER_REJECTED: '短信发送未被服务商接受，请稍后重试',
    };
    const headers = error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : undefined;
    return Response.json({ error: messages[error.code], code: error.code, retryAfterSeconds: error.retryAfterSeconds }, { status: error.status, headers });
  }
  if (error instanceof Response) {
    const retryAfter = error.headers.get('Retry-After');
    return Response.json(
      { error: await error.text(), retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined },
      { status: error.status, headers: retryAfter ? { 'Retry-After': retryAfter } : undefined },
    );
  }
  if (error instanceof SyntaxError) return Response.json({ error: '请求内容格式不正确' }, { status: 400 });
  console.error(error);
  return Response.json({ error: '认证服务暂时不可用' }, { status: 500 });
}

export function authSuccess(result: { user: unknown; cookie: string }, status = 200) {
  return Response.json({ user: result.user }, {
    status,
    headers: { 'Set-Cookie': result.cookie, 'Cache-Control': 'private, no-store' },
  });
}
