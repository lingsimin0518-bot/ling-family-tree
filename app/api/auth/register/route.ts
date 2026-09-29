import { registerUser } from '../../../../lib/auth';
import { registrationActor, runCreation } from '../../../../lib/creation-cooldown';
import { maintenanceResponse } from '../../../../lib/maintenance';

export async function POST(request: Request) {
  const maintenance = maintenanceResponse();
  if (maintenance) return maintenance;
  try {
    const body = await request.json() as Record<string,unknown>;
    const guarded = await runCreation({
      actorKey: registrationActor(request),
      actionType: 'REGISTER_ACCOUNT',
      operation: () => registerUser(body,request),
      targetId: result => result.user.id,
    });
    const result = guarded.result;
    return Response.json({user:result.user},{status:201,headers:{'Set-Cookie':result.cookie,'Cache-Control':'no-store'}});
  } catch (error) {
    if (error instanceof Response) {
      const retryAfter = error.headers.get('Retry-After');
      return Response.json({error:await error.text(),retryAfterSeconds:retryAfter ? Number(retryAfter) : undefined},{status:error.status,headers:retryAfter?{'Retry-After':retryAfter}:undefined});
    }
    if (error instanceof SyntaxError) return Response.json({error:'注册信息格式不正确'},{status:400});
    console.error(error);
    return Response.json({error:'账号创建失败，请稍后重试'},{status:500});
  }
}
