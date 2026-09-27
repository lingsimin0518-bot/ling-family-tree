import { createHmac, createHash, webcrypto } from 'node:crypto';
import { canonicalizeAliyunQuery, createAliyunAcs3Request } from '../../lib/aliyun-openapi.ts';
import { AliyunSmsAuthenticationProvider, mapAliyunSmsError } from '../../lib/aliyun-sms-authentication.ts';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const ok=(condition,label)=>{if(!condition)throw new Error(`FAIL: ${label}`);console.log(`PASS: ${label}`)};
ok(canonicalizeAliyunQuery({PhoneNumber:'13800138000',OutId:'a b~c'})==='OutId=a%20b~c&PhoneNumber=13800138000','canonical query RFC3986 and sorting');
const signed=await createAliyunAcs3Request({endpoint:'https://dypnsapi.aliyuncs.com',accessKeyId:'test-id',accessKeySecret:'test-secret',action:'SendSmsVerifyCode',version:'2017-05-25',query:{PhoneNumber:'13800138000'},date:new Date('2026-01-02T03:04:05Z'),nonce:'fixed-nonce'});
const expected=createHmac('sha256','test-secret').update(`ACS3-HMAC-SHA256\n${createHash('sha256').update(signed.canonicalRequest).digest('hex')}`).digest('hex');
ok(signed.init.headers.authorization.endsWith(`Signature=${expected}`),'ACS3 signature matches independent reference');
ok(!signed.url.includes('test-secret'),'secret absent from URL');
class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){if(this.sql.includes('created_at FROM'))return null;if(this.sql.includes('COUNT(*)'))return{total:0};if(this.sql.includes('provider_challenge_id'))return this.db.rows.find((r)=>r.phone_e164===this.args[0]&&r.purpose===this.args[1]&&!r.used_at)??null;return null}async run(){if(this.sql.includes('INSERT INTO sms_verifications')){const[id,phone_e164,purpose,expires_at,created_at,requested_ip_hash,provider_request_id,provider_challenge_id]=this.args;this.db.rows.push({id,phone_e164,purpose,expires_at,created_at,requested_ip_hash,provider_request_id,provider_challenge_id,attempt_count:0,max_attempts:5,used_at:null,provider:'ALIYUN_SMS_AUTH',provider_status:'ACCEPTED'});return{meta:{changes:1}}}const row=this.db.rows.find((r)=>r.id===this.args.at(-1)||r.id===this.args[2]);if(!row)return{meta:{changes:0}};if(this.sql.includes("provider_status='INVALID'")){row.attempt_count+=1;row.provider_status='INVALID'}if(this.sql.includes("provider_status='VERIFIED'")){row.used_at=this.args[0];row.provider_status='VERIFIED'}return{meta:{changes:1}}}}
class FakeDb{constructor(){this.rows=[]}prepare(sql){return new Statement(this,sql)}}
const settings={ALIYUN_SMS_ACCESS_KEY_ID:'id',ALIYUN_SMS_ACCESS_KEY_SECRET:'secret-secret',ALIYUN_SMS_SIGNATURE:'家谱',ALIYUN_SMS_TEMPLATE_REGISTER:'TPL_REGISTER',ALIYUN_SMS_TEMPLATE_LOGIN:'TPL_LOGIN',ALIYUN_SMS_TEMPLATE_RESET_PASSWORD:'TPL_RESET',ALIYUN_SMS_TEMPLATE_BIND_PHONE:'TPL_BIND',ALIYUN_SMS_TEMPLATE_CHANGE_PHONE:'TPL_CHANGE'};
const calls=[];const fetcher=async(url,init)=>{calls.push(new URL(url));const action=init.headers['x-acs-action'];return Response.json(action==='CheckSmsVerifyCode'?{Code:'OK',Success:true,RequestId:'check-request',Model:{VerifyResult:'PASS'}}:{Code:'OK',Success:true,RequestId:'send-request',Model:{OutId:calls.at(-1).searchParams.get('OutId')}})};
const db=new FakeDb();const provider=new AliyunSmsAuthenticationProvider(settings,fetcher);
const sent=await provider.sendCode({db,phoneE164:'+8613800138000',purpose:'REGISTER',requestedIpHash:'ip',now:new Date('2026-01-01T00:00:00Z')});
ok(sent.provider==='ALIYUN_SMS_AUTH'&&db.rows[0].provider_request_id==='send-request','provider request id persisted');
ok(calls[0].searchParams.get('TemplateCode')==='TPL_REGISTER'&&calls[0].searchParams.get('ReturnVerifyCode')==='false','SendSmsVerifyCode uses provider-generated code');
let isolated=false;try{await provider.verifyCode({db,phoneE164:'+8613800138000',purpose:'LOGIN',code:'123456',now:new Date('2026-01-01T00:01:00Z')})}catch(error){isolated=error.code==='SMS_CODE_INVALID'}ok(isolated,'purpose isolation enforced before provider call');
await provider.verifyCode({db,phoneE164:'+8613800138000',purpose:'REGISTER',code:'123456',now:new Date('2026-01-01T00:01:00Z')});
ok(db.rows[0].provider_status==='VERIFIED'&&Boolean(db.rows[0].used_at),'CheckSmsVerifyCode consumes challenge');
ok(mapAliyunSmsError('FREQUENCY_FAIL').code==='SMS_TOO_FREQUENT','frequency error mapping');
ok(mapAliyunSmsError('SYSTEM_ERROR').code==='SMS_PROVIDER_UNAVAILABLE','availability error mapping');
ok(mapAliyunSmsError('INVALID_PARAMETER').code==='SMS_PROVIDER_REJECTED','rejection error mapping');
console.log('PASS: no network call performed');
