import { getSessionUser } from '../../../../lib/auth';

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user) return Response.json({error:'未登录'},{status:401,headers:{'Cache-Control':'no-store'}});
    return Response.json({user},{headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    console.error(error);
    return Response.json({error:'暂时无法读取登录状态'},{status:500,headers:{'Cache-Control':'no-store'}});
  }
}
