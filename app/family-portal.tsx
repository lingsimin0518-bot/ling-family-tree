'use client';

import { SyntheticEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import './auth.css';

type User = { id:string; username:string; email:string; phone:string; nickname:string; avatar:string; status:string; systemRole:'USER'|'SUPER_ADMIN' };
type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
type Family = { id:string; name:string; description?:string; join_code:string; source_type:'DATABASE'|'LEGACY_STATIC'; role:Role };
type FamilyLoadState = 'idle' | 'loading' | 'empty' | 'ready' | 'error';
type FormSubmitEvent = SyntheticEvent<HTMLFormElement, SubmitEvent>;

const roleNames:Record<Role,string> = { OWNER:'创建者', ADMIN:'管理员', EDITOR:'编辑成员', VIEWER:'查看成员' };

async function requestJson<T = unknown>(url:string, init?:RequestInit):Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({})) as T & { error?:string; retryAfterSeconds?:number };
  if (!response.ok) {
    const error = new Error(data.error || '操作失败') as Error & { status?:number; retryAfterSeconds?:number };
    error.status = response.status;
    error.retryAfterSeconds = data.retryAfterSeconds ?? Number(response.headers.get('Retry-After') || 0);
    throw error;
  }
  return data;
}
function creationHeaders(idempotencyKey:string) {
  return {'content-type':'application/json','Idempotency-Key':idempotencyKey};
}

export default function FamilyPortal() {
  const [families,setFamilies] = useState<Family[]>([]);
  const [currentId,setCurrentId] = useState('');
  const [showFamilies,setShowFamilies] = useState(false);
  const [showAccount,setShowAccount] = useState(false);
  const [user,setUser] = useState<User|null>(null);
  const [authLoading,setAuthLoading] = useState(true);
  const [familyLoadState,setFamilyLoadState] = useState<FamilyLoadState>('idle');
  const [familyLoadError,setFamilyLoadError] = useState('');
  const [message,setMessage] = useState('');
  const [deleteTarget,setDeleteTarget] = useState<Family|null>(null);
  const [deleteName,setDeleteName] = useState('');
  const [cooldowns,setCooldowns] = useState<Record<string,number>>({});
  const [clock,setClock] = useState(0);
  const current = families.find((family) => family.id === currentId) ?? families[0];
  useEffect(() => {
    if (!Object.values(cooldowns).some((expiresAt) => expiresAt > Date.now())) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldowns]);
  const secondsLeft = (key:string) => Math.max(0,Math.ceil(((cooldowns[key] ?? 0)-clock)/1000));
  const startCooldown = (key:string, seconds=60) => { setClock(Date.now()); setCooldowns((items)=>({...items,[key]:Date.now()+seconds*1000})); };
  const captureCooldown = (key:string,error:unknown) => {
    const seconds = (error as Error & {retryAfterSeconds?:number}).retryAfterSeconds;
    if (seconds) startCooldown(key,seconds);
  };

  const loadFamilies = useCallback(async () => {
    if (!user) return;
    setFamilyLoadState('loading');
    setFamilyLoadError('');
    try {
      const data = await requestJson<{user:unknown;families:Family[]}>('/api/families');
      setFamilies(data.families);
      if (!data.families.length) {
        setCurrentId('');
        setFamilyLoadState('empty');
      } else {
        setCurrentId((selected) => data.families.some((family:Family) => family.id === selected) ? selected : data.families[0].id);
        setFamilyLoadState('ready');
      }
    } catch (error) {
      setFamilies([]);
      setCurrentId('');
      setFamilyLoadError((error as Error).message);
      setFamilyLoadState('error');
    }
  }, [user]);
  useEffect(() => {
    requestJson<{user:User}>('/api/auth/session')
      .then((data)=>setUser(data.user))
      .catch(()=>setUser(null))
      .finally(()=>setAuthLoading(false));
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => {
      if (user) return loadFamilies();
      setFamilies([]);
      setCurrentId('');
      setFamilyLoadState('idle');
    });
  }, [user, loadFamilies]);
  const createFamily = async (event:FormSubmitEvent) => {
    event.preventDefault();
    if (secondsLeft('CREATE_FAMILY')) return;
    const form = new FormData(event.currentTarget);
    try {
      const family = await requestJson<Family>('/api/families',{method:'POST',headers:creationHeaders(crypto.randomUUID()),body:JSON.stringify({action:'CREATE_FAMILY',name:form.get('name'),description:form.get('description')})});
      startCooldown('CREATE_FAMILY'); await loadFamilies(); setCurrentId(family.id); setMessage('空白族谱已创建，请添加第一位初始人物。'); event.currentTarget.reset();
    } catch (error) { captureCooldown('CREATE_FAMILY',error); setMessage((error as Error).message); }
  };
  const joinFamily = async (event:FormSubmitEvent) => {
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
  const logout = async () => {
    try { await requestJson('/api/auth/logout',{method:'POST'}); }
    finally { setUser(null); setCurrentId(''); setFamilyLoadState('idle'); setShowFamilies(false); setMessage('已安全退出登录。'); }
  };

  if (authLoading) return <main className="portal"><LoadingFamilyScreen label="正在加载你的族谱…" /></main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  return <main className="portal">
    <header className="family-bar"><div className="family-current"><span>当前族谱</span><strong>{current?.name ?? '尚未选择族谱'}</strong>{current && <em>{roleNames[current.role]}</em>}</div><div className="account-actions"><span>{user.nickname || user.username || user.phone || '用户'}</span>{user.systemRole==='SUPER_ADMIN'&&<Link className="plain-button" href="/admin">系统后台</Link>}<button className="plain-button" onClick={() => setShowAccount(true)}>账号与安全</button><button className="gold-button" onClick={() => setShowFamilies(true)}>我的族谱</button><button className="plain-button" onClick={logout}>退出登录</button></div></header>
    {message && <button type="button" className="toast" onClick={() => setMessage('')}>{message}<span>×</span></button>}
    {(familyLoadState==='idle' || familyLoadState==='loading') && <LoadingFamilyScreen label="正在加载你的族谱…" />}
    {familyLoadState==='empty' && <FirstUseScreen onCreate={()=>setShowFamilies(true)} onJoin={()=>setShowFamilies(true)} />}
    {familyLoadState==='error' && <LoadErrorScreen detail={familyLoadError} onRetry={()=>void loadFamilies()} />}
    {familyLoadState==='ready' && current && <iframe title={current.name} src={`/family.html?family_id=${encodeURIComponent(current.id)}`} className="legacy-frame" />}
    {showAccount && <AccountSecurity user={user} onClose={()=>setShowAccount(false)} onUser={setUser} />}
    {showFamilies && <div className="veil"><section className="family-dialog"><button className="close" onClick={() => setShowFamilies(false)}>×</button><h2>我的族谱</h2><p>一个账号可以加入多本族谱，切换后所有人物与资料互不混用。</p>
      <div className="family-list">{families.map((family) => <article className={family.id===current?.id?'selected':''} key={family.id}><div><strong>{family.name}</strong><small>{roleNames[family.role]} · 加入码 {family.join_code}</small></div><div className="family-row-actions"><button onClick={() => {setCurrentId(family.id);setShowFamilies(false)}}>{family.id===current?.id?'当前':'切换'}</button>{family.role==='OWNER'&&family.source_type!=='LEGACY_STATIC'&&<button className="danger-link" onClick={()=>{setDeleteTarget(family);setDeleteName('')}}>删除</button>}</div></article>)}</div>
      <div className="family-forms"><form onSubmit={createFamily}><h3>新建空白族谱</h3><input name="name" required placeholder="族谱名称"/><input name="description" placeholder="简介（选填）"/><button disabled={secondsLeft('CREATE_FAMILY')>0}>{secondsLeft('CREATE_FAMILY')>0?`${secondsLeft('CREATE_FAMILY')}秒后可再次创建`:'创建族谱'}</button><small>不会自动生成示例人物。</small></form><form onSubmit={joinFamily}><h3>加入族谱</h3><input name="code" required placeholder="输入8位加入码"/><button>加入族谱</button><small>加入后默认是查看成员。</small></form></div>
      {deleteTarget&&<section className="delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-family-title"><h3 id="delete-family-title">永久删除“{deleteTarget.name}”？</h3><p>人物、关系、公告、媒体和成员权限都会一并删除，无法恢复。请输入完整族谱名称确认：</p><input value={deleteName} onChange={event=>setDeleteName(event.target.value)} placeholder={deleteTarget.name}/><div><button className="cancel-delete" onClick={()=>{setDeleteTarget(null);setDeleteName('')}}>取消</button><button className="confirm-delete" disabled={deleteName!==deleteTarget.name} onClick={deleteSelectedFamily}>确认永久删除</button></div></section>}
    </section></div>}
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
  const [mode,setMode] = useState<'login'|'register'|'reset'>('login');
  const [loginMethod,setLoginMethod] = useState<'username'|'phone-password'|'phone-code'>('username');
  const [error,setError] = useState('');
  const [submitting,setSubmitting] = useState(false);
  const [smsCooldown,setSmsCooldown] = useState(0);
  const [showPassword,setShowPassword] = useState(false);
  const [showConfirmPassword,setShowConfirmPassword] = useState(false);
  useEffect(()=>{
    if (!smsCooldown) return;
    const timer=window.setInterval(()=>setSmsCooldown((value)=>Math.max(0,value-1)),1000);
    return ()=>window.clearInterval(timer);
  },[smsCooldown]);
  const sendCode = async (event:SyntheticEvent<HTMLButtonElement>) => {
    const form=event.currentTarget.form;
    if (!form || smsCooldown) return;
    const values=Object.fromEntries(new FormData(form).entries());
    const purpose=mode==='register'?'REGISTER':mode==='reset'?'RESET_PASSWORD':'LOGIN';
    setError('');
    try {
      const result=await requestJson<{cooldownSeconds:number}>('/api/auth/sms/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:values.phone,purpose})});
      setSmsCooldown(result.cooldownSeconds);
    } catch (sendError) { setError((sendError as Error).message); }
  };
  const submit = async (event:FormSubmitEvent) => {
    event.preventDefault(); setError(''); setSubmitting(true);
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      let endpoint='/api/auth/login';
      if (mode==='register') endpoint='/api/auth/register/phone';
      else if (mode==='reset') endpoint='/api/auth/password/reset';
      else if (loginMethod==='phone-password') endpoint='/api/auth/login/phone-password';
      else if (loginMethod==='phone-code') endpoint='/api/auth/login/phone-code';
      const data = await requestJson<{user:User}>(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});
      onAuthenticated(data.user);
    } catch (submitError) { setError((submitError as Error).message); }
    finally { setSubmitting(false); }
  };
  return <main className="auth-page"><section className="auth-card">
    <p className="auth-eyebrow">记录家族 · 传承记忆</p><h1>家谱</h1>
    <p className="auth-intro">{mode==='login'?'登录后查看和管理您已加入的族谱。':mode==='register'?'使用中国大陆手机号创建账号，真实姓名和族谱资料进入族谱后填写。':'验证已绑定手机号后设置新密码。'}</p>
    <div className="auth-tabs auth-tabs-three"><button type="button" className={mode==='login'?'active':''} onClick={()=>{setMode('login');setError('')}}>登录</button><button type="button" className={mode==='register'?'active':''} onClick={()=>{setMode('register');setError('')}}>手机号注册</button><button type="button" className={mode==='reset'?'active':''} onClick={()=>{setMode('reset');setError('')}}>忘记密码</button></div>
    {mode==='login'&&<div className="auth-methods"><button type="button" className={loginMethod==='username'?'active':''} onClick={()=>setLoginMethod('username')}>用户名</button><button type="button" className={loginMethod==='phone-password'?'active':''} onClick={()=>setLoginMethod('phone-password')}>手机号+密码</button><button type="button" className={loginMethod==='phone-code'?'active':''} onClick={()=>setLoginMethod('phone-code')}>手机号+验证码</button></div>}
    <form className="auth-form" onSubmit={submit}>
      {mode==='login'&&loginMethod==='username'&&<label>用户名<input name="username" required minLength={1} maxLength={32} autoComplete="username" placeholder="兼容原用户名账号" /></label>}
      {(mode!=='login'||loginMethod!=='username')&&<label>中国大陆手机号<input name="phone" required inputMode="numeric" pattern="1[3-9][0-9]{9}" maxLength={11} autoComplete="tel-national" placeholder="例如 13800138000" /><small>当前仅支持中国大陆11位手机号。</small></label>}
      {(mode==='register'||mode==='reset'||loginMethod==='phone-code')&&<label>验证码<div className="sms-code-row"><input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" placeholder="6位验证码"/><button type="button" onClick={sendCode} disabled={smsCooldown>0}>{smsCooldown?`${smsCooldown}秒`:'获取验证码'}</button></div></label>}
      {(mode==='register'||mode==='reset'||(mode==='login'&&loginMethod!=='phone-code'))&&<label><span>{mode==='reset'?'新密码':'密码'}</span><div className="password-control"><input name={mode==='reset'?'newPassword':'password'} required minLength={8} maxLength={128} type={showPassword?'text':'password'} autoComplete={mode==='login'?'current-password':'new-password'} placeholder="至少8个字符" /><button type="button" className="password-toggle" aria-pressed={showPassword} onClick={()=>setShowPassword((visible)=>!visible)}>{showPassword?'隐藏':'显示'}</button></div></label>}
      {mode==='register'&&<>
        <label><span>确认密码</span><div className="password-control"><input name="confirmPassword" required minLength={8} maxLength={128} type={showConfirmPassword?'text':'password'} autoComplete="new-password" /><button type="button" className="password-toggle" aria-pressed={showConfirmPassword} onClick={()=>setShowConfirmPassword((visible)=>!visible)}>{showConfirmPassword?'隐藏':'显示'}</button></div></label>
        <small className="compat-note">原“用户名+密码”注册接口暂时保留用于兼容，但新用户请使用手机号注册。</small>
      </>}
      {error&&<p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" disabled={submitting}>{submitting?'请稍候…':mode==='register'?'注册并登录':mode==='reset'?'重置密码并登录':'登录'}</button>
    </form>
    <small className="auth-note">密码经过加盐哈希后保存，网站不会存储明文密码。</small>
  </section></main>;
}

function AccountSecurity({user,onClose,onUser}:{user:User;onClose:()=>void;onUser:(user:User)=>void}) {
  const [step,setStep]=useState<'bind'|'old'|'new'>(user.phone?'old':'bind');
  const [changeToken,setChangeToken]=useState('');
  const [message,setMessage]=useState('');
  const [cooldown,setCooldown]=useState(0);
  useEffect(()=>{if(!cooldown)return;const timer=window.setInterval(()=>setCooldown((value)=>Math.max(0,value-1)),1000);return()=>window.clearInterval(timer)},[cooldown]);
  const send=async(event:SyntheticEvent<HTMLButtonElement>,purpose:'BIND_PHONE'|'CHANGE_PHONE')=>{
    const form=event.currentTarget.form;if(!form||cooldown)return;
    const values=Object.fromEntries(new FormData(form).entries());
    try{const currentPhone=user.phone.startsWith('+86')?user.phone.slice(3):user.phone;const result=await requestJson<{cooldownSeconds:number}>('/api/auth/sms/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:values.phone||currentPhone,purpose,changeToken:step==='new'?changeToken:undefined})});setCooldown(result.cooldownSeconds);setMessage('验证码已发送。')}
    catch(error){setMessage((error as Error).message)}
  };
  const submit=async(event:FormSubmitEvent)=>{
    event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      if(step==='bind'){await requestJson('/api/account/phone/bind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});const fresh=await requestJson<{user:User}>('/api/auth/session');onUser(fresh.user);setMessage('手机号已绑定。')}
      else if(step==='old'){const result=await requestJson<{changeToken:string}>('/api/account/phone/change/verify-old',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});setChangeToken(result.changeToken);setStep('new');setCooldown(0);setMessage('原手机号验证通过，请验证新手机号。')}
      else{await requestJson('/api/account/phone/change/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...values,newPhone:values.phone,changeToken})});const fresh=await requestJson<{user:User}>('/api/auth/session');onUser(fresh.user);setMessage('手机号已更换。');setStep('old')}
    }catch(error){setMessage((error as Error).message)}
  };
  return <div className="veil"><section className="family-dialog account-dialog"><button className="close" onClick={onClose}>×</button><h2>账号与安全</h2><p>手机号：{user.phone?`${user.phone.slice(3,6)}****${user.phone.slice(-4)}`:'尚未绑定'}</p>
    <form className="auth-form" onSubmit={submit}>
      {step==='old'?<p>先验证当前手机号，再设置新手机号。</p>:<label>{step==='new'?'新手机号':'手机号'}<input name="phone" required inputMode="numeric" pattern="1[3-9][0-9]{9}" maxLength={11} placeholder="11位中国大陆手机号"/></label>}
      <label>验证码<div className="sms-code-row"><input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6}/><button type="button" disabled={cooldown>0} onClick={(event)=>send(event,step==='bind'?'BIND_PHONE':'CHANGE_PHONE')}>{cooldown?`${cooldown}秒`:'获取验证码'}</button></div></label>
      {step==='bind'&&!user.username&&<label>设置密码（选填）<input name="password" type="password" minLength={8}/></label>}
      {message&&<output className="auth-error">{message}</output>}
      <button className="auth-submit">{step==='bind'?'绑定手机号':step==='old'?'验证原手机号':'确认更换手机号'}</button>
    </form>
  </section></div>;
}
