'use client';

import { useState, type SyntheticEvent } from 'react';

export type ResetTarget = {
  projectId: string;
  databaseBinding: 'DB';
  schema: '0010';
  sitesVersion: number;
  deploymentId: string;
  backupSha256: string;
};

export default function ProductionResetForm({ target }: { target: ResetTarget }) {
  const [secret, setSecret] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [backupSha, setBackupSha] = useState('');
  const [projectConfirmation, setProjectConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const exactConfirmation = `RESET_ALL_BUSINESS_DATA:${target.projectId}`;
  const canSubmit = !busy && secret.length > 0 && confirmation === exactConfirmation
    && backupSha === target.backupSha256 && projectConfirmation === target.projectId;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    if (!window.confirm('这是不可逆操作，将删除全部生产业务数据。确认继续？')) {
      setSecret('');
      return;
    }
    setBusy(true);
    setResult('');
    try {
      const response = await fetch('/api/admin/operations/production-reset', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Production-Reset-Secret': secret },
        body: JSON.stringify({
          projectId: target.projectId,
          databaseBinding: target.databaseBinding,
          schema: target.schema,
          sitesVersion: target.sitesVersion,
          deploymentId: target.deploymentId,
          backupSha256: backupSha,
          confirmation,
        }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; code?: unknown } | null;
      if (response.ok && data?.ok === true) {
        setResult('Reset 已完成。请立即停止操作并按执行手册验证数据库。');
      } else {
        const code = typeof data?.code === 'string' && /^[A-Z_]{1,64}$/.test(data.code)
          ? data.code : 'UNEXPECTED_RESPONSE';
        setResult(`请求未成功（HTTP ${response.status} · ${code}）。请停止，不要自行重试。`);
      }
    } catch {
      setResult('请求结果无法确认。请停止，不要自行重试；先检查服务端状态。');
    } finally {
      setSecret('');
      setBusy(false);
    }
  }

  return <section aria-labelledby="production-reset-title">
    <h2 id="production-reset-title">Production Reset · 一次性执行</h2>
    <p className="status error" role="alert">不可逆：执行后将清空全部生产业务数据。未获得单独清库批准前，禁止填写密钥或点击执行。</p>
    <p className="muted">实际 Sites Version 和 Deployment ID 必须在 Sites 控制面单独核对；应用内运行时核验不可用。每次正式提交会消耗一次尝试机会。</p>
    <form onSubmit={submit} autoComplete="off">
      <label htmlFor="reset-secret">Production Reset Secret</label>
      <input id="reset-secret" type="password" autoComplete="new-password" spellCheck={false}
        value={secret} onChange={(event) => setSecret(event.target.value)} required />
      <label htmlFor="reset-confirmation">精确确认文本</label>
      <input id="reset-confirmation" autoComplete="off" spellCheck={false} value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)} required />
      <label htmlFor="reset-backup-sha">批准的备份 SHA-256</label>
      <input id="reset-backup-sha" autoComplete="off" spellCheck={false} value={backupSha}
        onChange={(event) => setBackupSha(event.target.value)} required />
      <label htmlFor="reset-project">Project 确认值</label>
      <input id="reset-project" autoComplete="off" spellCheck={false} value={projectConfirmation}
        onChange={(event) => setProjectConfirmation(event.target.value)} required />
      <button type="submit" disabled={!canSubmit}>{busy ? '正在提交…' : '执行不可逆 Production Reset'}</button>
    </form>
    {result && <output className="status">{result}</output>}
  </section>;
}
