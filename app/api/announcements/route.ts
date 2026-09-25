import { ensureUser } from '../../../lib/family-store';
import { createAnnouncement, deleteAnnouncement, listAnnouncements, updateAnnouncement } from '../../../lib/collaboration-store';
import { apiError, text } from '../../../lib/api-response';

export async function GET(request: Request) { try { const user=await ensureUser(request); return Response.json(await listAnnouncements(user.id,new URL(request.url).searchParams.get('family_id')??'')); } catch(error){ return apiError(error); } }
export async function POST(request: Request) { try { const user=await ensureUser(request); const body=await request.json() as Record<string,unknown>; return Response.json(await createAnnouncement(user.id,text(body.familyId),text(body.title),text(body.body)),{status:201}); } catch(error){ return apiError(error); } }
export async function PATCH(request: Request) { try { const user=await ensureUser(request); const body=await request.json() as Record<string,unknown>; return Response.json(await updateAnnouncement(user.id,text(body.familyId),text(body.id),text(body.title),text(body.body))); } catch(error){ return apiError(error); } }
export async function DELETE(request: Request) { try { const user=await ensureUser(request); const body=await request.json() as Record<string,unknown>; return Response.json(await deleteAnnouncement(user.id,text(body.familyId),text(body.id))); } catch(error){ return apiError(error); } }
