import { env } from 'cloudflare:workers';
import { calculateGenerations, type FamilyRelationship } from './generation-model';
import { requireUser } from './auth';

export const LEGACY_FAMILY_ID = 'family-lingshi-existing';
export type FamilyRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
const editRoles = new Set<FamilyRole>(['OWNER', 'ADMIN', 'EDITOR']);

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('族谱数据库尚未绑定');
  return binding;
}

export async function ensureUser(request: Request) {
  const user = await requireUser(request);
  const now = new Date().toISOString();
  await db().batch([
    db().prepare("INSERT OR IGNORE INTO families (id,name,description,join_code,source_type,created_by,created_at) VALUES (?,?,?,?,?,?,?)").bind(LEGACY_FAMILY_ID, '凌氏家谱', '保留的原有凌氏家谱', 'LINGSHI', 'LEGACY_STATIC', user.id, now),
  ]);
  const owner = await db().prepare('SELECT user_id FROM family_users WHERE family_id=? LIMIT 1').bind(LEGACY_FAMILY_ID).first();
  if (!owner) {
    await db().prepare('INSERT INTO family_users (user_id,family_id,role,joined_at) VALUES (?,?,?,?)').bind(user.id, LEGACY_FAMILY_ID, 'OWNER', now).run();
  }
  return user;
}

export async function membership(userId: string, familyId: string) {
  const row = await db().prepare('SELECT role FROM family_users WHERE user_id=? AND family_id=?').bind(userId, familyId).first<{ role: FamilyRole }>();
  if (!row) throw new Response('你尚未加入这本族谱', { status: 403 });
  return row.role;
}

export async function listFamilies(userId: string) {
  const result = await db().prepare(`SELECT f.id,f.name,f.description,f.join_code,f.source_type,fu.role,fu.joined_at
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
  const family = await db().prepare('SELECT id,name FROM families WHERE join_code=?').bind(code.trim().toUpperCase()).first<{ id: string; name: string }>();
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
  const result = await db().prepare("DELETE FROM families WHERE id=? AND name=? AND source_type='DATABASE'").bind(familyId, confirmedName).run();
  if (result.meta.changes !== 1) throw new Response('族谱未被删除', { status: 409 });
  return { id: familyId, deleted: true };
}

export async function getFamilyTree(userId: string, familyId: string) {
  const role = await membership(userId, familyId);
  const binding = db();
  const canReview = role === 'OWNER' || role === 'ADMIN';
  const [family, people, relationships, generations, announcements, media, claims, members] = await Promise.all([
    binding.prepare('SELECT id,name,description,join_code,source_type FROM families WHERE id=?').bind(familyId).first(),
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
  return { family, role, people: people.results, relationships: relationships.results, generations: generations.results, announcements: announcements.results, media: media.results, claims: claims.results, members: members.results };
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
  const statements = [binding.prepare('INSERT INTO persons (id,family_id,linked_user_id,name,gender,generation,birth_year,biography,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, input.familyId, null, input.name.trim(), input.gender ?? '', 1, input.birthYear ?? '', input.biography ?? '', now)];
  if (reference) {
    const relationId = crypto.randomUUID();
    if (input.direction === 'PARENT') statements.push(binding.prepare("INSERT INTO relationships (id,family_id,from_person_id,to_person_id,type,created_at) VALUES (?,?,?,?, 'PARENT', ?)").bind(relationId, input.familyId, id, reference.id, now));
    if (input.direction === 'CHILD') statements.push(binding.prepare("INSERT INTO relationships (id,family_id,from_person_id,to_person_id,type,created_at) VALUES (?,?,?,?, 'PARENT', ?)").bind(relationId, input.familyId, reference.id, id, now));
    if (input.direction === 'SPOUSE') statements.push(binding.prepare("INSERT INTO relationships (id,family_id,from_person_id,to_person_id,type,created_at) VALUES (?,?,?,?, 'SPOUSE', ?)").bind(relationId, input.familyId, reference.id, id, now));
  }
  await binding.batch(statements);
  await recalculate(input.familyId);
  return { id };
}

export async function claimPerson(userId: string, familyId: string, personId: string) {
  await membership(userId, familyId);
  const person = await db().prepare('SELECT id FROM persons WHERE id=? AND family_id=?').bind(personId, familyId).first();
  if (!person) throw new Response('人物不属于当前族谱', { status: 404 });
  const id = crypto.randomUUID();
  await db().prepare("INSERT OR IGNORE INTO person_claims (id,family_id,user_id,person_id,status,created_at) VALUES (?,?,?,?, 'PENDING', ?)").bind(id, familyId, userId, personId, new Date().toISOString()).run();
  return { id, status: 'PENDING' };
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
  const statements = [db().prepare('UPDATE person_claims SET status=? WHERE id=? AND family_id=?').bind(decision, claimId, familyId)];
  if (decision === 'APPROVED') statements.push(db().prepare('UPDATE persons SET linked_user_id=? WHERE id=? AND family_id=? AND linked_user_id IS NULL').bind(claim.user_id, claim.person_id, familyId));
  await db().batch(statements);
  return { claimId, status: decision };
}
