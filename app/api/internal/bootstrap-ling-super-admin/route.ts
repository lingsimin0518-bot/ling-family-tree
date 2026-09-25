import { env } from 'cloudflare:workers';
import { requireUser } from '../../../../lib/auth';

const TARGET_USERNAME = 'ling';
const AUDIT_LOG_ID = 'bootstrap-super-admin-ling-v1';

function database() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('族谱数据库尚未绑定');
  return binding;
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers:{'Cache-Control':'private, no-store'} });
}

export async function POST(request: Request) {
  try {
    const sessionUser = await requireUser(request);
    if (sessionUser.username !== TARGET_USERNAME) return json({error:'Not found'},404);
    const db = database();
    const matches = await db.prepare(
      'SELECT id,username,system_role FROM users WHERE username=? COLLATE NOCASE',
    ).bind(TARGET_USERNAME).all<{id:string;username:string;system_role:string}>();
    if (matches.results.length !== 1) return json({error:'目标账号不存在或不唯一，初始化已拒绝'},409);
    const target = matches.results[0];
    if (target.id !== sessionUser.id) return json({error:'Not found'},404);
    if (target.system_role === 'SUPER_ADMIN') return json({error:'一次性初始化已经失效'},410);
    if (target.system_role !== 'USER') return json({error:'目标账号角色状态不符合初始化条件'},409);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(
        "UPDATE users SET system_role='SUPER_ADMIN',updated_at=? WHERE id=? AND username=? COLLATE NOCASE AND system_role='USER'",
      ).bind(now,target.id,TARGET_USERNAME),
      db.prepare(
        'INSERT INTO system_audit_logs (id,operator_user_id,action_type,target_user_id,old_value,new_value,created_at,reason) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(AUDIT_LOG_ID,target.id,'BOOTSTRAP_SUPER_ADMIN',target.id,'USER','SUPER_ADMIN',now,'一次性初始化首位系统超级管理员'),
    ]);
    const verified = await db.prepare(
      'SELECT system_role FROM users WHERE id=? AND username=? COLLATE NOCASE',
    ).bind(target.id,TARGET_USERNAME).first<{system_role:string}>();
    if (verified?.system_role !== 'SUPER_ADMIN') throw new Error('初始化后角色校验失败');
    return json({ok:true,username:TARGET_USERNAME,system_role:'SUPER_ADMIN'});
  } catch (error) {
    if (error instanceof Response) return json({error:await error.text()},error.status);
    console.error('one-time super admin bootstrap failed');
    return json({error:'一次性初始化失败'},500);
  }
}
