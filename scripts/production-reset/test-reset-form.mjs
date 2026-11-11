import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(join(root, 'app/maintenance-admin/reset-form.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const require = createRequire(import.meta.url);
const projectId = 'appgprj_local_reset_form_test';
const target = { projectId, databaseBinding: 'DB', schema: '0010', sitesVersion: 43,
  deploymentId: 'appgdep_localtest1234567890', backupSha256: 'A'.repeat(64) };
const confirmation = `RESET_ALL_BUSINESS_DATA:${projectId}`;

function render(states) {
  let index = 0;
  const updates = [];
  const compiledModule = { exports: {} };
  const localRequire = (name) => name === 'react'
    ? { useState: (initial) => { const slot = index++; return [states[slot] ?? initial,
      (value) => updates.push({ slot, value })]; } }
    : require(name);
  vm.runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports,
    require: localRequire, window: globalThis.window, fetch: (...args) => globalThis.fetch(...args) });
  return { tree: compiledModule.exports.default({ target }), updates };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((item) => find(item, predicate));
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)];
}

function check(condition, label) {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}

const empty = render([]).tree;
const password = find(empty, (node) => node.type === 'input' && node.props.type === 'password')[0];
const button = find(empty, (node) => node.type === 'button' && node.props.type === 'submit')[0];
check(password?.props.value === '' && password.props.autoComplete === 'new-password', 'Secret 默认空白且禁止自动填充');
check(button?.props.disabled === true, '未填写四项时按钮禁用');
check(find(empty, (node) => node.type === 'form')[0]?.props.autoComplete === 'off', '表单不请求浏览器自动填充');

const valid = ['local-test-secret', confirmation, target.backupSha256, projectId, false, ''];
for (let field = 0; field < 4; field++) {
  const wrong = [...valid];
  wrong[field] = field === 0 ? '' : 'wrong';
  check(find(render(wrong).tree, (node) => node.type === 'button')[0].props.disabled === true,
    `第 ${field + 1} 项无效时按钮禁用`);
}
check(find(render(valid).tree, (node) => node.type === 'button')[0].props.disabled === false,
  '四项精确匹配时按钮可用');

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
try {
  let requests = [];
  globalThis.window = { confirm: () => false };
  globalThis.fetch = async (...args) => { requests.push(args); throw new Error('cancelled action must not fetch'); };
  const cancelled = render(valid);
  await find(cancelled.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  check(requests.length === 0 && cancelled.updates.some((item) => item.slot === 0 && item.value === ''),
    '二次确认取消时不发送请求并清空Secret');

  requests = [];
  globalThis.window.confirm = () => true;
  globalThis.fetch = async (...args) => {
    requests.push(args);
    return { ok: false, status: 403, json: async () => ({ code: 'RESET_SECRET_INVALID' }) };
  };
  const rejected = render(valid);
  await find(rejected.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const [url, options] = requests[0] ?? [];
  const body = options && JSON.parse(options.body);
  check(requests.length === 1 && url === '/api/admin/operations/production-reset'
    && options.credentials === 'same-origin' && options.headers['X-Production-Reset-Secret'] === valid[0]
    && !Object.values(body).includes(valid[0]), '只向同源现有API发送一次请求，Secret仅在Header');
  check(rejected.updates.some((item) => item.slot === 0 && item.value === ''), '失败响应后清空Secret');
  check(!/localStorage|sessionStorage|indexedDB|document\.cookie|console\./.test(source),
    '表单不写持久存储、Cookie或控制台');
} finally {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
}
