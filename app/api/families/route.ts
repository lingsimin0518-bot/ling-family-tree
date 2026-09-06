import { addPerson, claimPerson, createFamily, deleteFamily, ensureUser, getFamilyTree, joinFamily, listFamilies, reviewClaim, setMemberRole } from '../../../lib/family-store';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function errorResponse(error: unknown) {
  if (error instanceof Response) return json({ error: await error.text() }, error.status);
  console.error(error);
  return json({ error: error instanceof Error ? error.message : '操作失败' }, 500);
}

export async function GET(request: Request) {
  try {
    const user = await ensureUser(request);
    const familyId = new URL(request.url).searchParams.get('family_id');
    if (familyId) return json(await getFamilyTree(user.id, familyId));
    return json({ user, families: await listFamilies(user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await ensureUser(request);
    const body = await request.json() as Record<string, unknown>;
    if (body.action === 'CREATE_FAMILY') {
      const name = String(body.name ?? '').trim();
      if (!name) return json({ error: '请填写族谱名称' }, 400);
      return json(await createFamily(user.id, name, String(body.description ?? '')), 201);
    }
    if (body.action === 'JOIN_FAMILY') return json(await joinFamily(user.id, String(body.code ?? '')));
    if (body.action === 'DELETE_FAMILY') return json(await deleteFamily(user.id, String(body.familyId ?? ''), String(body.confirmedName ?? '')));
    if (body.action === 'ADD_PERSON') return json(await addPerson(user.id, body as never), 201);
    if (body.action === 'CLAIM_PERSON') return json(await claimPerson(user.id, String(body.familyId ?? ''), String(body.personId ?? '')), 201);
    if (body.action === 'SET_MEMBER_ROLE') return json(await setMemberRole(user.id, String(body.familyId ?? ''), String(body.targetUserId ?? ''), String(body.role ?? '') as never));
    if (body.action === 'REVIEW_CLAIM') return json(await reviewClaim(user.id, String(body.familyId ?? ''), String(body.claimId ?? ''), String(body.decision ?? '') as never));
    return json({ error: '不支持的操作' }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
