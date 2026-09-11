import { registerUser } from '../../../../lib/auth';

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string,unknown>;
    const result = await registerUser(body,request);
    return Response.json({user:result.user},{status:201,headers:{'Set-Cookie':result.cookie,'Cache-Control':'no-store'}});
  } catch (error) {
    if (error instanceof Response) return Response.json({error:await error.text()},{status:error.status});
    console.error(error);
    return Response.json({error:'注册失败，请稍后重试'},{status:500});
  }
}
