import { env } from 'cloudflare:workers';
import { requireSuperAdmin } from './auth';

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('平台数据库尚未绑定');
  return binding;
}

async function writeLog(operatorId:string, actionType:string, targetUserId:string|null, oldValue:string, newValue:string, reason:string) {
  await db().prepare(`INSERT INTO system_audit_logs
    (id,operator_user_id,action_type,target_user_id,old_value,new_value,created_at,reason)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(),operatorId,actionType,targetUserId,oldValue,newValue,new Date().toISOString(),reason).run();
}

export async function adminOverview(request:Request) {
  await requireSuperAdmin(request);
  const [users,families,disabled,logs] = await db().batch([
    db().prepare('SELECT COUNT(*) total FROM users'),
    db().prepare('SELECT COUNT(*) total FROM families'),
    db().prepare("SELECT COUNT(*) total FROM users WHERE status!='ACTIVE'"),
    db().prepare('SELECT COUNT(*) total FROM system_audit_logs'),
  ]);
  return {
    users:Number(users.results?.[0]?.total ?? 0),
    families:Number(families.results?.[0]?.total ?? 0),
    disabledUsers:Number(disabled.results?.[0]?.total ?? 0),
    logs:Number(logs.results?.[0]?.total ?? 0),
  };
}

export async function adminUsers(request:Request) {
  await requireSuperAdmin(request);
  const result = await db().prepare(`SELECT u.id,u.username,u.nickname,u.email,u.phone,u.created_at,u.last_login_at,
    u.status,u.system_role,COUNT(DISTINCT fu.family_id) family_count,
    CASE WHEN COUNT(DISTINCT p.id)>0 THEN 1 ELSE 0 END person_bound
    FROM users u
    LEFT JOIN family_users fu ON fu.user_id=u.id
    LEFT JOIN persons p ON p.linked_user_id=u.id
    GROUP BY u.id ORDER BY u.created_at DESC`).all();
  return result.results;
}

export async function adminUserDetail(request:Request, userId:string) {
  const operator = await requireSuperAdmin(request);
  const [user,families,logs] = await Promise.all([
    db().prepare(`SELECT id,username,nickname,email,phone,avatar,status,system_role,created_at,updated_at,
      last_login_at,disabled_at,disabled_by FROM users WHERE id=?`).bind(userId).first(),
    db().prepare(`SELECT f.id,f.name,fu.role,fu.joined_at FROM family_users fu
      JOIN families f ON f.id=fu.family_id WHERE fu.user_id=? ORDER BY fu.joined_at DESC`).bind(userId).all(),
    db().prepare(`SELECT l.*,COALESCE(o.nickname,o.username,o.display_name) operator_name
      FROM system_audit_logs l JOIN users o ON o.id=l.operator_user_id
      WHERE l.target_user_id=? OR l.operator_user_id=? ORDER BY l.created_at DESC LIMIT 50`).bind(userId,userId).all(),
  ]);
  if (!user) throw new Response('用户不存在',{status:404});
  await writeLog(operator.id,'USER_DETAIL_VIEW',userId,'','已查看','查看用户详情');
  return {user,families:families.results,logs:logs.results};
}

export async function adminFamilies(request:Request) {
  await requireSuperAdmin(request);
  const result = await db().prepare(`SELECT f.id,f.name,f.created_at,f.source_type status,
    COALESCE(NULLIF(COALESCE(u.nickname,u.username,u.display_name),''),f.created_by) creator,
    COUNT(DISTINCT fu.user_id) member_count,COUNT(DISTINCT p.id) person_count
    FROM families f
    LEFT JOIN users u ON u.id=f.created_by
    LEFT JOIN family_users fu ON fu.family_id=f.id
    LEFT JOIN persons p ON p.family_id=f.id
    GROUP BY f.id ORDER BY f.created_at DESC`).all();
  return result.results;
}

export async function adminLogs(request:Request) {
  await requireSuperAdmin(request);
  const result = await db().prepare(`SELECT l.*,COALESCE(o.nickname,o.username,o.display_name) operator_name,
    COALESCE(t.nickname,t.username,t.display_name) target_name
    FROM system_audit_logs l JOIN users o ON o.id=l.operator_user_id
    LEFT JOIN users t ON t.id=l.target_user_id
    ORDER BY l.created_at DESC LIMIT 200`).all();
  return result.results;
}

export async function updateUserStatus(request:Request, targetUserId:string, action:'DISABLE_USER'|'RESTORE_USER'|'FORCE_LOGOUT', reason:string) {
  const operator = await requireSuperAdmin(request);
  if (!targetUserId) throw new Response('请选择用户',{status:400});
  const target = await db().prepare('SELECT id,status,system_role FROM users WHERE id=?').bind(targetUserId).first<{id:string;status:string;system_role:string}>();
  if (!target) throw new Response('用户不存在',{status:404});
  if (target.id === operator.id && action !== 'FORCE_LOGOUT') throw new Response('不能禁用或恢复当前登录的超级管理员账号',{status:400});
  const now = new Date().toISOString();
  if (action === 'FORCE_LOGOUT') {
    const sessions = await db().prepare('SELECT COUNT(*) total FROM user_sessions WHERE user_id=?').bind(targetUserId).first<{total:number}>();
    await db().batch([
      db().prepare('DELETE FROM user_sessions WHERE user_id=?').bind(targetUserId),
      db().prepare(`INSERT INTO system_audit_logs (id,operator_user_id,action_type,target_user_id,old_value,new_value,created_at,reason)
        VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),operator.id,action,targetUserId,String(sessions?.total ?? 0),'0',now,reason || '超级管理员强制退出'),
    ]);
    return {id:targetUserId,status:target.status,sessionsRevoked:Number(sessions?.total ?? 0)};
  }
  const nextStatus = action === 'DISABLE_USER' ? 'DISABLED' : 'ACTIVE';
  await db().batch([
    db().prepare('UPDATE users SET status=?,disabled_at=?,disabled_by=?,updated_at=? WHERE id=?')
      .bind(nextStatus,nextStatus==='DISABLED'?now:null,nextStatus==='DISABLED'?operator.id:null,now,targetUserId),
    db().prepare(`INSERT INTO system_audit_logs (id,operator_user_id,action_type,target_user_id,old_value,new_value,created_at,reason)
      VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),operator.id,action,targetUserId,target.status,nextStatus,now,reason || (nextStatus==='DISABLED'?'超级管理员禁用账号':'超级管理员恢复账号')),
    ...(nextStatus==='DISABLED' ? [db().prepare('DELETE FROM user_sessions WHERE user_id=?').bind(targetUserId)] : []),
  ]);
  return {id:targetUserId,status:nextStatus};
}
