import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.npm_execpath;
if (!cli) throw new Error('请通过 pnpm test:phone-auth 运行测试');
const work = await mkdtemp(join(tmpdir(), 'phone-auth-'));
const state = join(work, 'state');
const config = join(work, 'wrangler.json');
const port = 8799;
const origin = `http://127.0.0.1:${port}`;
await writeFile(config, JSON.stringify({
  name: 'phone-auth-test', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'],
  main: join(root, 'dist/server/index.js'), assets: { directory: join(root, 'dist/client') },
  vars: { SMS_MODE: 'mock', APP_ENV: 'test', SMS_CODE_PEPPER: 'phone-auth-test-pepper-at-least-32-characters' },
  d1_databases: [{ binding: 'DB', database_name: 'phone-auth-test', database_id: '00000000-0000-4000-8000-000000000000' }],
}));

function run(args) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID;
  const result = spawnSync(process.execPath, [cli, 'exec', 'wrangler', ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
const d1 = ['d1','execute','phone-auth-test','--local','--config',config,'--persist-to',state];
for (const file of ['0000_multi_family.sql','0001_real_user_auth.sql','0002_wechat_identity.sql','0003_system_admin.sql','0004_unified_person_operations.sql','0005_creation_cooldown.sql','0006_collaboration_persistence.sql','0007_auth_identity_foundation.sql','0008_phone_change_challenges.sql','0009_aliyun_sms_provider.sql']) {
  run([...d1,'--file',join(root,'drizzle',file)]);
}

const wranglerCli=join(root,'node_modules','wrangler','bin','wrangler.js');
const server = spawn(process.execPath,[wranglerCli,'dev','--config',config,'--persist-to',state,'--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env}});
let serverOutput=''; server.stdout.on('data',(chunk)=>serverOutput+=chunk); server.stderr.on('data',(chunk)=>serverOutput+=chunk);
const pause=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
for(let attempt=0;attempt<40;attempt+=1){try{const response=await fetch(origin);if(response.status<500)break}catch{}await pause(250);if(attempt===39)throw new Error(`本地服务未启动：${serverOutput}`)}

async function post(path,body,cookie=''){
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]??''};
}
function ok(value,label){if(!value)throw new Error(`FAIL ${label}`);console.log(`PASS ${label}`)}
function sql(command){return run([...d1,'--command',command,'--json'])}
function ageCodes(phone){sql(`UPDATE sms_verifications SET created_at='2020-01-01T00:00:00Z' WHERE phone_e164='${phone}'`) }

try{
  const invalid=await post('/api/auth/sms/send',{phone:'+819012345678',purpose:'REGISTER'}); ok(invalid.status===400,'非中国号码拒绝');
  let response=await post('/api/auth/sms/send',{phone:'13800138000',purpose:'REGISTER'}); ok(response.status===200,'REGISTER验证码发送');
  const cooldown=await post('/api/auth/sms/send',{phone:'13800138000',purpose:'REGISTER'}); ok(cooldown.status===429,'60秒冷却');
  response=await post('/api/auth/register/phone',{phone:'13800138000',code:'123456',password:'password-1',confirmPassword:'password-1'}); ok(response.status===201,'手机号验证码注册');
  const userId=response.data.user.id; let userCookie=response.cookie;
  ok(response.data.user.username==='', '手机号用户username为空');
  const created=sql(`SELECT u.id,u.phone,u.phone_verified_at,i.provider_user_id FROM users u JOIN user_identities i ON i.user_id=u.id WHERE u.id='${userId}'`); ok(created.includes('+8613800138000'),'PHONE identity与兼容字段写入');
  response=await post('/api/auth/register/phone',{phone:'13800138000',code:'123456',password:'password-1'}); ok(response.status===409,'重复手机号注册拒绝');
  response=await post('/api/auth/login/phone-password',{phone:'13800138000',password:'password-1'}); ok(response.status===200,'手机号密码登录');
  const wrong=await post('/api/auth/login/phone-password',{phone:'13800138000',password:'wrong-password'}); ok(wrong.status===401,'错误密码拒绝');

  ageCodes('+8613800138000'); response=await post('/api/auth/sms/send',{phone:'13800138000',purpose:'LOGIN'}); ok(response.status===200,'LOGIN验证码发送');
  response=await post('/api/auth/login/phone-code',{phone:'13800138000',code:'123456'}); ok(response.status===200,'手机号验证码登录');
  const noAccountPhone='13500135000'; await post('/api/auth/sms/send',{phone:noAccountPhone,purpose:'LOGIN'}); response=await post('/api/auth/login/phone-code',{phone:noAccountPhone,code:'123456'}); ok(response.status===401,'LOGIN验证码不自动注册');
  ageCodes('+8613500135000'); await post('/api/auth/sms/send',{phone:noAccountPhone,purpose:'REGISTER'}); response=await post('/api/auth/login/phone-code',{phone:noAccountPhone,code:'123456'}); ok(response.status===400,'REGISTER验证码不能用于LOGIN');
  ageCodes('+8613500135000'); await post('/api/auth/sms/send',{phone:noAccountPhone,purpose:'LOGIN'}); response=await post('/api/auth/password/reset',{phone:noAccountPhone,code:'123456',newPassword:'password-x'}); ok(response.status===400,'LOGIN验证码不能用于RESET_PASSWORD');

  ageCodes('+8613800138000'); await post('/api/auth/sms/send',{phone:'13800138000',purpose:'RESET_PASSWORD'}); const oldCookie=userCookie;
  response=await post('/api/auth/password/reset',{phone:'13800138000',code:'123456',newPassword:'password-2'}); ok(response.status===200,'重置密码成功'); userCookie=response.cookie;
  ok((await post('/api/auth/login/phone-password',{phone:'13800138000',password:'password-1'})).status===401,'旧密码失效');
  ok((await fetch(origin+'/api/auth/session',{headers:{cookie:oldCookie}})).status===401,'旧session失效');
  ok((await fetch(origin+'/api/auth/session',{headers:{cookie:userCookie}})).status===200,'重置后新session建立');

  response=await post('/api/auth/register',{username:'wechat_mock',password:'password-3',confirmPassword:'password-3',email:'mock@example.com'}); ok(response.status===201,'兼容注册创建无手机号用户'); const bindCookie=response.cookie;
  await post('/api/auth/sms/send',{phone:'13400134000',purpose:'BIND_PHONE'},bindCookie);
  response=await post('/api/account/phone/bind',{phone:'13400134000',code:'123456'},bindCookie); ok(response.status===200,'无手机号User绑定手机号');
  ageCodes('+8613400134000'); await post('/api/auth/sms/send',{phone:'13400134000',purpose:'BIND_PHONE'},userCookie);
  response=await post('/api/account/phone/bind',{phone:'13400134000',code:'123456'},userCookie); ok(response.status===409,'已绑定手机号不能被其他User绑定');

  ageCodes('+8613800138000'); await post('/api/auth/sms/send',{phone:'13800138000',purpose:'CHANGE_PHONE'},userCookie);
  response=await post('/api/account/phone/change/verify-old',{code:'123456'},userCookie); ok(response.status===200&&response.data.changeToken,'更换手机号验证旧号'); const changeToken=response.data.changeToken;
  await post('/api/auth/sms/send',{phone:'13300133000',purpose:'CHANGE_PHONE',changeToken},userCookie);
  response=await post('/api/account/phone/change/confirm',{newPhone:'13300133000',code:'123456',changeToken},userCookie); ok(response.status===200,'更换手机号验证新号');
  ok((await post('/api/auth/login/phone-password',{phone:'13800138000',password:'password-2'})).status===401,'换号后旧手机号不能登录');
  response=await post('/api/auth/login/phone-password',{phone:'13300133000',password:'password-2'}); ok(response.status===200&&response.data.user.id===userId,'新手机号登录且user_id不变');

  response=await post('/api/auth/sms/send',{phone:'13900139000',purpose:'LOGIN'}); ok(response.status===200,'过期测试码创建');
  response=await post('/api/auth/login/phone-code',{phone:'13900139000',code:'123456'}); ok(response.status===400,'过期验证码拒绝');
  response=await post('/api/auth/sms/send',{phone:'13600136000',purpose:'REGISTER'}); ok(response.status===429,'手机号限流');
  const recent=new Date(Date.now()-10*60_000).toISOString();
  for(let i=0;i<5;i+=1) sql(`INSERT INTO sms_verifications(id,phone_e164,purpose,code_hash,expires_at,attempt_count,max_attempts,created_at) VALUES('hour-${i}','+8613200132000','LOGIN','test','2099-01-01T00:00:00Z',0,5,'${recent}')`);
  response=await post('/api/auth/sms/send',{phone:'13200132000',purpose:'LOGIN'}); ok(response.status===429,'同手机号小时限流');
  const today=new Date(Date.now()-2*60*60_000).toISOString();
  for(let i=0;i<10;i+=1) sql(`INSERT INTO sms_verifications(id,phone_e164,purpose,code_hash,expires_at,attempt_count,max_attempts,created_at) VALUES('day-${i}','+8613100131000','LOGIN','test','2099-01-01T00:00:00Z',0,5,'${today}')`);
  response=await post('/api/auth/sms/send',{phone:'13100131000',purpose:'LOGIN'}); ok(response.status===429,'同手机号每日限流');

  ageCodes('+8613300133000'); await post('/api/auth/sms/send',{phone:'13300133000',purpose:'LOGIN'});
  for(let i=0;i<5;i+=1) await post('/api/auth/login/phone-code',{phone:'13300133000',code:'000000'});
  response=await post('/api/auth/login/phone-code',{phone:'13300133000',code:'123456'}); ok(response.status===400,'最大尝试次数生效');
  ageCodes('+8613300133000'); await post('/api/auth/sms/send',{phone:'13300133000',purpose:'LOGIN'});
  const concurrent=await Promise.all([post('/api/auth/login/phone-code',{phone:'13300133000',code:'123456'}),post('/api/auth/login/phone-code',{phone:'13300133000',code:'123456'})]);
  ok(concurrent.filter((item)=>item.status===200).length===1,'验证码并发仅消费一次');

  sql("INSERT INTO users(id,username,password_hash,email,phone,nickname,avatar,status,system_role,display_name,created_at,updated_at) SELECT 'legacy-admin','legacy_admin',password_hash,NULL,NULL,'Admin','', 'ACTIVE','SUPER_ADMIN','Admin','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM users WHERE id='"+userId+"'");
  response=await post('/api/auth/login',{username:'legacy_admin',password:'password-2'}); ok(response.status===200&&response.data.user.systemRole==='SUPER_ADMIN','旧username登录与SUPER_ADMIN不受影响');
  console.log('PASS：手机号认证 Mock 闭环测试全部通过。');
} finally {
  server.kill();
  server.stdout.destroy();
  server.stderr.destroy();
  server.unref();
}
run([...d1,'--file',join(root,'db','rollback','0009_aliyun_sms_provider.rollback.sql')]);
const providerColumnCheck=sql("SELECT COUNT(*) total FROM pragma_table_info('sms_verifications') WHERE name='provider'");
ok(providerColumnCheck.includes('"total": 0')||providerColumnCheck.includes('"total":0'),'0009 rollback');
run([...d1,'--file',join(root,'db','rollback','0008_phone_change_challenges.rollback.sql')]);
const rollbackCheck=sql("SELECT COUNT(*) total FROM sqlite_schema WHERE type='table' AND name='phone_change_challenges'");
ok(rollbackCheck.includes('"total": 0')||rollbackCheck.includes('"total":0'),'0008 rollback');
