import { addPerson, addRelationship, claimPerson, createFamily, deleteFamily, ensureUser, getFamilyTree, getPersonDetail, joinFamily, listFamilies, reviewClaim, setMemberRole, updatePerson } from '../../../lib/family-store';
import { runCreation, type CreationAction } from '../../../lib/creation-cooldown';
import { maintenanceResponse } from '../../../lib/maintenance';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function toText(value: unknown) {
  // oxlint-disable-next-line typescript/no-base-to-string
  return String(value ?? '');
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
  const maintenance = maintenanceResponse();
  if (maintenance) return maintenance;
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
  const maintenance = maintenanceResponse();
  if (maintenance) return maintenance;
  try {
    const user = await ensureUser(request);
    const body = await request.json() as Record<string, unknown>;
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const guarded = async <T>(actionType: CreationAction, familyId: string | undefined, operation: () => Promise<T>) => {
      const outcome = await runCreation({ actorKey:`user:${user.id}`, userId:user.id, familyId, actionType, idempotencyKey, operation, targetId:(result) => toText((result as {id?:unknown}).id) || undefined });
      return outcome.result;
    };
    if (body.action === 'CREATE_FAMILY') {
      const name = toText(body.name).trim();
      if (!name) return json({ error: '请填写族谱名称' }, 400);
      return json(await guarded('CREATE_FAMILY', undefined, () => createFamily(user.id, name, toText(body.description))), 201);
    }
    if (body.action === 'JOIN_FAMILY') return json(await joinFamily(user.id, toText(body.code)));
    if (body.action === 'DELETE_FAMILY') return json(await deleteFamily(user.id, toText(body.familyId), toText(body.confirmedName)));
    if (body.action === 'ADD_PERSON') {
      const direction = toText(body.direction);
      const gender = toText(body.gender);
      const actionType: CreationAction = direction === 'PARENT'
        ? gender === '男' ? 'ADD_FATHER' : gender === '女' ? 'ADD_MOTHER' : 'ADD_PARENT'
        : direction === 'CHILD' ? 'ADD_CHILD'
        : direction === 'SPOUSE' ? 'ADD_SPOUSE'
        : 'CREATE_PERSON';
      return json(await guarded(actionType, toText(body.familyId), () => addPerson(user.id, body as never)), 201);
    }
    if (body.action === 'UPDATE_PERSON') return json(await updatePerson(user.id, toText(body.familyId), toText(body.personId), body as never));
    if (body.action === 'ADD_RELATIONSHIP') {
      const familyId = toText(body.familyId);
      const actionType: CreationAction = toText(body.type) === 'SPOUSE' ? 'ADD_SPOUSE' : 'ADD_PARENT';
      return json(await guarded(actionType, familyId, () => addRelationship(user.id, familyId, toText(body.fromPersonId), toText(body.toPersonId), toText(body.type) as never)), 201);
    }
    if (body.action === 'CLAIM_PERSON') {
      const familyId = toText(body.familyId);
      return json(await guarded('SUBMIT_CLAIM', familyId, () => claimPerson(user.id, familyId, toText(body.personId))), 201);
    }
    if (body.action === 'SET_MEMBER_ROLE') return json(await setMemberRole(user.id, toText(body.familyId), toText(body.targetUserId), toText(body.role) as never));
    if (body.action === 'REVIEW_CLAIM') return json(await reviewClaim(user.id, toText(body.familyId), toText(body.claimId), toText(body.decision) as never));
    return json({ error: '不支持的操作' }, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
