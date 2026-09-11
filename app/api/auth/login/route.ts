import { loginUser } from '../../../../lib/auth';

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string,unknown>;
    const result = await loginUser(body,request);
    return Response.json({user:result.user},{headers:{'Set-Cookie':result.cookie,'Cache-Control':'no-store'}});
  } catch (error) {
    if (error instanceof Response) return Response.json({error:await error.text()},{status:error.status});
    console.error(error);
    return Response.json({error:'登录失败，请稍后重试'},{status:500});
  }
}
