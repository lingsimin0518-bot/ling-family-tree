'use client';

import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

type CreatedUser = { id: string; username: string; system_role: 'USER'; status: 'ACTIVE' };
type Availability = { available?: boolean; projectId?: string; runtimeDeploymentVerification?: string };

export default function InitialUserRegistrationForm() {
  const [target, setTarget] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    void fetch('/api/admin/operations/initial-user', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Initial-User-Availability-Check': 'v1' }, body: '{}' })
      .then(async (response) => response.ok ? await response.json() as Availability : null)
      .then((data) => {
        if (active && data?.available === true && typeof data.projectId === 'string'
          && data.runtimeDeploymentVerification === 'UNAVAILABLE') setTarget(data.projectId);
      })
      .catch(() => { if (active) setTarget(null); });
    return () => { active = false; };
  }, []);

  const validSecret = /^[a-f0-9]{64,128}$/.test(secret) && secret.length % 2 === 0;
  const canSubmit = Boolean(target) && !busy && username.trim().length > 0 && password.length >= 8
    && password === confirmPassword && email.trim().length > 0 && validSecret;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/operations/initial-user', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Initial-User-Registration-Secret': secret },
        body: JSON.stringify({ projectId: target, username, password, confirmPassword, email }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; code?: unknown; user?: Partial<CreatedUser> } | null;
      const user = data?.user;
      if (response.status === 201 && data?.ok === true && user?.system_role === 'USER' && user.status === 'ACTIVE'
        && typeof user.id === 'string' && /^[a-f0-9-]{36}$/i.test(user.id) && typeof user.username === 'string') {
        setCreated({ id: user.id, username: user.username, system_role: 'USER', status: 'ACTIVE' });
        setTarget(null);
      } else {
        const code = typeof data?.code === 'string' && /^[A-Z_]{1,64}$/.test(data.code) ? data.code : 'UNEXPECTED_RESPONSE';
        setError(`创建未完成（HTTP ${response.status} · ${code}）。请先核对状态，不要重复点击。`);
        if (code !== 'INITIAL_USER_SECRET_INVALID' && code !== 'INITIAL_USER_VALIDATION_FAILED') setTarget(null);
      }
    } catch {
      setError('请求结果无法确认，请停止并先核对数据库状态，不要重复提交。');
      setTarget(null);
    } finally {
      setSecret('');
      setPassword('');
      setConfirmPassword('');
      setBusy(false);
      pending.current = false;
    }
  }

  if (!target && !created && !error) return null;
  return <section aria-labelledby="initial-user-title">
    <h2 id="initial-user-title">创建首个正式账号</h2>
    <p className="warning">临时一次性运维功能。只创建普通 USER 账号，不授予系统管理员或族谱权限。</p>
    {target && !created && <form onSubmit={submit} autoComplete="off">
      <label htmlFor="initial-username">用户名</label>
      <input id="initial-username" autoComplete="off" maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} required />
      <label htmlFor="initial-password">密码</label>
      <input id="initial-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required />
      <label htmlFor="initial-confirm-password">确认密码</label>
      <input id="initial-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
      <label htmlFor="initial-email">邮箱</label>
      <input id="initial-email" type="email" autoComplete="off" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required />
      <p className="muted">沿用现有注册规则，保留联系邮箱；本通道不会发送验证邮件。</p>
      <label htmlFor="initial-registration-secret">一次性 Registration Secret</label>
      <input id="initial-registration-secret" type="password" autoComplete="new-password" spellCheck={false} minLength={64} maxLength={128} value={secret} onChange={(event) => setSecret(event.target.value)} required />
      <button type="submit" disabled={!canSubmit}>{busy ? '正在创建…' : '创建唯一一个普通账号'}</button>
    </form>}
    {created && <output className="status ok"><p>创建成功</p><dl>
      <dt>user_id</dt><dd>{created.id}</dd><dt>username</dt><dd>{created.username}</dd>
      <dt>system_role</dt><dd>{created.system_role}</dd><dt>status</dt><dd>{created.status}</dd>
    </dl></output>}
    {error && <p className="status error" role="alert">{error}</p>}
  </section>;
}
