import { requireUser } from '../../../lib/auth';

function escapeHtml(value: string) {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    if (user.username !== 'ling' || user.systemRole !== 'USER') return new Response('Not found',{status:404});
    return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>一次性初始化</title>
      <style>body{font-family:system-ui;background:#f8f0df;color:#56251f;display:grid;place-items:center;min-height:100vh}.box{background:#fffaf0;border:2px solid #b58a3a;border-radius:18px;padding:32px;max-width:520px}button{background:#9e2f2b;color:#fff;border:0;border-radius:10px;padding:14px 22px;font-size:18px}</style>
      <div class="box"><h1>一次性系统管理员初始化</h1><p>目标账号：<b>${escapeHtml(user.username)}</b></p><p>此操作只会把该账号的系统角色从 USER 修改为 SUPER_ADMIN，并写入系统审计日志。</p><button id="run">执行一次性初始化</button><pre id="result"></pre></div>
      <script>document.querySelector('#run').onclick=async()=>{const b=document.querySelector('#run');b.disabled=true;const r=await fetch('/api/internal/bootstrap-ling-super-admin',{method:'POST'});document.querySelector('#result').textContent=await r.text()}</script>`,{
      headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'},
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response('Not found',{status:404});
  }
}
