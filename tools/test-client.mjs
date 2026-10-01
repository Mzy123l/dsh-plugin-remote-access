// test-client.mjs —— 用极简 React / 宿主桩子把 client.js 真跑一遍（不需要 DSH、不需要浏览器）。
//
// 为什么需要它：client.js 的错误以前只有「装到手机上」才暴露（比如把 ctx.remote.* 返回的
// RemoteResult 信封当成裸数据用 → 页面全空/全 0）。这里把插件注册、组件渲染、改字段、点保存
// 全走一遍，用断言把这些错误挡在重启之前。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 极简 React 桩子
function createReact() {
  let hooks = [];
  let deps = [];
  let cursor = 0;
  let schedule = () => {};
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
    }),
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [
        hooks[i],
        (next) => {
          hooks[i] = typeof next === 'function' ? next(hooks[i]) : next;
          schedule();
        },
      ];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: init };
      return hooks[i];
    },
    useEffect(fn, list) {
      const i = cursor++;
      const prev = deps[i];
      const changed = !list || !prev || list.length !== prev.length || list.some((v, k) => v !== prev[k]);
      if (!changed) return;
      deps[i] = list;
      queueMicrotask(fn); // 真实 React 是渲染后跑 effect，这里够用
    },
  };
  return {
    React,
    reset: () => { cursor = 0; },
    // 换一个组件重挂时用：hook 存储要清空，否则两个页面的 state 会串（真实页面里只会有一个）
    resetAll: () => { hooks = []; deps = []; cursor = 0; },
    onSchedule: (fn) => { schedule = fn; },
  };
}

/** 摊平 h() 出来的元素树 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  flatten(node.props?.children, out);
  return out;
}

const byKey = (tree, key) => flatten(tree).find((n) => n?.props?.key === key);
const textOf = (node) => (Array.isArray(node?.props?.children) ? node.props.children.join('') : String(node?.props?.children ?? ''));
const buttons = (tree) => flatten(tree).filter((n) => n?.type === 'button');

// ---------------------------------------------------------------- 装配被测客户端
const clientPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'client.js');
const react = createReact();
let plugin = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      plugin = factory((name) => {
        if (name === 'react') return react.React;
        throw new Error(`桩子里没有模块: ${name}`);
      });
    },
  },
};
await import(pathToFileURL(clientPath).href);

check('client.js 通过 module-loader 注册', plugin !== null && typeof plugin.apply === 'function');
check('注册进 settings.section（含 remote 两个面孔）',
  plugin.inject.includes('slots') && plugin.inject.includes('configForms') && plugin.inject.includes('remote.settings'),
  plugin.inject.join(','));

// ---------------------------------------------------------------- 场景一：手机页面（非回环）
/** Host 侧「生效配置」，模拟配置真的存在 */
let hostConfig = {
  enabled: true,
  allowCidrs: ['100.64.0.0/10'],
  denyCidrs: [],
  port: 19388,
  maxConnections: 66,
  logLevel: 'silent',
  accessCode: '864209',
};
let revision = 3;
const mutateCalls = [];
let remoteClosed = false;

const remoteSettings = {
  async describe() {
    if (remoteClosed) return { ok: false, error: { code: 'connection/closed', message: '连接已断开' } };
    return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{ ns: 'remote-access', value: { ...hostConfig }, revision }] } };
  },
  async mutate(ns, ops, expected) {
    mutateCalls.push({ ns, ops, expected });
    for (const op of ops) hostConfig[op.path[0]] = op.value;
    revision += 1;
    return { ok: true, value: { ns, value: { ...hostConfig }, revision } };
  },
};

let Panel = null;
const makeCtx = () => ({
  // 手机页面：configForms 恒为不可写（DSH 的非回环策略）
  configForms: {
    get: () => ({
      getSnapshot: () => ({ status: 'unavailable', writable: false, mode: 'memory', revision: undefined, value: undefined }),
      subscribe: () => () => {},
      mutate: async () => false,
    }),
    describe: () => ({ load: async () => {} }),
  },
  remote: { settings: remoteSettings, $on: () => () => {} },
  on: () => () => {},
  slots: {
    inject: (_name, callback) => callback(),
    register: (_options, Component) => {
      Panel = Component;
      return () => {};
    },
  },
});

plugin.apply(makeCtx());
check('拿到设置页组件', typeof Panel === 'function');

let tree = null;
const render = () => {
  react.reset();
  tree = Panel();
};
react.onSchedule(render);
render();
await sleep(60); // 等 Remote 读回来并重渲染

const valueOf = (key) => byKey(tree, `${key}-i`)?.props?.value;
check('手机页面：端口读到 19388', valueOf('port') === '19388', `实际 ${JSON.stringify(valueOf('port'))}`);
check('手机页面：并发上限读到 66', valueOf('maxConnections') === '66', `实际 ${JSON.stringify(valueOf('maxConnections'))}`);
check('手机页面：允许的网段读到', String(valueOf('allowCidrs')).includes('100.64.0.0/10'), JSON.stringify(valueOf('allowCidrs')));
check('手机页面：日志级别下拉读到位', byKey(tree, 'logLevel-i')?.props?.value === 'silent', String(byKey(tree, 'logLevel-i')?.props?.value));
check('手机页面：访问密码读到', valueOf('accessCode') === '864209', JSON.stringify(valueOf('accessCode')));
check('手机页面：0 值显示成空（好让占位符露出）',
  byKey(tree, 'port-i')?.props?.placeholder === '0=随机' && byKey(tree, 'maxConnections-i')?.props?.placeholder === '0=不限制',
  `${byKey(tree, 'port-i')?.props?.placeholder} / ${byKey(tree, 'maxConnections-i')?.props?.placeholder}`);
check('JSON 信封被正确拆开（不是把 {ok,value} 当数据）',
  String(valueOf('denyCidrs')) === '', `denyCidrs=${JSON.stringify(valueOf('denyCidrs'))}`);

// 改一个字段 → 保存
byKey(tree, 'port-i').props.onChange({ target: { value: '19389' } });
await sleep(10);
const saveButton = buttons(tree).find((b) => textOf(b) === '保存');
check('找到保存按钮', saveButton !== undefined);
saveButton.props.onClick();
await sleep(60);

check('手机页面：保存走 remote.settings.mutate', mutateCalls.length === 1 && mutateCalls[0].ns === 'remote-access',
  JSON.stringify(mutateCalls[0]?.ops ?? null));
check('手机页面：只提交改动过的字段',
  mutateCalls[0]?.ops?.length === 1 && mutateCalls[0].ops[0].path[0] === 'port' && mutateCalls[0].ops[0].value === 19389,
  JSON.stringify(mutateCalls[0]?.ops ?? null));
check('手机页面：带上了 revision 栅栏', mutateCalls[0]?.expected === 3, String(mutateCalls[0]?.expected));
check('手机页面：保存后显示新值', valueOf('port') === '19389', `实际 ${JSON.stringify(valueOf('port'))}`);
check('手机页面：状态提示已保存', flatten(tree).some((n) => String(n?.props?.children ?? '').includes('已保存')),
  flatten(tree).map((n) => String(n?.props?.children ?? '')).find((t) => t.includes('保存')) ?? '');

// 写入被拒时不许当成功
remoteSettings.mutate = async () => ({ ok: false, error: { code: 'settings/rejected', message: '配置不合法' } });
byKey(tree, 'maxConnections-i').props.onChange({ target: { value: '12' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(40);
check('写入被拒时页面报错（不谎报成功）',
  flatten(tree).some((n) => String(n?.props?.children ?? '').includes('保存失败')),
  flatten(tree).map((n) => String(n?.props?.children ?? '')).find((t) => t.includes('失败')) ?? '(没有失败提示)');

// 读失败要重试，并且最后要看得见
remoteClosed = true;
Panel = null;
plugin.apply(makeCtx());
check('重挂后拿到组件', typeof Panel === 'function');
react.resetAll(); // 模拟「另一台设备重新打开页面」
render();
await sleep(1800); // 重试 250/500/750ms 之后才会放弃并提示
check('读不到配置时给出可见提示',
  flatten(tree).some((n) => String(n?.props?.children ?? '').includes('读不到配置')),
  flatten(tree).map((n) => String(n?.props?.children ?? '')).find((t) => t.startsWith('读不到')) ?? '(没有提示)');

// ---------------------------------------------------------------- 场景二：回环页面（用 configForms）
hostConfig = { ...hostConfig, port: 19388, maxConnections: 64, logLevel: 'info' };
let snapValue = { ...hostConfig };
const formCalls = [];
let Panel2 = null;
plugin.apply({
  configForms: {
    get: () => ({
      getSnapshot: () => ({ status: 'ready', writable: true, mode: 'host', revision: 7, value: { ...snapValue } }),
      subscribe: () => () => {},
      mutate: async (ops, rev) => {
        formCalls.push({ ops, rev });
        for (const op of ops) snapValue[op.path[0]] = op.value;
        return true;
      },
    }),
    describe: () => ({ load: async () => {} }),
  },
  remote: { settings: remoteSettings, $on: () => () => {} },
  on: () => () => {},
  slots: {
    inject: (_name, callback) => callback(),
    register: (_options, Component) => {
      Panel2 = Component;
      return () => {};
    },
  },
});
check('回环页面也拿到组件', typeof Panel2 === 'function');

Panel = Panel2;
react.resetAll();
render();
await sleep(60);
check('回环页面：从 configForms 读到 64', valueOf('maxConnections') === '64', `实际 ${JSON.stringify(valueOf('maxConnections'))}`);
byKey(tree, 'maxConnections-i').props.onChange({ target: { value: '70' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(60);
check('回环页面：走 configForms.mutate（不再碰 remote）',
  formCalls.length === 1 && formCalls[0].ops.length === 1 && formCalls[0].rev === 7,
  JSON.stringify(formCalls[0] ?? null));

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
