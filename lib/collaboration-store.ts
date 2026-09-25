import { env } from 'cloudflare:workers';
import { membership, type FamilyRole } from './family-store';

type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
type ReviewType = 'CLAIM_PERSON' | 'CREATE_PERSON' | 'UPDATE_PERSON' | 'FAMILY_ACTIVITY';

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('族谱数据库尚未绑定');
  return binding;
}

function requireAdmin(role: FamilyRole) {
  if (role !== 'OWNER' && role !== 'ADMIN') throw new Response('只有族谱创建者或管理员可以执行此操作', { status: 403 });
}

function required(value: string, label: string, max = 5000) {
  const normalized = value.trim();
  if (!normalized) throw new Response(`请填写${label}`, { status: 400 });
  if (normalized.length > max) throw new Response(`${label}内容过长`, { status: 400 });
  return normalized;
}

async function adminIds(familyId: string) {
  const rows = await db().prepare("SELECT user_id FROM family_users WHERE family_id=? AND role IN ('OWNER','ADMIN')").bind(familyId).all<{user_id:string}>();
  return rows.results.map((item) => item.user_id);
}

function messageStatement(userId: string, familyId: string, type: string, title: string, content: string, requestId: string | null, now: string) {
  return db().prepare('INSERT INTO user_messages (id,user_id,family_id,message_type,title,content,related_request_id,is_read,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .bind(crypto.randomUUID(), userId, familyId, type, title, content, requestId, now);
}

export async function listAnnouncements(userId: string, familyId: string) {
  await membership(userId, familyId);
  const rows = await db().prepare(`SELECT a.*,COALESCE(u.nickname,u.display_name,u.username) author_name
    FROM announcements a JOIN users u ON u.id=a.author_user_id
    WHERE a.family_id=? ORDER BY a.created_at DESC`).bind(familyId).all();
  return rows.results;
}

export async function createAnnouncement(userId: string, familyId: string, title: string, body: string) {
  requireAdmin(await membership(userId, familyId));
  const item = { id: crypto.randomUUID(), title: required(title, '公告标题', 160), body: required(body, '公告正文'), createdAt: new Date().toISOString() };
  await db().prepare('INSERT INTO announcements (id,family_id,author_user_id,title,body,created_at) VALUES (?,?,?,?,?,?)')
    .bind(item.id, familyId, userId, item.title, item.body, item.createdAt).run();
  return item;
}

export async function updateAnnouncement(userId: string, familyId: string, announcementId: string, title: string, body: string) {
  requireAdmin(await membership(userId, familyId));
  const result = await db().prepare('UPDATE announcements SET title=?,body=? WHERE id=? AND family_id=?')
    .bind(required(title, '公告标题', 160), required(body, '公告正文'), announcementId, familyId).run();
  if (!result.meta.changes) throw new Response('未找到当前族谱中的公告', { status: 404 });
  return { id: announcementId, updated: true };
}

export async function deleteAnnouncement(userId: string, familyId: string, announcementId: string) {
  requireAdmin(await membership(userId, familyId));
  const result = await db().prepare('DELETE FROM announcements WHERE id=? AND family_id=?').bind(announcementId, familyId).run();
  if (!result.meta.changes) throw new Response('未找到当前族谱中的公告', { status: 404 });
  return { id: announcementId, deleted: true };
}

export async function listActivities(userId: string, familyId: string) {
  const role = await membership(userId, familyId);
  const admin = role === 'OWNER' || role === 'ADMIN';
  const where = admin ? 'a.family_id=?' : "a.family_id=? AND (a.status='APPROVED' OR a.author_user_id=?)";
  const statement = db().prepare(`SELECT a.*,COALESCE(u.nickname,u.display_name,u.username) author_name
    FROM family_activities a JOIN users u ON u.id=a.author_user_id
    WHERE ${where} ORDER BY a.created_at DESC`);
  const rows = admin ? await statement.bind(familyId).all() : await statement.bind(familyId, userId).all();
  return rows.results;
}

export async function submitActivity(userId: string, familyId: string, title: string, body: string) {
  await membership(userId, familyId);
  const now = new Date().toISOString();
  const activityId = crypto.randomUUID();
  const reviewId = crypto.randomUUID();
  const cleanTitle = required(title, '动态标题', 160);
  const cleanBody = required(body, '动态正文');
  const statements = [
    db().prepare("INSERT INTO family_activities (id,family_id,author_user_id,title,body,status,created_at) VALUES (?,?,?,?,?,'PENDING',?)").bind(activityId, familyId, userId, cleanTitle, cleanBody, now),
    db().prepare("INSERT INTO review_requests (id,family_id,applicant_user_id,request_type,target_id,new_data,reason,status,created_at) VALUES (?,?,?,?,?,?,?,'PENDING',?)").bind(reviewId, familyId, userId, 'FAMILY_ACTIVITY', activityId, JSON.stringify({ title: cleanTitle, body: cleanBody }), cleanBody, now),
    messageStatement(userId, familyId, 'REQUEST_SUBMITTED', '动态已提交', `“${cleanTitle}”已提交管理员审核。`, reviewId, now),
  ];
  for (const adminId of await adminIds(familyId)) if (adminId !== userId) statements.push(messageStatement(adminId, familyId, 'REVIEW_PENDING', '新的动态待审核', `“${cleanTitle}”等待审核。`, reviewId, now));
  await db().batch(statements);
  return { id: activityId, reviewId, status: 'PENDING' };
}

export async function submitReview(userId: string, familyId: string, type: Extract<ReviewType,'CREATE_PERSON'|'UPDATE_PERSON'>, targetId: string | null, oldData: unknown, newData: unknown, reason: string) {
  await membership(userId, familyId);
  if (type === 'UPDATE_PERSON' && !targetId) throw new Response('缺少待修改人物', { status: 400 });
  const family = await db().prepare('SELECT source_type FROM families WHERE id=?').bind(familyId).first<{source_type:string}>();
  if (!family) throw new Response('族谱不存在', { status: 404 });
  if (targetId && family.source_type === 'DATABASE') {
    const person = await db().prepare('SELECT id FROM persons WHERE id=? AND family_id=?').bind(targetId, familyId).first();
    if (!person) throw new Response('人物不属于当前族谱', { status: 404 });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cleanReason = required(reason, '申请理由', 1000);
  const title = type === 'CREATE_PERSON' ? '新增人物申请' : '人物资料修改申请';
  const statements = [
    db().prepare("INSERT INTO review_requests (id,family_id,applicant_user_id,request_type,target_id,old_data,new_data,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'PENDING',?)")
      .bind(id, familyId, userId, type, targetId, JSON.stringify(oldData ?? null), JSON.stringify(newData ?? null), cleanReason, now),
    messageStatement(userId, familyId, 'REQUEST_SUBMITTED', '申请已提交', `${title}已提交管理员审核。`, id, now),
  ];
  for (const adminId of await adminIds(familyId)) if (adminId !== userId) statements.push(messageStatement(adminId, familyId, 'REVIEW_PENDING', '新的申请待审核', `${title}等待审核。`, id, now));
  await db().batch(statements);
  return { id, status: 'PENDING' };
}

export async function listReviews(userId: string, familyId: string) {
  const role = await membership(userId, familyId);
  const admin = role === 'OWNER' || role === 'ADMIN';
  const query = `SELECT r.*,COALESCE(applicant.nickname,applicant.display_name,applicant.username) applicant_name,
    COALESCE(reviewer.nickname,reviewer.display_name,reviewer.username) reviewer_name
    FROM review_requests r JOIN users applicant ON applicant.id=r.applicant_user_id
    LEFT JOIN users reviewer ON reviewer.id=r.reviewer_user_id
    WHERE ${admin ? 'r.family_id=?' : 'r.family_id=? AND r.applicant_user_id=?'} ORDER BY r.created_at DESC`;
  const statement = db().prepare(query);
  const rows = admin ? await statement.bind(familyId).all() : await statement.bind(familyId, userId).all();
  return rows.results;
}

export async function reviewRequest(reviewerId: string, familyId: string, requestId: string, decision: ReviewStatus, reason = '') {
  requireAdmin(await membership(reviewerId, familyId));
  if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new Response('审核结果无效', { status: 400 });
  const review = await db().prepare("SELECT id,applicant_user_id,request_type,target_id,new_data FROM review_requests WHERE id=? AND family_id=? AND status='PENDING'")
    .bind(requestId, familyId).first<{id:string;applicant_user_id:string;request_type:ReviewType;target_id:string|null;new_data:string|null}>();
  if (!review) throw new Response('未找到当前族谱中的待审核申请', { status: 404 });
  if (review.request_type === 'CLAIM_PERSON') throw new Response('认领申请请使用认领审核流程', { status: 409 });
  const now = new Date().toISOString();
  const statements = [
    db().prepare('UPDATE review_requests SET status=?,reviewer_user_id=?,reason=CASE WHEN ?<>\'\' THEN ? ELSE reason END,reviewed_at=? WHERE id=? AND family_id=? AND status=\'PENDING\'')
      .bind(decision, reviewerId, reason.trim(), reason.trim(), now, requestId, familyId),
    messageStatement(review.applicant_user_id, familyId, decision === 'APPROVED' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', decision === 'APPROVED' ? '申请已通过' : '申请已驳回', reason.trim() || (decision === 'APPROVED' ? '你的申请已通过审核。' : '你的申请未通过审核。'), requestId, now),
  ];
  if (review.request_type === 'FAMILY_ACTIVITY' && review.target_id) statements.push(db().prepare('UPDATE family_activities SET status=?,reviewer_user_id=?,reviewed_at=? WHERE id=? AND family_id=?').bind(decision, reviewerId, now, review.target_id, familyId));
  // LEGACY_STATIC 的人物新增/修改只记录审核结果，不覆盖静态 family.html 人物源。
  await db().batch(statements);
  return { id: requestId, status: decision };
}

export async function listMessages(userId: string, familyId: string) {
  await membership(userId, familyId);
  const rows = await db().prepare('SELECT * FROM user_messages WHERE user_id=? AND family_id=? ORDER BY created_at DESC').bind(userId, familyId).all();
  return rows.results;
}

export async function markMessageRead(userId: string, familyId: string, messageId: string) {
  await membership(userId, familyId);
  const result = await db().prepare('UPDATE user_messages SET is_read=1 WHERE id=? AND user_id=? AND family_id=?').bind(messageId, userId, familyId).run();
  if (!result.meta.changes) throw new Response('未找到你的这条消息', { status: 404 });
  return { id: messageId, isRead: true };
}
