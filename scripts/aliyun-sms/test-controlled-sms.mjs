import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { assertControlledSmsTestAdministrator, controlledSmsTestStatus, sendControlledSmsTest, verifyControlledSmsTest } from '../../lib/controlled-sms-test.ts';
if (!globalThis.crypto) globalThis.crypto=webcrypto;
const ok=(condition,label)=>{if(!condition)throw new Error(`FAIL: ${label}`);console.log(`PASS: ${label}`)};
async function responseStatus(operation){try{await operation();return 200}catch(error){return error instanceof Response?error.status:500}}
class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){if(this.sql.includes('FROM action_idempotency'))return this.db.actions.find((row)=>row.actor_key===this.args[0]&&row.action_type===this.args[1]&&row.idempotency_key===this.args[2])??null;return null}async run(){if(this.sql.includes('INSERT INTO action_idempotency')){if(this.db.actions.some((row)=>row.idempotency_key===this.args[3]))throw new Error('UNIQUE');const[id,actor_key,action_type,idempotency_key,response_json,created_at]=this.args;this.db.actions.push({id,actor_key,family_key:'',action_type,idempotency_key,status:'PENDING',response_json,created_at});return{meta:{changes:1}}}if(this.sql.includes("status='COMPLETED'")){const row=this.db.actions.find((item)=>item.id===this.args[2]&&item.status==='PENDING');if(!row)return{meta:{changes:0}};row.status='COMPLETED';row.response_json=this.args[0];return{meta:{changes:1}}}if(this.sql.includes('WHERE id=? AND response_json=?')){const row=this.db.actions.find((item)=>item.id===this.args[2]&&item.response_json===this.args[3]);if(!row)return{meta:{changes:0}};row.response_json=this.args[0];return{meta:{changes:1}}}return{meta:{changes:0}}}}
class FakeDb{constructor(){this.actions=[];this.users=[];this.identities=[];this.sessions=[]}prepare(sql){return new Statement(this,sql)}}
const base={enabled:true,smsMode:'aliyun',phoneE164:'+8613800138000',cycleId:'cycle_20260927'};
ok(await responseStatus(async()=>assertControlledSmsTestAdministrator({systemRole:'USER'}))===403,'non-SUPER_ADMIN rejected');
assertControlledSmsTestAdministrator({systemRole:'SUPER_ADMIN'});ok(true,'SUPER_ADMIN accepted');
const provider={sendCalls:0,verifyCalls:0,async sendCode(input){this.sendCalls+=1;ok(input.purpose==='REGISTER','send purpose fixed REGISTER');return{cooldownSeconds:60,expiresInSeconds:300,provider:'ALIYUN_SMS_AUTH',providerChallengeId:'challenge',acceptedAt:new Date().toISOString(),providerStatus:'ACCEPTED'}},async verifyCode(input){this.verifyCalls+=1;ok(input.purpose==='REGISTER','verify purpose fixed REGISTER')}};
ok(await responseStatus(()=>controlledSmsTestStatus(new FakeDb(),{...base,enabled:false}))===404,'disabled gate');
ok(await responseStatus(()=>controlledSmsTestStatus(new FakeDb(),{...base,smsMode:'mock'}))===503,'aliyun-only gate');
ok(await responseStatus(()=>controlledSmsTestStatus(new FakeDb(),{...base,phoneE164:''}))===503,'missing whitelist gate');
const db=new FakeDb();const before=[db.users.length,db.identities.length,db.sessions.length];
const sent=await sendControlledSmsTest({db,config:base,provider,requestedIpHash:'test-ip'});
ok(sent.phone==='138****8000'&&!JSON.stringify(sent).includes('+8613800138000'),'full phone not exposed');
ok(provider.sendCalls===1,'first send succeeds exactly once');
ok(await responseStatus(()=>sendControlledSmsTest({db,config:base,provider,requestedIpHash:'test-ip'}))===409&&provider.sendCalls===1,'second send rejected without provider call');
const verified=await verifyControlledSmsTest({db,config:base,provider,code:'123456'});
ok(verified.state==='VERIFIED'&&provider.verifyCalls===1,'verify succeeds');
ok(await responseStatus(()=>verifyControlledSmsTest({db,config:base,provider,code:'123456'}))===409&&provider.verifyCalls===1,'repeated consume rejected');
ok(before.join(',')===[db.users.length,db.identities.length,db.sessions.length].join(','),'no user identity or session created');
const failureDb=new FakeDb();const failing={...provider,async sendCode(){throw new Error('provider failed')}};
ok(await responseStatus(()=>sendControlledSmsTest({db:failureDb,config:{...base,cycleId:'failure_cycle'},provider:failing,requestedIpHash:'ip'}))===500,'provider failure returned as failure');
ok((await controlledSmsTestStatus(failureDb,{...base,cycleId:'failure_cycle'})).state==='NOT_SENT','provider failure not marked SENT');
ok(await responseStatus(()=>sendControlledSmsTest({db:failureDb,config:{...base,cycleId:'failure_cycle'},provider:failing,requestedIpHash:'ip'}))===409,'ambiguous failed cycle remains locked');
const routeRoot=resolve('app/api/admin/test-sms');
for(const route of ['send/route.ts','verify/route.ts','status/route.ts']){const source=await readFile(resolve(routeRoot,route),'utf8');ok(source.includes('requireSuperAdmin(request)'),`${route} requires SUPER_ADMIN`)}
console.log('PASS: controlled SMS test channel; no network call performed');
