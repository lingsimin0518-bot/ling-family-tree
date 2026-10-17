'use client';

import { useEffect, useState, type SyntheticEvent } from 'react';

type SessionUser = {
  id: string;
  username: string;
  systemRole: 'USER' | 'SUPER_ADMIN';
};

type Overview = {
  maintenanceMode: boolean;
  productionResetEnabled: boolean;
  resetSecretConfigured: boolean;
  runtimeDeploymentVerification: 'UNAVAILABLE';
  schemaVersion: string;
  profileVersion: '0006' | '0010';
  schemaRecognitionMethod: 'd1_migrations' | 'sites_migration_record' | 'structural_inference' | 'unrecognized';
  tableCount: number;
  tables: string[];
  platformTables: string[];
  unknownTables: string[];
  missingTables: string[];
  matchesExpected0006: boolean;
  matchesExpected0010: boolean;
  matchesExpectedBackup: boolean;
};

type ProbeResult = { label: string; passed: boolean; detail: string };
type OperationsCheckResult = { passed: boolean; status: number | null; code: string; checkedAt: string };

function safeCheckCode(value: unknown) {
  return typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : 'UNEXPECTED_RESPONSE';
}

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
  const [resetCheckBusy, setResetCheckBusy] = useState(false);
  const [resetCheckResult, setResetCheckResult] = useState<OperationsCheckResult | null>(null);
  const [writeCheckBusy, setWriteCheckBusy] = useState(false);
  const [writeCheckResult, setWriteCheckResult] = useState<OperationsCheckResult | null>(null);
  const readyFor0010 = overview?.profileVersion === '0010' && overview.matchesExpected0010
    && overview.tableCount === 19 && overview.unknownTables.length === 0 && overview.missingTables.length === 0;

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
      const filename = /^production-schema-(0006|0010)-[\w-]+\.zip$/.test(suggested)
        ? suggested : `production-schema-${overview?.profileVersion ?? 'unknown'}-backup.zip`;
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
    if (probeBusy || user?.systemRole !== 'SUPER_ADMIN' || health !== 'maintenance' || !overview?.matchesExpectedBackup) return;
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

  async function checkResetDisabled() {
    if (resetCheckBusy || user?.systemRole !== 'SUPER_ADMIN' || health !== 'maintenance'
      || !overview?.maintenanceMode || overview?.productionResetEnabled !== false || !readyFor0010) return;
    setResetCheckBusy(true);
    setResetCheckResult(null);
    try {
      // No Secret, confirmation, backup SHA or other executable Reset fields.
      // The server's dedicated probe branch returns before any Reset writes.
      const response = await fetch('/api/admin/operations/production-reset', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Production-Reset-Disabled-Probe': 'v1' },
        body: '{}',
      });
      const body = await response.json().catch(() => null) as { code?: unknown } | null;
      const code = safeCheckCode(body?.code);
      setResetCheckResult({
        passed: response.status === 503 && code === 'RESET_DISABLED',
        status: response.status, code, checkedAt: new Date().toLocaleString('zh-CN'),
      });
    } catch {
      setResetCheckResult({ passed: false, status: null, code: 'NETWORK_ERROR', checkedAt: new Date().toLocaleString('zh-CN') });
    } finally {
      setResetCheckBusy(false);
    }
  }

  async function checkMaintenanceWrite() {
    if (writeCheckBusy || user?.systemRole !== 'SUPER_ADMIN' || health !== 'maintenance'
      || !overview?.maintenanceMode || !readyFor0010) return;
    setWriteCheckBusy(true);
    setWriteCheckResult(null);
    try {
      // An incomplete CREATE_FAMILY request cannot create a family even if
      // the maintenance gate unexpectedly fails open.
      const response = await fetch('/api/families', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CREATE_FAMILY' }),
      });
      const body = await response.json().catch(() => null) as { code?: unknown } | null;
      const code = safeCheckCode(body?.code);
      setWriteCheckResult({
        passed: response.status === 503 && code === 'SERVICE_MAINTENANCE',
        status: response.status, code, checkedAt: new Date().toLocaleString('zh-CN'),
      });
    } catch {
      setWriteCheckResult({ passed: false, status: null, code: 'NETWORK_ERROR', checkedAt: new Date().toLocaleString('zh-CN') });
    } finally {
      setWriteCheckBusy(false);
    }
  }

  async function refreshStatus() {
    if (user?.systemRole !== 'SUPER_ADMIN' || overviewState === 'loading') return;
    // A prior PASS must not survive a configuration or deployment change.
    setResetCheckResult(null);
    setWriteCheckResult(null);
    setProbeResults([]);
    setOverview(null);
    setHealth('loading');
    setOverviewState('loading');
    try {
      const [healthResponse, overviewResponse] = await Promise.all([
        fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' }),
        fetch('/api/admin/maintenance/overview', { cache: 'no-store', credentials: 'same-origin' }),
      ]);
      if (!healthResponse.ok || !overviewResponse.ok) throw new Error('status unavailable');
      const healthData = await healthResponse.json() as { status?: string };
      const overviewData = await overviewResponse.json() as Overview;
      setHealth(healthData.status === 'maintenance' ? 'maintenance' : healthData.status === 'operational' ? 'operational' : 'error');
      setOverview(overviewData);
      setOverviewState('idle');
    } catch {
      setHealth('error');
      setOverviewState('error');
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
        <button type="button" onClick={refreshStatus} disabled={overviewState === 'loading'}>{overviewState === 'loading' ? '正在刷新…' : '刷新运维状态'}</button>
        {overviewState === 'error' && <p className="status error">无法读取数据库概况，请刷新重试。</p>}
        {!overview && overviewState !== 'error' && <p className="status">正在读取表和结构版本…</p>}
        {overview && <><dl><dt>结构版本</dt><dd>{overview.schemaVersion}{overview.schemaRecognitionMethod === 'structural_inference' ? '（推断）' : ''}</dd><dt>业务表数量</dt><dd>{overview.tableCount}</dd>
          <dt>{overview.profileVersion} / {overview.profileVersion === '0006' ? '16' : '19'} 表核对</dt><dd>{overview.matchesExpectedBackup ? '一致' : '异常，请停止备份和验收'}</dd>
          <dt>0010 / 19 表运维验收</dt><dd>{readyFor0010 ? '一致' : '未就绪'}</dd>
          <dt>Reset 开关</dt><dd>{overview.productionResetEnabled ? '已开启，请停止禁用态验收' : '已关闭'}</dd>
          <dt>Reset Secret 配置</dt><dd>{overview.resetSecretConfigured ? '已配置（不显示内容）' : '未配置'}</dd>
          <dt>运行时部署身份</dt><dd>{overview.runtimeDeploymentVerification}（应用内无法核验，请到 Sites 平台人工核对）</dd></dl>
          <p className="muted">业务表：{overview.tables.join('、')}</p>
          <p className="muted">平台内部表（不计入业务表或备份）：{overview.platformTables.join('、') || '无'}</p>
          {overview.missingTables.length > 0 && <p className="status error">缺少业务表：{overview.missingTables.join('、')}</p>}
          {overview.unknownTables.length > 0 && <p className="status error">未知额外表：{overview.unknownTables.join('、')}。已停止备份，请人工确认。</p>}</>}</section>
      <section><h2>维护期运维自检</h2>
        <p>只检查禁用状态与维护门禁，不执行数据重置。当前版本不提供实际 Reset 表单或执行按钮。若运维配置刚变更，请先刷新页面重新读取状态。</p>
        {overview?.productionResetEnabled && <p className="status error" role="alert">Reset 开关已开启：禁用态验收停止，请人工核对配置。</p>}
        <button type="button" onClick={checkResetDisabled} disabled={resetCheckBusy || health !== 'maintenance' || !overview?.maintenanceMode || overview?.productionResetEnabled !== false || !readyFor0010}>
          {resetCheckBusy ? '正在检查…' : '验证 Reset 禁用状态'}
        </button>
        {resetCheckResult && <output className={resetCheckResult.passed ? 'status probe-pass' : 'status error'}>
          {resetCheckResult.passed ? 'PASS' : 'FAIL'} · {resetCheckResult.status === null ? 'HTTP 未完成' : `HTTP ${resetCheckResult.status}`} · {resetCheckResult.code} · {resetCheckResult.checkedAt}
        </output>}
        <button type="button" onClick={checkMaintenanceWrite} disabled={writeCheckBusy || health !== 'maintenance' || !overview?.maintenanceMode || !readyFor0010}>
          {writeCheckBusy ? '正在检查…' : '验证维护模式写入拦截'}
        </button>
        {writeCheckResult && <output className={writeCheckResult.passed ? 'status probe-pass' : 'status error'}>
          {writeCheckResult.passed ? 'PASS' : 'FAIL'} · {writeCheckResult.status === null ? 'HTTP 未完成' : `HTTP ${writeCheckResult.status}`} · {writeCheckResult.code} · {writeCheckResult.checkedAt}
        </output>}
      </section>
      <section><h2>维护模式写入阻断验收</h2>
        <p>从本站抽查 10 项缺少有效业务参数的写入入口。每项必须返回 HTTP 503 和 SERVICE_MAINTENANCE；遇到异常立即停止后续请求。</p>
        <button type="button" onClick={runWriteProbes} disabled={probeBusy || health !== 'maintenance' || !overview?.matchesExpectedBackup}>{probeBusy ? '正在检查…' : '检查 10 项业务写入入口'}</button>
        {probeResults.length > 0 && <ul className="probe-list">{probeResults.map((result) => <li key={result.label} className={result.passed ? 'probe-pass' : 'probe-fail'}>{result.label}：{result.passed ? 'PASS' : 'FAIL'}（{result.detail}）</li>)}</ul>}</section>
      <section><h2>生产备份</h2>
        <p className="warning">备份包含账号、会话、联系方式及完整族谱资料，请妥善保管，不要提交到 Git。</p>
        <button type="button" onClick={downloadBackup} disabled={backupBusy || health !== 'maintenance' || !overview?.matchesExpectedBackup}>{backupBusy ? '正在生成…' : '生成生产备份'}</button>
        {backupMessage && <output className="status">{backupMessage}</output>}</section>
    </>}
  </div></main>;
}
