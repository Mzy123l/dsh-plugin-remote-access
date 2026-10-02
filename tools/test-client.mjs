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

// ---------------------------------------------------------------- 场景三：远程 UI 布局
//
// 这一段的重点是那条最要紧的约束：**本机（回环）页面一个像素都不许动**。
// 所以这里造一个极简 DOM，让布局控制器真的跑起来，然后断言：
//   * 回环页面：<html> 上没有任何标记、也没注入样式；
//   * 远程页面：按配置打上 data-ra-layout，并在 phone 时注入那张样式表。

function makeEl(tag, attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentElement: null,
    dataset: {},
    style: {},
    textContent: '',
    _attrs: new Map(Object.entries(attrs)),
    getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; },
    setAttribute(n, v) { this._attrs.set(n, String(v)); },
    removeAttribute(n) { this._attrs.delete(n); },
    hasAttribute(n) { return this._attrs.has(n); },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  return el;
}

/** 造一个只够布局控制器用的 document；返回它，方便断言 */
function installDom({ width = 1386, coarse = false } = {}) {
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body');
  const styles = [];
  const media = (query) => ({
    matches: /max-width/.test(query) ? width <= Number(/max-width:\s*(\d+)/.exec(query)[1]) : coarse,
    addEventListener() {},
    removeEventListener() {},
  });
  const doc = {
    documentElement: html,
    head,
    body,
    createElement: (tag) => {
      const el = makeEl(tag);
      if (tag === 'style') styles.push(el);
      return el;
    },
    getElementById: () => null,
    querySelector: (sel) => (String(sel).startsWith('style[') ? styles.find((s) => s.dataset.raLayoutCss) ?? null : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.document = doc;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.window.matchMedia = media;
  globalThis.window.setTimeout = setTimeout;
  return { html, styles, doc };
}

/** 只挂布局控制器：slots 注册不关心，settings.describe 给出我们要的 remoteLayout */
function applyWithLayout({ isLoopback, remoteLayout }) {
  let Panel3 = null;
  plugin.apply({
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'unavailable', writable: false, mode: 'memory', revision: undefined, value: undefined }),
        subscribe: () => () => {},
        mutate: async () => false,
      }),
      describe: () => ({ load: async () => {} }),
    },
    remote: {
      $host: { home: undefined, isLoopback },
      settings: {
        describe: async () => ({
          ok: true,
          value: { writable: true, hasDocument: true, namespaces: [{ ns: 'remote-access', value: { remoteLayout }, revision: 1 }] },
        }),
        mutate: async () => ({ ok: true, value: { ns: 'remote-access', value: { remoteLayout }, revision: 2 } }),
      },
      $on: () => () => {},
    },
    on: () => () => {},
    slots: {
      inject: (_n, cb) => cb(),
      register: (_o, C) => { Panel3 = C; return () => {}; },
    },
  });
  return Panel3;
}

// ---- 本机（回环）页面：绝不打标记、绝不注入样式
const localDom = installDom({ width: 390, coarse: true }); // 故意用「手机尺寸」，证明判据不是宽度
applyWithLayout({ isLoopback: true, remoteLayout: 'phone' });
await sleep(80);
check(
  '本机页面：不设 data-ra-layout（哪怕窗口只有 390px、配置写着 phone）',
  localDom.html.getAttribute('data-ra-layout') === null,
  String(localDom.html.getAttribute('data-ra-layout')),
);
check('本机页面：不注入任何样式', localDom.styles.length === 0, `${localDom.styles.length} 个 <style>`);

// ---- 远程页面 + 配置为 phone：即使窗口很宽也要按手机布局（「我就要手机布局」要能说了算）
const forcedDom = installDom({ width: 1386, coarse: false });
applyWithLayout({ isLoopback: false, remoteLayout: 'phone' });
await sleep(80);
check(
  '远程页面：配置 phone 时无视窗口宽度，打上 data-ra-layout=phone',
  forcedDom.html.getAttribute('data-ra-layout') === 'phone',
  String(forcedDom.html.getAttribute('data-ra-layout')),
);
check('远程页面：注入手机布局样式表', forcedDom.styles.length === 1 && forcedDom.styles[0].textContent.includes('data-ra-settings-panel'),
  `${forcedDom.styles.length} 个 <style>`);
check(
  '样式只挂在 html[data-ra-layout="phone"] 之下（本机拿不到这个属性就永远匹配不上）',
  forcedDom.styles[0].textContent.includes('html[data-ra-layout="phone"]'),
);

// ---- 远程页面 + 配置为 desktop：不动
const deskDom = installDom({ width: 390, coarse: true });
applyWithLayout({ isLoopback: false, remoteLayout: 'desktop' });
await sleep(80);
check(
  '远程页面：配置 desktop 时即使窗口很窄也不上手机布局',
  deskDom.html.getAttribute('data-ra-layout') === 'desktop',
  String(deskDom.html.getAttribute('data-ra-layout')),
);

// ---- 远程页面 + auto：跟着视口走
const autoNarrow = installDom({ width: 390, coarse: false });
applyWithLayout({ isLoopback: false, remoteLayout: 'auto' });
await sleep(80);
check(
  '远程页面：auto + 窄视口 → phone',
  autoNarrow.html.getAttribute('data-ra-layout') === 'phone',
  String(autoNarrow.html.getAttribute('data-ra-layout')),
);
const autoWide = installDom({ width: 1440, coarse: false });
applyWithLayout({ isLoopback: false, remoteLayout: 'auto' });
await sleep(80);
check(
  '远程页面：auto + 宽视口（鼠标）→ desktop',
  autoWide.html.getAttribute('data-ra-layout') === 'desktop',
  String(autoWide.html.getAttribute('data-ra-layout')),
);
const autoTouch = installDom({ width: 1180, coarse: true }); // 平板/横屏手机：宽但有触摸指针
applyWithLayout({ isLoopback: false, remoteLayout: 'auto' });
await sleep(80);
check(
  '远程页面：auto + 触摸设备 → phone（横屏手机也能认出来）',
  autoTouch.html.getAttribute('data-ra-layout') === 'phone',
  String(autoTouch.html.getAttribute('data-ra-layout')),
);

delete globalThis.document;
delete globalThis.MutationObserver;

// ---------------------------------------------------------------- 场景四：远程UI布局这一项本身
hostConfig = { ...hostConfig, port: 19388, maxConnections: 64, logLevel: 'info', remoteLayout: 'auto' };
remoteClosed = false;
remoteSettings.mutate = async (ns, ops, expected) => {
  mutateCalls.push({ ns, ops, expected });
  for (const op of ops) hostConfig[op.path[0]] = op.value;
  revision += 1;
  return { ok: true, value: { ns, value: { ...hostConfig }, revision } };
};
mutateCalls.length = 0;
applyWithLayout = null;
let Panel4 = null;
plugin.apply(makeCtx());
Panel4 = Panel;
react.resetAll();
Panel = Panel4;
render();
await sleep(80);
check(
  '设置页有「远程UI布局」，三个选项就是手机/电脑/自动',
  byKey(tree, 'remoteLayout-i')?.props?.value === 'auto' &&
    flatten(byKey(tree, 'remoteLayout-i')).filter((n) => n?.type === 'option').map((n) => n.props.value).join(',') ===
      'phone,desktop,auto',
  flatten(byKey(tree, 'remoteLayout-i')).filter((n) => n?.type === 'option').map((n) => n.props.value).join(','),
);

// 非法密码：本地就该拦下，且一个字都不许写盘
byKey(tree, 'accessCode-i').props.onChange({ target: { value: '12 34 56' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(40);
check('非法访问密码：本地拦下、不写盘', mutateCalls.length === 0, JSON.stringify(mutateCalls));
check(
  '非法访问密码：给出看得懂的提示（说明只收 4–12 位字母数字）',
  flatten(tree).some((n) => String(n?.props?.children ?? '').includes('只接受 4–12 位数字或字母')),
  flatten(tree).map((n) => String(n?.props?.children ?? '')).find((t) => t.includes('访问密码')) ?? '(没有提示)',
);

// 合法（含字母）的密码：放行并写盘 —— 用户输入 1433223m 这种要真的能用
byKey(tree, 'accessCode-i').props.onChange({ target: { value: '1433223m' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(60);
check(
  '字母数字密码：能保存（不再被静默丢掉）',
  mutateCalls.length === 1 && mutateCalls[0].ops.some((op) => op.path[0] === 'accessCode' && op.value === '1433223m'),
  JSON.stringify(mutateCalls[0]?.ops ?? null),
);

// 布局这一项：改成 phone 也要能写进去
mutateCalls.length = 0;
byKey(tree, 'remoteLayout-i').props.onChange({ target: { value: 'phone' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(60);
check(
  '远程UI布局：能保存为 phone',
  mutateCalls.length === 1 && mutateCalls[0].ops.some((op) => op.path[0] === 'remoteLayout' && op.value === 'phone'),
  JSON.stringify(mutateCalls[0]?.ops ?? null),
);

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
