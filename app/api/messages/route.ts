import { ensureUser } from '../../../lib/family-store';
import { listMessages, markMessageRead } from '../../../lib/collaboration-store';
import { apiError, text } from '../../../lib/api-response';
import { maintenanceResponse } from '../../../lib/maintenance';

export async function GET(request: Request) { const maintenance=maintenanceResponse(); if(maintenance)return maintenance; try { const user=await ensureUser(request); return Response.json(await listMessages(user.id,new URL(request.url).searchParams.get('family_id')??'')); } catch(error){ return apiError(error); } }
export async function POST(request: Request) { const maintenance=maintenanceResponse(); if(maintenance)return maintenance; try { const user=await ensureUser(request); const body=await request.json() as Record<string,unknown>; return Response.json(await markMessageRead(user.id,text(body.familyId),text(body.messageId))); } catch(error){ return apiError(error); } }
