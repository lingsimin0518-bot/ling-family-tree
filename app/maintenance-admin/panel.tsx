'use client';

import { useEffect, useState, type SyntheticEvent } from 'react';

type SessionUser = {
  id: string;
  username: string;
  systemRole: 'USER' | 'SUPER_ADMIN';
};

type Overview = {
  schemaVersion: string;
  schemaRecognitionMethod: 'd1_migrations' | 'sites_migration_record' | 'structural_inference' | 'unrecognized';
  tableCount: number;
  tables: string[];
  platformTables: string[];
  unknownTables: string[];
  missingTables: string[];
  matchesExpected0006: boolean;
};

type ProbeResult = { label: string; passed: boolean; detail: string };

const WRITE_PROBES = [
  { label: '注册', path: '/api/auth/register', body: {} },
  { label: '创建族谱', path: '/api/families', body: { action: 'CREATE_FAMILY' } },
  { label: '加入族谱', path: '/api/families', body: { action: 'JOIN_FAMILY' } },
  { label: '新增人物', path: '/api/families', body: { action: 'ADD_PERSON' } },
  { label: '新增关系', path: '/api/families', body: { action: 'ADD_RELATIONSHIP' } },
  { label: '认领本人', path: '/api/families', body: { action: 'CLAIM_PERSON' } },
  { label: '公告写入', path: '/api/announcements', body: {} },
  { label: '动态写入', path: '/api/activities', body: {} },
  { label: '审核写入', path: '/api/reviews', body: {} },
  { label: '消息写入', path: '/api/messages', body: {} },
] as const;

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error || `请求失败（HTTP ${response.status}）`;
}

export default function MaintenanceAdminPanel() {
  const [sessionState, setSessionState] = useState<'loading' | 'signed-out' | 'signed-in' | 'error'>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [health, setHealth] = useState<'loading' | 'maintenance' | 'operational' | 'error'>('loading');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewState, setOverviewState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResults, setProbeResults] = useState<ProbeResult[]>([]);

  useEffect(() => {
    let active = true;
    void fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('health unavailable');
        return response.json() as Promise<{ status: string }>;
      })
      .then((data) => { if (active) setHealth(data.status === 'maintenance' ? 'maintenance' : 'operational'); })
      .catch(() => { if (active) setHealth('error'); });
    void fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error('session unavailable');
        const data = await response.json() as { user: SessionUser };
        return data.user;
      })
      .then((currentUser) => {
        if (!active) return;
        setUser(currentUser);
        setSessionState(currentUser ? 'signed-in' : 'signed-out');
      })
      .catch(() => { if (active) setSessionState('error'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (user?.systemRole !== 'SUPER_ADMIN') return;
    let active = true;
    void fetch('/api/admin/maintenance/overview', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('overview unavailable');
        return response.json() as Promise<Overview>;
      })
      .then((data) => { if (active) setOverview(data); })
      .catch(() => { if (active) setOverviewState('error'); });
    return () => { active = false; };
  }, [user]);

  async function handleLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setPassword('');
      // 登录响应不能单独作为授权依据：必须重新读取服务端 Session。
      const sessionResponse = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
      if (!sessionResponse.ok) throw new Error('登录后无法确认会话，请刷新重试');
      const data = await sessionResponse.json() as { user: SessionUser };
      setUser(data.user);
      setSessionState('signed-in');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败，请重试');
    } finally {
      setLoginBusy(false);
    }
  }

  async function downloadBackup() {
    if (backupBusy || user?.systemRole !== 'SUPER_ADMIN' || health !== 'maintenance') return;
    setBackupBusy(true);
    setBackupMessage('正在生成完整备份，请勿重复点击…');
    try {
      const response = await fetch('/api/admin/backups/export', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (!(response.headers.get('content-type') ?? '').includes('application/zip')) {
        throw new Error('服务器没有返回 ZIP 备份文件');
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      const suggested = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? '';
      const filename = /^production-schema-0006-[\w-]+\.zip$/.test(suggested)
        ? suggested : 'production-schema-0006-backup.zip';
      const blob = await response.blob();
      if (blob.size === 0) throw new Error('备份文件为空');
      const address = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = address;
      anchor.download = filename;
      document.querySelector('body')?.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(address), 60_000);
      setBackupMessage('已发起 ZIP 下载。请确认文件已保存，并在本地完成校验和恢复验证。');
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : '备份失败，请重试');
    } finally {
      setBackupBusy(false);
    }
  }

  async function runWriteProbes() {
    if (probeBusy || user?.systemRole !== 'SUPER_ADMIN' || health !== 'maintenance' || !overview?.matchesExpected0006) return;
    setProbeBusy(true);
    setProbeResults([]);
    const results: ProbeResult[] = [];
    try {
      for (const probe of WRITE_PROBES) {
        // 每个请求都缺少完成写入所需的字段；即使维护门禁意外失效，也不提交有效业务数据。
        const response = await fetch(probe.path, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe.body),
        });
        const data = await response.json().catch(() => null) as { code?: string } | null;
        const passed = response.status === 503 && data?.code === 'SERVICE_MAINTENANCE';
        results.push({ label: probe.label, passed, detail: `HTTP ${response.status} · ${data?.code ?? '未返回维护错误码'}` });
        setProbeResults([...results]);
        if (!passed) break;
      }
    } catch {
      results.push({ label: '网络检查', passed: false, detail: '请求未完成，请检查网络连接' });
      setProbeResults([...results]);
    } finally {
      setProbeBusy(false);
    }
  }

  return <main className="maintenance-admin"><div className="maintenance-admin-shell">
    <header><p className="eyebrow">家谱 · 维护期专用</p><h1>管理员安全检查</h1>
      <p>仅使用现有账号、会话及系统级 SUPER_ADMIN 权限。这里不提供数据修改、迁移或重置功能。</p></header>
    <section><h2>维护状态</h2><dl><dt>当前模式</dt><dd>{health === 'loading' ? '检查中…' : health === 'maintenance' ? '维护中' : health === 'operational' ? '未开启维护模式' : '读取失败'}</dd>
      <dt>/api/health</dt><dd>{health === 'maintenance' || health === 'operational' ? '正常' : health === 'loading' ? '检查中…' : '失败'}</dd></dl></section>
    {sessionState === 'loading' && <section><p className="status">正在确认登录状态…</p></section>}
    {sessionState === 'error' && <section><p className="status error">登录状态读取失败，请刷新页面重试。</p></section>}
    {sessionState === 'signed-out' && <section><h2>使用现有账号登录</h2>
      <form onSubmit={handleLogin}><label htmlFor="maintenance-username">用户名</label>
        <input id="maintenance-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        <label htmlFor="maintenance-password">密码</label>
        <input id="maintenance-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <button type="submit" disabled={loginBusy}>{loginBusy ? '正在登录…' : '登录'}</button></form>
      {loginError && <p className="status error" role="alert">{loginError}</p>}</section>}
    {sessionState === 'signed-in' && user && <section><h2>当前账号</h2><dl><dt>用户名</dt><dd>{user.username}</dd>
      <dt>系统权限</dt><dd>{user.systemRole}</dd></dl>
      {user.systemRole !== 'SUPER_ADMIN' && <p className="status error" role="alert">此账号不是系统级超级管理员，不能查看生产概况或下载备份。族谱 OWNER / ADMIN 权限不等于系统级权限。</p>}</section>}
    {sessionState === 'signed-in' && user?.systemRole === 'SUPER_ADMIN' && <>
      <section><h2>只读数据库概况</h2>
        {overviewState === 'error' && <p className="status error">无法读取数据库概况，请刷新重试。</p>}
        {!overview && overviewState !== 'error' && <p className="status">正在读取表和结构版本…</p>}
        {overview && <><dl><dt>结构版本</dt><dd>{overview.schemaVersion}{overview.schemaRecognitionMethod === 'structural_inference' ? '（推断）' : ''}</dd><dt>业务表数量</dt><dd>{overview.tableCount}</dd>
          <dt>0006 / 16 表核对</dt><dd>{overview.matchesExpected0006 && overview.schemaVersion === '0006' ? '一致' : '异常，请停止备份和验收'}</dd></dl>
          <p className="muted">业务表：{overview.tables.join('、')}</p>
          <p className="muted">平台内部表（不计入业务表或备份）：{overview.platformTables.join('、') || '无'}</p>
          {overview.missingTables.length > 0 && <p className="status error">缺少业务表：{overview.missingTables.join('、')}</p>}
          {overview.unknownTables.length > 0 && <p className="status error">未知额外表：{overview.unknownTables.join('、')}。已停止备份，请人工确认。</p>}</>}</section>
      <section><h2>维护模式写入阻断验收</h2>
        <p>从本站逐项发起缺少有效业务参数的测试请求。每项必须返回 HTTP 503 和 SERVICE_MAINTENANCE；遇到异常立即停止后续请求。</p>
        <button type="button" onClick={runWriteProbes} disabled={probeBusy || health !== 'maintenance' || !overview?.matchesExpected0006 || overview.schemaVersion !== '0006'}>{probeBusy ? '正在检查…' : '检查业务写入是否全部被阻止'}</button>
        {probeResults.length > 0 && <ul className="probe-list">{probeResults.map((result) => <li key={result.label} className={result.passed ? 'probe-pass' : 'probe-fail'}>{result.label}：{result.passed ? 'PASS' : 'FAIL'}（{result.detail}）</li>)}</ul>}</section>
      <section><h2>生产备份</h2>
        <p className="warning">备份包含账号、会话、联系方式及完整族谱资料，请妥善保管，不要提交到 Git。</p>
        <button type="button" onClick={downloadBackup} disabled={backupBusy || health !== 'maintenance' || !overview?.matchesExpected0006 || overview.schemaVersion !== '0006'}>{backupBusy ? '正在生成…' : '生成生产备份'}</button>
        {backupMessage && <output className="status">{backupMessage}</output>}</section>
    </>}
  </div></main>;
}
