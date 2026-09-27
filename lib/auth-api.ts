export async function authApiError(error: unknown) {
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
