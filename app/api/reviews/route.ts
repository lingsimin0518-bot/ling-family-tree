import { ensureUser } from '../../../lib/family-store';
import { listReviews, reviewRequest, submitReview } from '../../../lib/collaboration-store';
import { apiError, text } from '../../../lib/api-response';

export async function GET(request: Request) { try { const user=await ensureUser(request); return Response.json(await listReviews(user.id,new URL(request.url).searchParams.get('family_id')??'')); } catch(error){ return apiError(error); } }
export async function POST(request: Request) { try { const user=await ensureUser(request); const body=await request.json() as Record<string,unknown>; if(body.action==='REVIEW') return Response.json(await reviewRequest(user.id,text(body.familyId),text(body.requestId),text(body.decision) as 'APPROVED'|'REJECTED',text(body.reason))); if(body.action==='SUBMIT_PERSON') return Response.json(await submitReview(user.id,text(body.familyId),text(body.requestType) as 'CREATE_PERSON'|'UPDATE_PERSON',body.targetId?text(body.targetId):null,body.oldData,body.newData,text(body.reason)),{status:201}); return Response.json({error:'不支持的操作'},{status:400}); } catch(error){ return apiError(error); } }
