const required = [
  'SMS_MODE',
  'ALIYUN_SMS_ACCESS_KEY_ID',
  'ALIYUN_SMS_ACCESS_KEY_SECRET',
  'ALIYUN_SMS_SIGNATURE',
  'ALIYUN_SMS_TEMPLATE_REGISTER',
  'ALIYUN_SMS_TEMPLATE_LOGIN',
  'ALIYUN_SMS_TEMPLATE_RESET_PASSWORD',
  'ALIYUN_SMS_TEMPLATE_BIND_PHONE',
  'ALIYUN_SMS_TEMPLATE_CHANGE_PHONE',
  'ALIYUN_SMS_TEST_ENABLED',
  'ALIYUN_SMS_TEST_PHONE_E164',
  'ALIYUN_SMS_TEST_CYCLE_ID',
];

let failed = false;
for (const name of required) {
  const present = typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
  console.log(`${present ? 'PASS' : 'MISSING'} ${name}`);
  failed ||= !present;
}

const modeValid = process.env.SMS_MODE === 'aliyun';
console.log(`${modeValid ? 'PASS' : 'INVALID'} SMS_MODE must equal aliyun`);
failed ||= !modeValid;

const endpoint = process.env.ALIYUN_SMS_ENDPOINT || 'https://dypnsapi.aliyuncs.com';
const endpointValid = endpoint === 'https://dypnsapi.aliyuncs.com';
console.log(`${endpointValid ? 'PASS' : 'INVALID'} ALIYUN_SMS_ENDPOINT`);
failed ||= !endpointValid;

const region = process.env.ALIYUN_SMS_REGION_ID || 'cn-hangzhou';
console.log(`PASS ALIYUN_SMS_REGION_ID configured/defaulted (${region === 'cn-hangzhou' ? 'recommended default' : 'custom value'})`);
console.log('PASS Secret values were not printed; no network request was made');
if (failed) process.exitCode = 1;
