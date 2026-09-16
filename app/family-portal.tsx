'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import './auth.css';

type User = { id:string; username:string; email:string; phone:string; nickname:string; avatar:string; status:string; systemRole:'USER'|'SUPER_ADMIN' };
type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
type Family = { id:string; name:string; description?:string; join_code:string; source_type:'DATABASE'|'LEGACY_STATIC'; role:Role };
type Person = { id:string; name:string; gender?:string; generation:number; birth_year?:string; biography?:string; linked_user_id?:string|null };
type Relation = { id:string; from_person_id:string; to_person_id:string; type:'PARENT'|'CHILD'|'SPOUSE' };
type Claim = { id:string; person_id:string; status:string; person_name?:string; user_name?:string };
type Member = { user_id:string; role:Role; display_name?:string; email?:string };
type Tree = { family:Family; role:Role; people:Person[]; relationships:Relation[]; claims:Claim[]; members:Member[] };
type FamilyLoadState = 'idle' | 'loading' | 'empty' | 'ready' | 'error';

const roleNames:Record<Role,string> = { OWNER:'创建者', ADMIN:'管理员', EDITOR:'编辑成员', VIEWER:'查看成员' };
const directions = { INITIAL:'初始人物', PARENT:'添加父亲或母亲', CHILD:'添加子女', SPOUSE:'添加配偶' } as const;

async function requestJson<T = any>(url:string, init?:RequestInit):Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({})) as T & { error?:string };
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}

export default function FamilyPortal() {
  const [families,setFamilies] = useState<Family[]>([]);
  const [currentId,setCurrentId] = useState('');
  const [showFamilies,setShowFamilies] = useState(false);
  const [user,setUser] = useState<User|null>(null);
  const [authLoading,setAuthLoading] = useState(true);
  const [tree,setTree] = useState<Tree|null>(null);
  const [familyLoadState,setFamilyLoadState] = useState<FamilyLoadState>('idle');
  const [familyLoadError,setFamilyLoadError] = useState('');
  const [message,setMessage] = useState('');
  const [addTarget,setAddTarget] = useState<{direction:keyof typeof directions;reference?:Person}|null>(null);
  const [deleteTarget,setDeleteTarget] = useState<Family|null>(null);
  const [deleteName,setDeleteName] = useState('');
  const current = families.find((family) => family.id === currentId) ?? families[0];

  const loadFamilies = async () => {
    if (!user) return;
    setFamilyLoadState('loading');
    setFamilyLoadError('');
    try {
      const data = await requestJson<{user:unknown;families:Family[]}>('/api/families');
      setFamilies(data.families);
      if (!data.families.length) {
        setCurrentId('');
        setTree(null);
        setFamilyLoadState('empty');
      } else {
        setCurrentId((selected) => data.families.some((family:Family) => family.id === selected) ? selected : data.families[0].id);
        setFamilyLoadState('ready');
      }
    } catch (error) {
      setFamilies([]);
      setCurrentId('');
      setTree(null);
      setFamilyLoadError((error as Error).message);
      setFamilyLoadState('error');
    }
  };
  useEffect(() => {
    requestJson<{user:User}>('/api/auth/session')
      .then((data)=>setUser(data.user))
      .catch(()=>setUser(null))
      .finally(()=>setAuthLoading(false));
  }, []);
  useEffect(() => {
    if (user) void loadFamilies();
    else { setFamilies([]); setCurrentId(''); setFamilyLoadState('idle'); }
  }, [user?.id]);
  useEffect(() => {
    if (!current || familyLoadState !== 'ready') { setTree(null); return; }
    requestJson<Tree>(`/api/families?family_id=${encodeURIComponent(current.id)}`)
      .then(setTree).catch((error) => setMessage(error.message));
  }, [current?.id, familyLoadState]);

  const refreshTree = async () => {
    if (!current) return;
    setTree(await requestJson<Tree>(`/api/families?family_id=${encodeURIComponent(current.id)}`));
  };
  const createFamily = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const family = await requestJson<Family>('/api/families',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'CREATE_FAMILY',name:form.get('name'),description:form.get('description')})});
      await loadFamilies(); setCurrentId(family.id); setMessage('空白族谱已创建，请添加第一位初始人物。'); event.currentTarget.reset();
    } catch (error) { setMessage((error as Error).message); }
  };
  const joinFamily = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { await requestJson('/api/families',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'JOIN_FAMILY',code:form.get('code')})}); await loadFamilies(); setMessage('已加入族谱。'); event.currentTarget.reset(); }
    catch (error) { setMessage((error as Error).message); }
  };
  const deleteSelectedFamily = async () => {
    if (!deleteTarget || deleteName !== deleteTarget.name) return;
    try {
      await requestJson('/api/families',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'DELETE_FAMILY',familyId:deleteTarget.id,confirmedName:deleteName})});
      setDeleteTarget(null); setDeleteName(''); setCurrentId(''); await loadFamilies(); setMessage('族谱已永久删除。');
    } catch (error) { setMessage((error as Error).message); }
  };
  const addPerson = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || !addTarget) return;
    const form = new FormData(event.currentTarget);
    try {
      await requestJson('/api/families',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'ADD_PERSON',familyId:current.id,direction:addTarget.direction,referencePersonId:addTarget.reference?.id,name:form.get('name'),gender:form.get('gender'),birthYear:form.get('birthYear'),biography:form.get('biography')})});
      setAddTarget(null); await refreshTree(); setMessage('人物已加入，世代编号已自动重新计算。');
    } catch (error) { setMessage((error as Error).message); }
  };
  const claim = async (personId:string) => {
    if (!current) return;
    try { await requestJson('/api/families',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'CLAIM_PERSON',familyId:current.id,personId})}); await refreshTree(); setMessage('认领申请已提交，审核通过后才会关联账号。'); }
    catch (error) { setMessage((error as Error).message); }
  };
  const manage = async (body:Record<string,unknown>) => {
    if (!current) return;
    try { await requestJson('/api/families',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,familyId:current.id})}); await refreshTree(); setMessage('处理完成。'); }
    catch (error) { setMessage((error as Error).message); }
  };

  const logout = async () => {
    try { await requestJson('/api/auth/logout',{method:'POST'}); }
    finally { setUser(null); setTree(null); setCurrentId(''); setFamilyLoadState('idle'); setShowFamilies(false); setMessage('已安全退出登录。'); }
  };

  if (authLoading) return <main className="portal"><LoadingFamilyScreen label="正在加载你的族谱…" /></main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  return <main className="portal">
    <header className="family-bar"><div className="family-current"><span>当前族谱</span><strong>{current?.name ?? '尚未选择族谱'}</strong>{current && <em>{roleNames[current.role]}</em>}</div><div className="account-actions"><span>{user.nickname || user.username}</span>{user.systemRole==='SUPER_ADMIN'&&<a className="plain-button" href="/admin">系统后台</a>}<button className="gold-button" onClick={() => setShowFamilies(true)}>我的族谱</button><button className="plain-button" onClick={logout}>退出登录</button></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message}<span>×</span></div>}
    {(familyLoadState==='idle' || familyLoadState==='loading') && <LoadingFamilyScreen label="正在加载你的族谱…" />}
    {familyLoadState==='empty' && <FirstUseScreen onCreate={()=>setShowFamilies(true)} onJoin={()=>setShowFamilies(true)} />}
    {familyLoadState==='error' && <LoadErrorScreen detail={familyLoadError} onRetry={()=>void loadFamilies()} />}
    {familyLoadState==='ready' && current && <iframe title={current.name} src={`/family.html?family_id=${encodeURIComponent(current.id)}`} className="legacy-frame" />}
    {showFamilies && <div className="veil"><section className="family-dialog"><button className="close" onClick={() => setShowFamilies(false)}>×</button><h2>我的族谱</h2><p>一个账号可以加入多本族谱，切换后所有人物与资料互不混用。</p>
      <div className="family-list">{families.map((family) => <article className={family.id===current?.id?'selected':''} key={family.id}><div><strong>{family.name}</strong><small>{roleNames[family.role]} · 加入码 {family.join_code}</small></div><div className="family-row-actions"><button onClick={() => {setCurrentId(family.id);setShowFamilies(false)}}>{family.id===current?.id?'当前':'切换'}</button>{family.role==='OWNER'&&family.source_type!=='LEGACY_STATIC'&&<button className="danger-link" onClick={()=>{setDeleteTarget(family);setDeleteName('')}}>删除</button>}</div></article>)}</div>
      <div className="family-forms"><form onSubmit={createFamily}><h3>新建空白族谱</h3><input name="name" required placeholder="族谱名称"/><input name="description" placeholder="简介（选填）"/><button>创建族谱</button><small>不会自动生成示例人物。</small></form><form onSubmit={joinFamily}><h3>加入族谱</h3><input name="code" required placeholder="输入8位加入码"/><button>加入族谱</button><small>加入后默认是查看成员。</small></form></div>
      {deleteTarget&&<section className="delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-family-title"><h3 id="delete-family-title">永久删除“{deleteTarget.name}”？</h3><p>人物、关系、公告、媒体和成员权限都会一并删除，无法恢复。请输入完整族谱名称确认：</p><input value={deleteName} onChange={event=>setDeleteName(event.target.value)} placeholder={deleteTarget.name} autoFocus/><div><button className="cancel-delete" onClick={()=>{setDeleteTarget(null);setDeleteName('')}}>取消</button><button className="confirm-delete" disabled={deleteName!==deleteTarget.name} onClick={deleteSelectedFamily}>确认永久删除</button></div></section>}
    </section></div>}
    {addTarget && <div className="veil"><form className="person-dialog" onSubmit={addPerson}><button type="button" className="close" onClick={() => setAddTarget(null)}>×</button><h2>{directions[addTarget.direction]}</h2>{addTarget.reference && <p>以 <strong>{addTarget.reference.name}</strong> 为参照添加</p>}<label>姓名<input name="name" required autoFocus /></label><label>性别<input name="gender" placeholder="可自由填写" /></label><label>出生年份<input name="birthYear" inputMode="numeric" /></label><label>人物生平<textarea name="biography" rows={4}/></label><button className="submit">保存人物</button></form></div>}
  </main>;
}

function LoadingFamilyScreen({label}:{label:string}) {
  return <section className="family-state family-loading" aria-live="polite" aria-busy="true">
    <div className="loading-seal" aria-hidden="true"><span /></div>
    <h1>{label}</h1>
    <div className="family-skeleton" aria-hidden="true"><i/><i/><i/></div>
  </section>;
}

function FirstUseScreen({onCreate,onJoin}:{onCreate:()=>void;onJoin:()=>void}) {
  return <section className="family-state first-use">
    <div className="first-use-seal" aria-hidden="true">谱</div>
    <p className="first-use-eyebrow">记录家族 · 传承记忆</p>
    <h1>欢迎使用家谱</h1>
    <p className="first-use-intro">你还没有加入任何族谱。</p>
    <div className="first-use-actions">
      <article><button onClick={onCreate}>创建新族谱</button><p>创建新族谱：从空白开始建立自己的家谱</p></article>
      <article><button onClick={onJoin}>加入已有族谱</button><p>加入已有族谱：输入8位加入码加入现有族谱</p></article>
    </div>
  </section>;
}

function LoadErrorScreen({detail,onRetry}:{detail:string;onRetry:()=>void}) {
  return <section className="family-state family-error" role="alert">
    <div className="error-mark" aria-hidden="true">!</div>
    <h1>加载失败，请重试</h1>
    {detail && <p>{detail}</p>}
    <button onClick={onRetry}>重新加载</button>
  </section>;
}

function AuthScreen({onAuthenticated}:{onAuthenticated:(user:User)=>void}) {
  const [mode,setMode] = useState<'login'|'register'>('login');
  const [error,setError] = useState('');
  const [submitting,setSubmitting] = useState(false);
  const [showPassword,setShowPassword] = useState(false);
  const [showConfirmPassword,setShowConfirmPassword] = useState(false);
  const submit = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setSubmitting(true);
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const data = await requestJson<{user:User}>(`/api/auth/${mode}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});
      onAuthenticated(data.user);
    } catch (submitError) { setError((submitError as Error).message); }
    finally { setSubmitting(false); }
  };
  return <main className="auth-page"><section className="auth-card">
    <p className="auth-eyebrow">记录家族 · 传承记忆</p><h1>家谱</h1>
    <p className="auth-intro">{mode==='login'?'登录后查看和管理您已加入的族谱。':'注册只创建登录账号，真实姓名、世代和亲属资料请在进入族谱后另行填写。'}</p>
    <div className="auth-tabs"><button className={mode==='login'?'active':''} onClick={()=>{setMode('login');setError('');setShowPassword(false);setShowConfirmPassword(false)}}>登录</button><button className={mode==='register'?'active':''} onClick={()=>{setMode('register');setError('');setShowPassword(false);setShowConfirmPassword(false)}}>注册</button></div>
    <form className="auth-form" onSubmit={submit}>
      <label>用户名<input name="username" required minLength={1} maxLength={32} autoComplete="username" placeholder="1—32个中文、字母、数字或下划线" />{mode==='register'&&<small>用户名仅用于登录，不等同于真实姓名。</small>}</label>
      <label><span>密码</span><div className="password-control"><input name="password" required minLength={8} maxLength={128} type={showPassword?'text':'password'} autoComplete={mode==='login'?'current-password':'new-password'} placeholder="至少8个字符" /><button type="button" className="password-toggle" aria-pressed={showPassword} onClick={()=>setShowPassword((visible)=>!visible)}>{showPassword?'隐藏':'显示'}</button></div></label>
      {mode==='register'&&<>
        <label><span>确认密码</span><div className="password-control"><input name="confirmPassword" required minLength={8} maxLength={128} type={showConfirmPassword?'text':'password'} autoComplete="new-password" /><button type="button" className="password-toggle" aria-pressed={showConfirmPassword} onClick={()=>setShowConfirmPassword((visible)=>!visible)}>{showConfirmPassword?'隐藏':'显示'}</button></div></label>
        <div className="auth-two-columns"><label>邮箱<input name="email" type="email" autoComplete="email" placeholder="例如 name@example.com" /><small>用于找回账号，可二选一。</small></label><label>手机号<input name="phone" type="tel" autoComplete="tel" placeholder="例如 13800138000" /><small>用于找回账号，可二选一；当前无需验证码。</small></label></div>
      </>}
      {error&&<p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" disabled={submitting}>{submitting?'请稍候…':mode==='login'?'登录':'注册并登录'}</button>
    </form>
    <small className="auth-note">密码经过加盐哈希后保存，网站不会存储明文密码。</small>
  </section></main>;
}

function DatabaseTree({tree,onAdd,onClaim,onManage}:{tree:Tree|null;onAdd:(target:{direction:keyof typeof directions;reference?:Person})=>void;onClaim:(id:string)=>void;onManage:(body:Record<string,unknown>)=>void}) {
  const canEdit = tree && tree.role !== 'VIEWER';
  const generations = useMemo(() => { const result = new Map<number,Person[]>(); tree?.people.forEach((person) => result.set(person.generation,[...(result.get(person.generation) ?? []),person])); return [...result.entries()].sort((a,b)=>a[0]-b[0]); },[tree]);
  if (!tree) return null;
  if (!tree.people.length) return <section className="empty-family"><div className="seal">谱</div><h1>{tree.family.name}</h1><p>这是一本空白族谱。第一位人物只是建立关系的初始人物，并不会被自动标记为始祖。</p>{canEdit?<button onClick={()=>onAdd({direction:'INITIAL'})}>添加第一位初始人物</button>:<p>请联系编辑成员添加第一位人物。</p>}</section>;
  const relationshipText = (person:Person) => tree.relationships.filter((item)=>item.from_person_id===person.id||item.to_person_id===person.id).map((item)=>{ const otherId=item.from_person_id===person.id?item.to_person_id:item.from_person_id; const other=tree.people.find((one)=>one.id===otherId); return `${item.type==='SPOUSE'?'配偶':item.from_person_id===person.id?'子女':'父母'}：${other?.name??'未知'}`; });
  return <section className="database-tree"><div className="tree-heading"><span>独立族谱</span><h1>{tree.family.name}</h1><p>加入码：<b>{tree.family.join_code}</b>　权限：{roleNames[tree.role]}</p>{(tree.role==='OWNER'||tree.role==='ADMIN')&&<details className="admin-box"><summary>成员权限与认领审核</summary>{tree.members.map(member=><div className="admin-row" key={member.user_id}><span>{member.display_name||member.email||'族人'} <small>{roleNames[member.role]}</small></span>{tree.role==='OWNER'&&member.role!=='OWNER'&&<select value={member.role} onChange={event=>onManage({action:'SET_MEMBER_ROLE',targetUserId:member.user_id,role:event.target.value})}><option value="ADMIN">管理员</option><option value="EDITOR">编辑成员</option><option value="VIEWER">查看成员</option></select>}</div>)}{tree.claims.filter(claim=>claim.status==='PENDING').map(claim=><div className="admin-row" key={claim.id}><span>{claim.user_name||'族人'} 申请认领 {claim.person_name||'人物'}</span><div><button onClick={()=>onManage({action:'REVIEW_CLAIM',claimId:claim.id,decision:'APPROVED'})}>通过</button><button onClick={()=>onManage({action:'REVIEW_CLAIM',claimId:claim.id,decision:'REJECTED'})}>驳回</button></div></div>)}</details>}</div>{generations.map(([number,people])=><section className="generation" key={number}><h2>第{number}代</h2><div className="people-grid">{people.map((person)=><article className="person-card" key={person.id}><div className="avatar">{person.name.slice(-1)}</div><h3>{person.name}</h3><p>{person.birth_year||'出生年份未录'} · {person.gender||'性别未录'}</p>{person.biography&&<blockquote>{person.biography}</blockquote>}<ul>{relationshipText(person).map((text,index)=><li key={index}>{text}</li>)}</ul><div className="person-actions">{canEdit&&<><button onClick={()=>onAdd({direction:'PARENT',reference:person})}>上添父母</button><button onClick={()=>onAdd({direction:'CHILD',reference:person})}>下添子女</button><button onClick={()=>onAdd({direction:'SPOUSE',reference:person})}>添加配偶</button></>} {!person.linked_user_id&&<button onClick={()=>onClaim(person.id)} disabled={tree.claims.some((claim)=>claim.person_id===person.id&&claim.status==='PENDING')}>{tree.claims.some((claim)=>claim.person_id===person.id&&claim.status==='PENDING')?'认领待审核':'认领本人'}</button>}</div></article>)}</div></section>)}</section>;
}
