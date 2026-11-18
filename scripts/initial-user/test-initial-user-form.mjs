import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(join(root, 'app/maintenance-admin/initial-user-form.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const require = createRequire(import.meta.url);
const projectId = 'appgprj_local_initial_user_form';
const secret = randomBytes(32).toString('hex');
const password = `fixture-${randomBytes(12).toString('hex')}`;
const valid = [projectId, 'initial_local', password, password, 'local@example.test', secret, false, '', null];
let assertions = 0;
function check(value, label) { if (!value) throw new Error(`FAIL ${label}`); assertions += 1; console.log(`PASS ${label}`); }
function render(states = [], pending = { current: false }) {
  let index = 0;
  const updates = [];
  const effects = [];
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports,
    require: (name) => name === 'react' ? {
      useState: (initial) => { const slot = index++; return [states[slot] ?? initial, (value) => updates.push({ slot, value })]; },
      useRef: () => pending, useEffect: (effect) => effects.push(effect),
    } : require(name), fetch: (...args) => globalThis.fetch(...args) });
  return { tree: compiledModule.exports.default(), updates, effects };
}
function find(node, test) {
  if (Array.isArray(node)) return node.flatMap((item) => find(item, test));
  if (!node || typeof node !== 'object') return [];
  return [...(test(node) ? [node] : []), ...find(node.props?.children, test)];
}
function form(result) { return find(result.tree, (node) => node.type === 'form')[0]; }
const originalFetch = globalThis.fetch;
try {
  const empty = render();
  check(empty.tree === null, '安全状态未确认前不显示任何注册表单');
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ code: 'INITIAL_USER_REGISTRATION_DISABLED' }) });
  empty.effects[0](); await new Promise((done) => setImmediate(done));
  check(!empty.updates.some((item) => item.slot === 0 && item.value), '关闭状态不开放表单');
  const ready = render();
  let availabilityRequest;
  globalThis.fetch = async (...args) => { availabilityRequest = args; return { ok: true, json: async () => ({ available: true, projectId, runtimeDeploymentVerification: 'UNAVAILABLE' }) }; };
  ready.effects[0](); await new Promise((done) => setImmediate(done));
  check(ready.updates.some((item) => item.slot === 0 && item.value === projectId), '只接受服务端空库可用状态');
  check(availabilityRequest[0] === '/api/admin/operations/initial-user' && availabilityRequest[1].method === 'POST'
    && availabilityRequest[1].headers['X-Initial-User-Availability-Check'] === 'v1'
    && !availabilityRequest[1].headers['X-Initial-User-Registration-Secret'] && availabilityRequest[1].body === '{}', '可用性检查只发空体固定标记，不携带Secret或账号参数');
  const blank = render([projectId]);
  const secretInput = find(blank.tree, (node) => node.props?.id === 'initial-registration-secret')[0];
  check(secretInput.props.type === 'password' && secretInput.props.value === '' && secretInput.props.autoComplete === 'new-password', 'Secret空白、掩码且不预填');
  check(find(blank.tree, (node) => node.type === 'button')[0].props.disabled === true, '未填信息不能提交');
  check(!/localStorage|sessionStorage|indexedDB|document\.cookie|console\./.test(source), '表单不持久化或记录Secret');

  let requests = [];
  let release;
  globalThis.fetch = async (...args) => { requests.push(args); return new Promise((done) => { release = done; }); };
  const pending = { current: false };
  const active = render(valid, pending);
  const submit = form(active).props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  check(requests.length === 1 && pending.current === true, '快速双击只发送一次请求');
  const [url, options] = requests[0];
  const body = JSON.parse(options.body);
  check(url === '/api/admin/operations/initial-user' && options.credentials === 'same-origin'
    && options.cache === 'no-store' && options.headers['X-Initial-User-Registration-Secret'] === secret
    && !Object.values(body).includes(secret), 'Secret仅经同源请求Header传递');
  check(Object.keys(body).sort().join(',') === 'confirmPassword,email,password,projectId,username', '请求不接受指定user_id或角色');
  release({ status: 403, json: async () => ({ code: 'INITIAL_USER_SECRET_INVALID' }) });
  await first;
  check([2, 3, 5].every((slot) => active.updates.some((item) => item.slot === slot && item.value === '')), '失败后立即清空Secret和两个密码字段');
  check(requests.length === 1, '失败不自动重试');

  requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); return { status: 201, json: async () => ({ ok: true,
    user: { id: '00000000-0000-4000-8000-000000000001', username: 'initial_local', system_role: 'USER', status: 'ACTIVE', password_hash: 'never-display' } }) }; };
  const success = render(valid);
  await form(success).props.onSubmit({ preventDefault() {} });
  check(requests.length === 1 && [2, 3, 5].every((slot) => success.updates.some((item) => item.slot === slot && item.value === '')), '成功后Secret和密码全部清空');
  const account = success.updates.find((item) => item.slot === 8)?.value;
  check(Object.keys(account).sort().join(',') === 'id,status,system_role,username' && account.system_role === 'USER', '成功只保留安全的普通账号结果');
  const result = render([null, '', '', '', '', '', false, '', account]);
  check(!form(result) && !JSON.stringify(result.tree).includes('never-display'), '成功后不再提供创建表单或显示哈希');
  globalThis.fetch = async () => { throw new Error('simulated local transport failure'); };
  const unknown = render(valid);
  await form(unknown).props.onSubmit({ preventDefault() {} });
  check(unknown.updates.some((item) => item.slot === 0 && item.value === null)
    && unknown.updates.some((item) => item.slot === 5 && item.value === ''), '网络结果不明时关闭表单并清空Secret，不重试');
} finally { globalThis.fetch = originalFetch; }
console.log(`PASS initial-user form: ${assertions} checks; fake HTTP only.`);
