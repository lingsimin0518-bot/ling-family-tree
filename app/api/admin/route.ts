import { adminFamilies, adminLogs, adminOverview, adminUserDetail, adminUsers, updateUserStatus } from '../../../lib/admin-store';
import { maintenanceResponse } from '../../../lib/maintenance';

function json(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store'}})}
function toText(value:unknown){
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value??'');
}
async function failure(error:unknown){
  if(error instanceof Response)return json({error:await error.text()},error.status);
  console.error('admin api failed',error);
  return json({error:'系统后台暂时不可用'},500);
}

export async function GET(request:Request){
  try{
    const url=new URL(request.url);
    const view=url.searchParams.get('view')??'overview';
    if(view==='overview')return json(await adminOverview(request));
    if(view==='users')return json({users:await adminUsers(request)});
    if(view==='user')return json(await adminUserDetail(request,url.searchParams.get('id')??''));
    if(view==='families')return json({families:await adminFamilies(request)});
    if(view==='logs')return json({logs:await adminLogs(request)});
    return json({error:'不支持的后台查询'},400);
  }catch(error){return failure(error)}
}

export async function POST(request:Request){
  const maintenance=maintenanceResponse();
  if(maintenance)return maintenance;
  try{
    const body=await request.json() as Record<string,unknown>;
    const action=toText(body.action);
    if(!['DISABLE_USER','RESTORE_USER','FORCE_LOGOUT'].includes(action))return json({error:'不支持的后台操作'},400);
    return json(await updateUserStatus(request,toText(body.targetUserId),action as never,toText(body.reason)));
  }catch(error){return failure(error)}
}
