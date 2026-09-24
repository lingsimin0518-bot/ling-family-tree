import { env } from 'cloudflare:workers';

export const CREATION_COOLDOWN_SECONDS = 60;

export type CreationAction =
  | 'REGISTER_ACCOUNT'
  | 'CREATE_FAMILY'
  | 'CREATE_PERSON'
  | 'ADD_FATHER'
  | 'ADD_MOTHER'
  | 'ADD_PARENT'
  | 'ADD_CHILD'
  | 'ADD_SPOUSE'
  | 'SUBMIT_CLAIM'
  | 'SUBMIT_PERSON_REQUEST';

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('族谱数据库尚未绑定');
  return binding;
}

function familyKey(familyId?: string) {
  return familyId?.trim() ?? '';
}

function actionLabel(action: CreationAction) {
  if (action === 'CREATE_FAMILY') return '新建族谱操作';
  if (action === 'REGISTER_ACCOUNT') return '账号注册';
  if (action === 'SUBMIT_CLAIM') return '认领申请提交';
  if (action === 'SUBMIT_PERSON_REQUEST') return '新增人物申请提交';
  if (action === 'ADD_FATHER') return '添加父亲';
  if (action === 'ADD_MOTHER') return '添加母亲';
  if (action === 'ADD_PARENT') return '亲属新增';
  if (action === 'ADD_CHILD') return '添加子女';
  if (action === 'ADD_SPOUSE') return '添加配偶';
  return '人物新增';
}

function cooldownResponse(action: CreationAction, remaining: number) {
  return new Response(`${actionLabel(action)}过于频繁，请在 ${remaining} 秒后再试。`, {
    status: 429,
    headers: { 'Retry-After': String(remaining) },
  });
}

export function registrationActor(request: Request) {
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown-client';
  return `register:${ip}`;
}

export async function runCreation<T>(options: {
  actorKey: string;
  userId?: string;
  familyId?: string;
  actionType: CreationAction;
  idempotencyKey?: string | null;
  operation: () => Promise<T>;
  targetId?: (result: T) => string | undefined;
}): Promise<{ result: T; replayed: boolean }> {
  const binding = db();
  const scopeFamily = familyKey(options.familyId);
  const key = String(options.idempotencyKey ?? '').trim().slice(0, 200);

  if (key) {
    const existing = await binding.prepare(
      'SELECT status,response_json FROM action_idempotency WHERE actor_key=? AND family_key=? AND action_type=? AND idempotency_key=?'
    ).bind(options.actorKey, scopeFamily, options.actionType, key).first<{status:string;response_json:string|null}>();
    if (existing?.status === 'COMPLETED' && existing.response_json) {
      return { result: JSON.parse(existing.response_json) as T, replayed: true };
    }
    if (existing) throw new Response('相同请求正在处理中，请勿重复提交。', { status: 409 });
  }

  const latest = await binding.prepare(
    'SELECT last_success_at FROM action_rate_limit WHERE actor_key=? AND family_key=? AND action_type=?'
  ).bind(options.actorKey, scopeFamily, options.actionType).first<{last_success_at:string}>();
  if (latest) {
    const elapsed = Math.floor((Date.now() - Date.parse(latest.last_success_at)) / 1000);
    if (elapsed < CREATION_COOLDOWN_SECONDS) throw cooldownResponse(options.actionType, CREATION_COOLDOWN_SECONDS - Math.max(0, elapsed));
  }

  const reservationId = key ? crypto.randomUUID() : '';
  if (key) {
    try {
      await binding.prepare('INSERT INTO action_idempotency (id,actor_key,family_key,action_type,idempotency_key,status,created_at) VALUES (?,?,?,?,?,\'PENDING\',?)')
        .bind(reservationId, options.actorKey, scopeFamily, options.actionType, key, new Date().toISOString()).run();
    } catch {
      const raced = await binding.prepare(
        'SELECT status,response_json FROM action_idempotency WHERE actor_key=? AND family_key=? AND action_type=? AND idempotency_key=?'
      ).bind(options.actorKey, scopeFamily, options.actionType, key).first<{status:string;response_json:string|null}>();
      if (raced?.status === 'COMPLETED' && raced.response_json) return { result: JSON.parse(raced.response_json) as T, replayed: true };
      throw new Response('相同请求正在处理中，请勿重复提交。', { status: 409 });
    }
  }

  try {
    const result = await options.operation();
    const now = new Date().toISOString();
    const statements = [binding.prepare(`INSERT INTO action_rate_limit (id,actor_key,user_id,family_id,family_key,action_type,target_id,last_success_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(actor_key,family_key,action_type) DO UPDATE SET user_id=excluded.user_id,family_id=excluded.family_id,target_id=excluded.target_id,last_success_at=excluded.last_success_at`)
      .bind(crypto.randomUUID(), options.actorKey, options.userId ?? null, options.familyId ?? null, scopeFamily, options.actionType, options.targetId?.(result) ?? null, now)];
    if (key) statements.push(binding.prepare('UPDATE action_idempotency SET status=\'COMPLETED\',response_json=?,completed_at=? WHERE id=?').bind(JSON.stringify(result), now, reservationId));
    await binding.batch(statements);
    return { result, replayed: false };
  } catch (error) {
    if (key) await binding.prepare('DELETE FROM action_idempotency WHERE id=? AND status=\'PENDING\'').bind(reservationId).run().catch(() => undefined);
    throw error;
  }
}
