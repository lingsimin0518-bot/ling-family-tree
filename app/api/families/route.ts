import { addPerson, addRelationship, claimPerson, createFamily, deleteFamily, ensureUser, getFamilyTree, getPersonDetail, joinFamily, listFamilies, reviewClaim, setMemberRole, updatePerson } from '../../../lib/family-store';
import { runCreation, type CreationAction } from '../../../lib/creation-cooldown';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

async function errorResponse(error: unknown) {
  if (error instanceof Response) {
    const retryAfter = error.headers.get('Retry-After');
    return Response.json({ error: await error.text(), retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined }, { status:error.status, headers:retryAfter?{'Retry-After':retryAfter}:undefined });
  }
  console.error(error);
  return json({ error: error instanceof Error ? error.message : '操作失败' }, 500);
}

export async function GET(request: Request) {
  try {
    const user = await ensureUser(request);
    const familyId = new URL(request.url).searchParams.get('family_id');
    const personId = new URL(request.url).searchParams.get('person_id');
    if (familyId && personId) return json(await getPersonDetail(user.id, familyId, personId));
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
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const guarded = async <T>(actionType: CreationAction, familyId: string | undefined, operation: () => Promise<T>) => {
      const outcome = await runCreation({ actorKey:`user:${user.id}`, userId:user.id, familyId, actionType, idempotencyKey, operation, targetId:(result) => String((result as {id?:unknown}).id ?? '') || undefined });
      return outcome.result;
    };
    if (body.action === 'CREATE_FAMILY') {
      const name = String(body.name ?? '').trim();
      if (!name) return json({ error: '请填写族谱名称' }, 400);
      return json(await guarded('CREATE_FAMILY', undefined, () => createFamily(user.id, name, String(body.description ?? ''))), 201);
    }
    if (body.action === 'JOIN_FAMILY') return json(await joinFamily(user.id, String(body.code ?? '')));
    if (body.action === 'DELETE_FAMILY') return json(await deleteFamily(user.id, String(body.familyId ?? ''), String(body.confirmedName ?? '')));
    if (body.action === 'ADD_PERSON') {
      const direction = String(body.direction ?? '');
      const gender = String(body.gender ?? '');
      const actionType: CreationAction = direction === 'PARENT'
        ? gender === '男' ? 'ADD_FATHER' : gender === '女' ? 'ADD_MOTHER' : 'ADD_PARENT'
        : direction === 'CHILD' ? 'ADD_CHILD'
        : direction === 'SPOUSE' ? 'ADD_SPOUSE'
        : 'CREATE_PERSON';
      return json(await guarded(actionType, String(body.familyId ?? ''), () => addPerson(user.id, body as never)), 201);
    }
    if (body.action === 'UPDATE_PERSON') return json(await updatePerson(user.id, String(body.familyId ?? ''), String(body.personId ?? ''), body as never));
    if (body.action === 'ADD_RELATIONSHIP') {
      const familyId = String(body.familyId ?? '');
      const actionType: CreationAction = String(body.type ?? '') === 'SPOUSE' ? 'ADD_SPOUSE' : 'ADD_PARENT';
      return json(await guarded(actionType, familyId, () => addRelationship(user.id, familyId, String(body.fromPersonId ?? ''), String(body.toPersonId ?? ''), String(body.type ?? '') as never)), 201);
    }
    if (body.action === 'CLAIM_PERSON') {
      const familyId = String(body.familyId ?? '');
      return json(await guarded('SUBMIT_CLAIM', familyId, () => claimPerson(user.id, familyId, String(body.personId ?? ''))), 201);
    }
    if (body.action === 'SET_MEMBER_ROLE') return json(await setMemberRole(user.id, String(body.familyId ?? ''), String(body.targetUserId ?? ''), String(body.role ?? '') as never));
    if (body.action === 'REVIEW_CLAIM') return json(await reviewClaim(user.id, String(body.familyId ?? ''), String(body.claimId ?? ''), String(body.decision ?? '') as never));
    return json({ error: '不支持的操作' }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
