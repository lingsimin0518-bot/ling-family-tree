import { env } from 'cloudflare:workers';
import { calculateGenerations, type FamilyRelationship } from './generation-model';
import { requireUser } from './auth';

export const LEGACY_FAMILY_ID = 'family-lingshi-existing';
export type FamilyRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
const editRoles = new Set<FamilyRole>(['OWNER', 'ADMIN', 'EDITOR']);
const adminRoles = new Set<FamilyRole>(['OWNER', 'ADMIN']);

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('族谱数据库尚未绑定');
  return binding;
}

export async function ensureUser(request: Request) {
  // Authentication must not mutate family ownership. Legacy-family bootstrap is
  // handled only by an explicit, audited migration outside ordinary requests.
  return requireUser(request);
}

export async function membership(userId: string, familyId: string) {
  const row = await db().prepare('SELECT role FROM family_users WHERE user_id=? AND family_id=?').bind(userId, familyId).first<{ role: FamilyRole }>();
  if (!row) throw new Response('你尚未加入这本族谱', { status: 403 });
  return row.role;
}

export async function listFamilies(userId: string) {
  const result = await db().prepare(`SELECT f.id,f.name,f.description,
    CASE WHEN fu.role IN ('OWNER','ADMIN') AND f.source_type='DATABASE' THEN f.join_code ELSE NULL END join_code,
    f.source_type,fu.role,fu.joined_at
    FROM families f JOIN family_users fu ON fu.family_id=f.id
    WHERE fu.user_id=? ORDER BY fu.joined_at`).bind(userId).all();
  return result.results;
}

export async function createFamily(userId: string, name: string, description = '') {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const joinCode = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  await db().batch([
    db().prepare("INSERT INTO families (id,name,description,join_code,source_type,created_by,created_at) VALUES (?,?,?,?,?,?,?)").bind(id, name, description, joinCode, 'DATABASE', userId, now),
    db().prepare('INSERT INTO family_users (user_id,family_id,role,joined_at) VALUES (?,?,?,?)').bind(userId, id, 'OWNER', now),
  ]);
  return { id, name, description, join_code: joinCode, source_type: 'DATABASE', role: 'OWNER' };
}

export async function joinFamily(userId: string, code: string) {
  const family = await db().prepare("SELECT id,name FROM families WHERE join_code=? AND source_type='DATABASE'").bind(code.trim().toUpperCase()).first<{ id: string; name: string }>();
  if (!family) throw new Response('未找到对应族谱，请检查加入码', { status: 404 });
  await db().prepare("INSERT OR IGNORE INTO family_users (user_id,family_id,role,joined_at) VALUES (?,?, 'VIEWER', ?)").bind(userId, family.id, new Date().toISOString()).run();
  return family;
}

export async function deleteFamily(userId: string, familyId: string, confirmedName: string) {
  if (familyId === LEGACY_FAMILY_ID) throw new Response('原有凌氏家谱属于系统保留族谱，不能删除', { status: 400 });
  const role = await membership(userId, familyId);
  if (role !== 'OWNER') throw new Response('只有族谱创建者可以删除整本族谱', { status: 403 });
  const family = await db().prepare('SELECT id,name FROM families WHERE id=?').bind(familyId).first<{ id:string; name:string }>();
  if (!family) throw new Response('族谱不存在', { status: 404 });
  if (confirmedName !== family.name) throw new Response('输入的族谱名称不一致，已取消删除', { status: 400 });
  await db().prepare("DELETE FROM families WHERE id=? AND name=? AND source_type='DATABASE'").bind(familyId, confirmedName).run();
  const remaining = await db().prepare('SELECT id FROM families WHERE id=?').bind(familyId).first();
  if (remaining) throw new Response('族谱未被删除', { status: 409 });
  return { id: familyId, deleted: true };
}

export async function getFamilyTree(userId: string, familyId: string) {
  const role = await membership(userId, familyId);
  const binding = db();
  const canReview = role === 'OWNER' || role === 'ADMIN';
  const familySql = canReview
    ? "SELECT id,name,description,CASE WHEN source_type='DATABASE' THEN join_code ELSE NULL END join_code,source_type FROM families WHERE id=?"
    : 'SELECT id,name,description,NULL join_code,source_type FROM families WHERE id=?';
  const [family, people, relationships, generations, announcements, media, claims, members] = await Promise.all([
    binding.prepare(familySql).bind(familyId).first(),
    binding.prepare('SELECT * FROM persons WHERE family_id=? ORDER BY generation,birth_year,name').bind(familyId).all(),
    binding.prepare('SELECT * FROM relationships WHERE family_id=?').bind(familyId).all(),
    binding.prepare('SELECT * FROM generations WHERE family_id=? ORDER BY number').bind(familyId).all(),
    binding.prepare('SELECT * FROM announcements WHERE family_id=? ORDER BY created_at DESC').bind(familyId).all(),
    binding.prepare('SELECT * FROM media WHERE family_id=?').bind(familyId).all(),
    canReview
      ? binding.prepare('SELECT pc.*,p.name person_name,COALESCE(u.nickname,u.display_name,u.username) user_name FROM person_claims pc JOIN persons p ON p.id=pc.person_id AND p.family_id=pc.family_id JOIN users u ON u.id=pc.user_id WHERE pc.family_id=? ORDER BY pc.created_at DESC').bind(familyId).all()
      : binding.prepare('SELECT * FROM person_claims WHERE family_id=? AND user_id=?').bind(familyId, userId).all(),
    canReview
      ? binding.prepare('SELECT fu.user_id,fu.role,fu.joined_at,COALESCE(u.nickname,u.display_name,u.username) display_name,u.email FROM family_users fu JOIN users u ON u.id=fu.user_id WHERE fu.family_id=? ORDER BY fu.joined_at').bind(familyId).all()
      : Promise.resolve({ results: [] }),
  ]);
  return { family, role, currentUserId: userId, people: people.results, relationships: relationships.results, generations: generations.results, announcements: announcements.results, media: media.results, claims: claims.results, members: members.results };
}

export async function getPersonDetail(userId: string, familyId: string, personId: string) {
  const role = await membership(userId, familyId);
  const binding = db();
  const person = await binding.prepare('SELECT * FROM persons WHERE id=? AND family_id=?').bind(personId, familyId).first<Record<string, unknown>>();
  if (!person) throw new Response('未找到当前族谱中的人物', { status: 404 });
  const [relations, media] = await Promise.all([
    binding.prepare('SELECT * FROM relationships WHERE family_id=? AND (from_person_id=? OR to_person_id=?)').bind(familyId, personId, personId).all(),
    binding.prepare('SELECT * FROM media WHERE family_id=? AND person_id=? ORDER BY created_at DESC').bind(familyId, personId).all(),
  ]);
  const relationRows = relations.results as Array<{ from_person_id:string; to_person_id:string; type:string }>;
  const relatedIds = [...new Set(relationRows.flatMap((item) => [item.from_person_id, item.to_person_id]).filter((id) => id !== personId))];
  const related = relatedIds.length
    ? await binding.prepare(`SELECT id,name,gender,generation,birth_year FROM persons WHERE family_id=? AND id IN (${relatedIds.map(() => '?').join(',')})`).bind(familyId, ...relatedIds).all()
    : { results: [] };
  return { person, role, relationships: relationRows, relatedPeople: related.results, media: media.results };
}

async function requirePersonWrite(userId: string, familyId: string, personId: string) {
  const role = await membership(userId, familyId);
  const person = await db().prepare('SELECT id,created_by_user_id FROM persons WHERE id=? AND family_id=?').bind(personId, familyId).first<{id:string;created_by_user_id:string|null}>();
  if (!person) throw new Response('人物不属于当前族谱', { status: 404 });
  if (!adminRoles.has(role) && !(role === 'EDITOR' && person.created_by_user_id === userId)) {
    throw new Response('你只能修改自己录入的人物资料', { status: 403 });
  }
  return { role, person };
}

async function wouldCreateAncestorCycle(familyId: string, parentId: string, childId: string) {
  const rows = await db().prepare("SELECT from_person_id,to_person_id FROM relationships WHERE family_id=? AND type='PARENT'").bind(familyId).all<{from_person_id:string;to_person_id:string}>();
  const children = new Map<string, string[]>();
  rows.results.forEach((item) => children.set(item.from_person_id, [...(children.get(item.from_person_id) ?? []), item.to_person_id]));
  const queue = [childId];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === parentId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(children.get(current) ?? []));
  }
  return false;
}

async function validateRelationship(familyId: string, fromId: string, toId: string, type: 'PARENT'|'SPOUSE') {
  if (fromId === toId) throw new Response('不能与自己建立父母、祖先或配偶关系', { status: 400 });
  const people = await db().prepare('SELECT id FROM persons WHERE family_id=? AND id IN (?,?)').bind(familyId, fromId, toId).all();
  if (people.results.length !== 2) throw new Response('关系双方必须属于当前族谱', { status: 400 });
  const duplicate = type === 'SPOUSE'
    ? await db().prepare("SELECT id FROM relationships WHERE family_id=? AND type='SPOUSE' AND ((from_person_id=? AND to_person_id=?) OR (from_person_id=? AND to_person_id=?)) LIMIT 1").bind(familyId, fromId, toId, toId, fromId).first()
    : await db().prepare("SELECT id FROM relationships WHERE family_id=? AND type='PARENT' AND from_person_id=? AND to_person_id=? LIMIT 1").bind(familyId, fromId, toId).first();
  if (duplicate) throw new Response('这条亲属关系已经存在', { status: 409 });
  if (type === 'PARENT' && await wouldCreateAncestorCycle(familyId, fromId, toId)) throw new Response('该关系会形成祖先循环，不能保存', { status: 409 });
}

async function recalculate(familyId: string) {
  const binding = db();
  const [peopleResult, relationshipResult] = await Promise.all([
    binding.prepare('SELECT id FROM persons WHERE family_id=?').bind(familyId).all<{ id: string }>(),
    binding.prepare('SELECT from_person_id,to_person_id,type FROM relationships WHERE family_id=?').bind(familyId).all<FamilyRelationship>(),
  ]);
  const calculated = calculateGenerations(peopleResult.results, relationshipResult.results);
  const nowStatements = [...calculated].map(([id, generation]) => binding.prepare('UPDATE persons SET generation=? WHERE id=? AND family_id=?').bind(generation, id, familyId));
  const numbers = [...new Set(calculated.values())].sort((a, b) => a - b);
  nowStatements.push(binding.prepare('DELETE FROM generations WHERE family_id=?').bind(familyId));
  numbers.forEach((number) => nowStatements.push(binding.prepare('INSERT INTO generations (id,family_id,number,title) VALUES (?,?,?,?)').bind(`${familyId}-g${number}`, familyId, number, `第${number}代`)));
  if (nowStatements.length) await binding.batch(nowStatements);
}

export async function addPerson(userId: string, input: { familyId: string; direction: 'INITIAL'|'PARENT'|'CHILD'|'SPOUSE'; referencePersonId?: string; name: string; gender?: string; birthYear?: string; biography?: string }) {
  const role = await membership(userId, input.familyId);
  if (!editRoles.has(role)) throw new Response('当前权限只能查看，不能添加人物', { status: 403 });
  const binding = db();
  const count = await binding.prepare('SELECT COUNT(*) total FROM persons WHERE family_id=?').bind(input.familyId).first<{ total: number }>();
  if ((count?.total ?? 0) === 0 && input.direction !== 'INITIAL') throw new Response('空白族谱请先添加初始人物', { status: 400 });
  if ((count?.total ?? 0) > 0 && input.direction === 'INITIAL') throw new Response('请从现有人物添加父母、子女或配偶', { status: 400 });
  let reference: { id: string } | null = null;
  if (input.direction !== 'INITIAL') {
    reference = await binding.prepare('SELECT id FROM persons WHERE id=? AND family_id=?').bind(input.referencePersonId, input.familyId).first<{ id: string }>();
    if (!reference) throw new Response('参照人物不属于当前族谱', { status: 400 });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (!input.name?.trim()) throw new Response('请填写人物姓名', { status: 400 });
  const statements = [binding.prepare('INSERT INTO persons (id,family_id,linked_user_id,name,gender,generation,birth_year,biography,created_at,created_by_user_id,updated_by_user_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, input.familyId, null, input.name.trim(), input.gender ?? '', 1, input.birthYear ?? '', input.biography ?? '', now, userId, userId, now)];
  if (reference) {
    const relationId = crypto.randomUUID();
    const relationType = input.direction === 'SPOUSE' ? 'SPOUSE' : 'PARENT';
    const fromId = input.direction === 'PARENT' ? id : reference.id;
    const toId = input.direction === 'PARENT' ? reference.id : id;
    // The related person already belongs to this family and the new person ID is
    // not yet stored. A fresh ID cannot duplicate an existing edge or form an
    // ancestor cycle; the full validator is used when both endpoints exist.
    statements.push(binding.prepare('INSERT INTO relationships (id,family_id,from_person_id,to_person_id,type,created_at,created_by_user_id) VALUES (?,?,?,?,?,?,?)').bind(relationId, input.familyId, fromId, toId, relationType, now, userId));
  }
  await binding.batch(statements);
  await recalculate(input.familyId);
  return { id };
}

export async function updatePerson(userId: string, familyId: string, personId: string, patch: { name?:string; gender?:string; birthYear?:string; biography?:string }) {
  await requirePersonWrite(userId, familyId, personId);
  const name = String(patch.name ?? '').trim();
  if (!name) throw new Response('姓名不能为空', { status: 400 });
  const result = await db().prepare('UPDATE persons SET name=?,gender=?,birth_year=?,biography=?,updated_by_user_id=?,updated_at=? WHERE id=? AND family_id=?')
    .bind(name, String(patch.gender ?? ''), String(patch.birthYear ?? ''), String(patch.biography ?? ''), userId, new Date().toISOString(), personId, familyId).run();
  if (!result.meta.changes) throw new Response('人物资料未更新', { status: 409 });
  return { id: personId, updated: true };
}

export async function addRelationship(userId: string, familyId: string, fromPersonId: string, toPersonId: string, type: 'PARENT'|'SPOUSE') {
  const role = await membership(userId, familyId);
  if (!editRoles.has(role)) throw new Response('当前权限只能查看，不能修改关系', { status: 403 });
  if (role === 'EDITOR') {
    const owned = await db().prepare('SELECT COUNT(*) total FROM persons WHERE family_id=? AND id IN (?,?) AND created_by_user_id=?').bind(familyId, fromPersonId, toPersonId, userId).first<{total:number}>();
    if (!owned?.total) throw new Response('编辑成员只能维护与自己录入人物有关的关系', { status: 403 });
  }
  if (!['PARENT','SPOUSE'].includes(type)) throw new Response('不支持的关系类型', { status: 400 });
  await validateRelationship(familyId, fromPersonId, toPersonId, type);
  const id = crypto.randomUUID();
  await db().prepare('INSERT INTO relationships (id,family_id,from_person_id,to_person_id,type,created_at,created_by_user_id) VALUES (?,?,?,?,?,?,?)')
    .bind(id, familyId, fromPersonId, toPersonId, type, new Date().toISOString(), userId).run();
  await recalculate(familyId);
  return { id };
}

export async function claimPerson(userId: string, familyId: string, personId: string) {
  await membership(userId, familyId);
  const person = await db().prepare('SELECT id FROM persons WHERE id=? AND family_id=?').bind(personId, familyId).first();
  if (!person) throw new Response('人物不属于当前族谱', { status: 404 });
  const existing = await db().prepare("SELECT id,status FROM person_claims WHERE family_id=? AND user_id=? AND status IN ('PENDING','APPROVED') LIMIT 1").bind(familyId, userId).first<{id:string;status:string}>();
  if (existing) throw new Response(existing.status === 'APPROVED' ? '你在这本族谱中已经认领了本人' : '你已有一条待审核认领申请', { status: 409 });
  const linked = await db().prepare('SELECT id FROM persons WHERE family_id=? AND linked_user_id=? LIMIT 1').bind(familyId, userId).first();
  if (linked) throw new Response('你在这本族谱中已经认领了本人', { status: 409 });
  const id = crypto.randomUUID();
  const reviewId = crypto.randomUUID();
  const now = new Date().toISOString();
  const admins = await db().prepare("SELECT user_id FROM family_users WHERE family_id=? AND role IN ('OWNER','ADMIN')").bind(familyId).all<{user_id:string}>();
  const statements = [
    db().prepare("INSERT INTO person_claims (id,family_id,user_id,person_id,status,created_at) VALUES (?,?,?,?, 'PENDING', ?)").bind(id, familyId, userId, personId, now),
    db().prepare("INSERT INTO review_requests (id,family_id,applicant_user_id,request_type,target_id,new_data,reason,status,created_at) VALUES (?,?,?,?,?,?,?,'PENDING',?)").bind(reviewId, familyId, userId, 'CLAIM_PERSON', id, JSON.stringify({ person_id:personId }), '认领本人', now),
    db().prepare("INSERT INTO user_messages (id,user_id,family_id,message_type,title,content,related_request_id,is_read,created_at) VALUES (?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(), userId, familyId, 'REQUEST_SUBMITTED', '认领申请已提交', '认领本人申请已提交管理员审核。', reviewId, now),
  ];
  for (const admin of admins.results) if (admin.user_id !== userId) statements.push(db().prepare("INSERT INTO user_messages (id,user_id,family_id,message_type,title,content,related_request_id,is_read,created_at) VALUES (?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(), admin.user_id, familyId, 'REVIEW_PENDING', '新的认领申请', '有一条认领本人申请等待审核。', reviewId, now));
  await db().batch(statements);
  return { id, reviewId, status: 'PENDING' };
}

export async function setMemberRole(ownerId: string, familyId: string, targetUserId: string, nextRole: FamilyRole) {
  const role = await membership(ownerId, familyId);
  if (role !== 'OWNER') throw new Response('只有族谱创建者可以调整成员权限', { status: 403 });
  if (!['ADMIN','EDITOR','VIEWER'].includes(nextRole)) throw new Response('不能转移或修改创建者身份', { status: 400 });
  const result = await db().prepare("UPDATE family_users SET role=? WHERE user_id=? AND family_id=? AND role!='OWNER'").bind(nextRole, targetUserId, familyId).run();
  if (!result.meta.changes) throw new Response('未找到可修改的族谱成员', { status: 404 });
  return { userId: targetUserId, role: nextRole };
}

export async function reviewClaim(reviewerId: string, familyId: string, claimId: string, decision: 'APPROVED'|'REJECTED') {
  const role = await membership(reviewerId, familyId);
  if (role !== 'OWNER' && role !== 'ADMIN') throw new Response('只有创建者或管理员可以审核认领', { status: 403 });
  const claim = await db().prepare('SELECT user_id,person_id FROM person_claims WHERE id=? AND family_id=? AND status=\'PENDING\'').bind(claimId, familyId).first<{user_id:string;person_id:string}>();
  if (!claim) throw new Response('未找到待审核认领申请', { status: 404 });
  if (!['APPROVED','REJECTED'].includes(decision)) throw new Response('审核结果无效', { status: 400 });
  if (decision === 'APPROVED') {
    const other = await db().prepare('SELECT id FROM persons WHERE family_id=? AND linked_user_id=? AND id!=? LIMIT 1').bind(familyId, claim.user_id, claim.person_id).first();
    if (other) throw new Response('该用户已在当前族谱认领其他人物', { status: 409 });
    const target = await db().prepare('SELECT linked_user_id FROM persons WHERE family_id=? AND id=?').bind(familyId, claim.person_id).first<{linked_user_id:string|null}>();
    if (!target || (target.linked_user_id && target.linked_user_id !== claim.user_id)) throw new Response('该人物已被其他用户认领', { status: 409 });
  }
  const now = new Date().toISOString();
  const review = await db().prepare("SELECT id FROM review_requests WHERE family_id=? AND request_type='CLAIM_PERSON' AND target_id=?").bind(familyId, claimId).first<{id:string}>();
  const reviewId = review?.id ?? `review-claim-${claimId}`;
  const statements = [
    db().prepare('UPDATE person_claims SET status=? WHERE id=? AND family_id=?').bind(decision, claimId, familyId),
    db().prepare("INSERT INTO review_requests (id,family_id,applicant_user_id,reviewer_user_id,request_type,target_id,new_data,reason,status,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET reviewer_user_id=excluded.reviewer_user_id,status=excluded.status,reviewed_at=excluded.reviewed_at").bind(reviewId, familyId, claim.user_id, reviewerId, 'CLAIM_PERSON', claimId, JSON.stringify({ person_id:claim.person_id }), '认领本人', decision, now, now),
    db().prepare("INSERT INTO user_messages (id,user_id,family_id,message_type,title,content,related_request_id,is_read,created_at) VALUES (?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(), claim.user_id, familyId, decision === 'APPROVED' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', decision === 'APPROVED' ? '认领申请已通过' : '认领申请已驳回', decision === 'APPROVED' ? '你的认领本人申请已通过审核。' : '你的认领本人申请未通过审核。', reviewId, now),
  ];
  if (decision === 'APPROVED') statements.push(db().prepare('UPDATE persons SET linked_user_id=? WHERE id=? AND family_id=?').bind(claim.user_id, claim.person_id, familyId));
  await db().batch(statements);
  return { claimId, status: decision };
}
