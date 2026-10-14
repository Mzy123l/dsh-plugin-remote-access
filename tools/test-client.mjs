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

// ---------------------------------------------------------------- 版本号自检
//
// client.js 里的 CLIENT_VERSION 是「手机上那一页跑的到底是哪一份代码」的唯一线索
// （设置页底部会把它显示出来）。它要是跟 package.json 漂了，那行字就会骗人 —— 钉住。
/** package.json 里的版本：下面几处断言都拿它比，免得每抬一版就来改测试 */
let pkgVersion = '';
{
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(clientPath), 'package.json'), 'utf8'));
  pkgVersion = pkg.version;
  const declared = /const CLIENT_VERSION = '([^']+)'/.exec(fs.readFileSync(clientPath, 'utf8'))?.[1];
  check('client.js 的 CLIENT_VERSION 与 package.json 的版本一致',
    declared !== undefined && declared === pkg.version,
    `client.js=${declared} package.json=${pkg.version}`);
}
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

// 页脚自检：本页跑的是哪一份客户端代码 + 电脑那边通知接口在不在（只远程页面探）。
// 这条是「怎么没生效 / 怎么没通知」最省事的答案，所以它必须真的出现在页面上、且说得清下一步。
const footerOf = () => flatten(tree)
  .map((n) => (typeof n?.props?.children === 'string' ? n.props.children : ''))
  .find((t) => t.includes('本页客户端'));
check('手机页面：页脚报出本页客户端版本', String(footerOf()).includes(pkgVersion), `期望含 ${pkgVersion}，实际 ${String(footerOf())}`);
// 重新挂载（连 hooks/deps 一起清）才能让那个只依赖 viaForms 的探测 effect 再跑一遍
const remount = () => { react.resetAll(); tree = Panel(); };
globalThis.window.fetch = async () => ({ status: 404, ok: false, json: async () => null });
remount();
await sleep(40);
check(
  '手机页面：宿主没有通知接口时，页脚说清「更新插件」（而不是含糊的「连不上」）',
  String(footerOf()).includes('还没有通知接口') && String(footerOf()).includes('更新插件'),
  String(footerOf()),
);
globalThis.window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, enabled: true, pending: [], desktop: { known: false, visible: false } }) });
remount();
await sleep(40);
check(
  '手机页面：宿主支持时就报「已支持提问通知」',
  String(footerOf()).includes('已支持提问通知'),
  String(footerOf()),
);
delete globalThis.window.fetch;
remount();
await sleep(20);

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

// ---------------------------------------------------------------- 场景五：UI 设置（出厂值 / 指定值 / 本机不动）
//
// 这五项（外观 / 字号大小 / 工作步骤展示 / 显示代码工作视图 / 性能与用量）在远程页面上只能「本页生效」：
// 官方的设置通道在非回环页面上是内存态（persistence = isLoopback ? 'host' : 'memory'）。这里断言两件事：
//   * 远程页面：按配置调用官方那五个入口，'default'（出厂值）要**显式套回**官方默认值；
//   * 本机页面：一个入口都不碰（与布局控制器同一条硬约束）。

/** 只挂「UI 设置」控制器：给出官方的五个入口（假实现）与工具面，看它按配置调了什么 */
function applyWithUiSettings({ isLoopback, config, withSetters = true }) {
  const calls = [];
  plugin.apply({
    get: (name) => {
      if (!withSetters) return null;
      if (name === 'theme') {
        return {
          setTheme: (id) => calls.push(['setTheme', id]),
          setFontSize: (px) => calls.push(['setFontSize', px]),
        };
      }
      if (name === 'configForms') {
        return { developerTools: { setEnabled: (on) => calls.push(['setDeveloperTools', on]) } };
      }
      return null;
    },
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
          value: { writable: true, hasDocument: true, namespaces: [{ ns: 'remote-access', value: { ...config }, revision: 1 }] },
        }),
        mutate: async () => ({ ok: true, value: { ns: 'remote-access', value: { ...config }, revision: 2 } }),
      },
      $on: () => () => {},
    },
    on: () => () => {},
    slots: {
      inject: (_name, callback) => callback(),
      register: () => () => {},
      entries: (key) =>
        withSetters && key === 'settings.general.item'
          ? [
              { options: { id: 'transcript-view' }, inject: () => ({ setTranscriptView: (mode) => calls.push(['setTranscriptView', mode]) }) },
              { options: { id: 'performance-usage' }, inject: () => ({ setPerformanceUsage: (mode) => calls.push(['setPerformanceUsage', mode]) }) },
            ]
          : [],
    },
  });
  return calls;
}

installDom({ width: 390, coarse: true });

const uiSet = applyWithUiSettings({
  isLoopback: false,
  config: {
    remoteLayout: 'phone',
    remoteTheme: 'dark',
    remoteFontSize: 16,
    remoteTranscriptView: 'verbose',
    remoteDeveloperTools: 'off',
    remotePerformanceUsage: 'compact',
  },
});
await sleep(80);
check(
  '远程页面：UI 设置按配置套到官方那五个入口',
  JSON.stringify(uiSet) ===
    JSON.stringify([
      ['setTheme', 'dark'],
      ['setFontSize', 16],
      ['setTranscriptView', 'verbose'],
      ['setDeveloperTools', false],
      ['setPerformanceUsage', 'compact'],
    ]),
  JSON.stringify(uiSet),
);

const uiFactory = applyWithUiSettings({
  isLoopback: false,
  config: {
    remoteLayout: 'phone',
    remoteTheme: 'default',
    remoteFontSize: 0,
    remoteTranscriptView: 'default',
    remoteDeveloperTools: 'default',
    remotePerformanceUsage: 'default',
  },
});
await sleep(80);
check(
  '远程页面：出厂值 = 显式套回官方默认值（不是「什么都不做」）',
  JSON.stringify(uiFactory) ===
    JSON.stringify([
      ['setTheme', 'system'],
      ['setFontSize', 14],
      ['setTranscriptView', 'detailed'],
      ['setDeveloperTools', true],
      ['setPerformanceUsage', 'detailed'],
    ]),
  JSON.stringify(uiFactory),
);

const uiLocal = applyWithUiSettings({
  isLoopback: true,
  config: {
    remoteLayout: 'phone',
    remoteTheme: 'light',
    remoteFontSize: 22,
    remoteTranscriptView: 'compact',
    remoteDeveloperTools: 'on',
    remotePerformanceUsage: 'compact',
  },
});
await sleep(120);
check('本机页面：UI 设置一个官方入口都不碰', uiLocal.length === 0, JSON.stringify(uiLocal));

let uiMissingThrew = false;
let uiMissing = [];
try {
  uiMissing = applyWithUiSettings({ isLoopback: false, config: { remoteLayout: 'phone', remoteTheme: 'dark' }, withSetters: false });
  await sleep(80);
} catch (err) {
  uiMissingThrew = true;
  uiMissing = [String(err?.message ?? err)];
}
check('官方入口缺席时安静跳过（不报错、不把插件带崩）', !uiMissingThrew && uiMissing.length === 0, JSON.stringify(uiMissing));

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
  '设置页有「远程UI布局」：手机 / 电脑 / 自动',
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

// 「UI 设置」这一层下一级菜单：默认收起，点开才是那五项
const uiHeader = flatten(tree).find((n) => n?.type === 'button' && String(n?.props?.children ?? '').includes('UI 设置'));
check(
  '设置页有「UI 设置」这一层下一级菜单（默认收起）',
  uiHeader !== undefined && uiHeader.props['aria-expanded'] === 'false' && byKey(tree, 'remoteTheme-i') === undefined,
  uiHeader ? `aria-expanded=${uiHeader.props['aria-expanded']}` : '(没有这一组)',
);
uiHeader.props.onClick();
await sleep(10);
const optionsOf = (key) =>
  flatten(byKey(tree, `${key}-i`))
    .filter((n) => n?.type === 'option')
    .map((n) => n.props.value)
    .join(',');
check(
  '展开后是那五项，每项都带「出厂值」这一档',
  ['remoteTheme', 'remoteFontSize', 'remoteTranscriptView', 'remoteDeveloperTools', 'remotePerformanceUsage'].every(
    (key) => byKey(tree, `${key}-i`) !== undefined,
  ) &&
    optionsOf('remoteTheme') === 'default,light,dark,system' &&
    optionsOf('remoteTranscriptView') === 'default,compact,standard,detailed,verbose' &&
    optionsOf('remotePerformanceUsage') === 'default,compact,detailed' &&
    optionsOf('remoteDeveloperTools') === 'default,on,off',
  [optionsOf('remoteTheme'), optionsOf('remoteTranscriptView'), optionsOf('remotePerformanceUsage'), optionsOf('remoteDeveloperTools')].join(' | '),
);

mutateCalls.length = 0;
byKey(tree, 'remoteTheme-i').props.onChange({ target: { value: 'dark' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(60);
check(
  'UI 设置：能存进配置（remoteTheme=dark）',
  mutateCalls.length === 1 && mutateCalls[0].ops.some((op) => op.path[0] === 'remoteTheme' && op.value === 'dark'),
  JSON.stringify(mutateCalls[0]?.ops ?? null),
);

// ---------------------------------------------------------------- 场景六：返回键（只给手机布局）
//
// 安卓外壳（android/MainActivity）把系统返回键接管了：网页上那一下返回键，外壳会先问这里
// 「还有几层该先关掉的东西」。所以这一段要断言三件事：
//   · 层数算得对（抽屉 / 官方浮层都算，且官方浮层在最上面）；
//   · closeTop() 关的确实是**最上面**那层，而且走的是它自己的入口（抽屉=点「收起侧边栏」、
//     官方浮层=派发 Escape）—— 不是我们去改谁的状态；
//   · 「只给手机布局」：电脑布局恒为 0、本机页面连入口都不装，停用后入口要收回。

/** 极简选择器匹配：够这段用（tag / [attr] / [attr="v"] / 逗号并列 / "A > B"） */
function matchSimple(el, sel) {
  const parsed = /^([a-zA-Z]*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!parsed) return false;
  const [, tag, attrs] = parsed;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const m of attrs.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    if (!el.hasAttribute(m[1])) return false;
    if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
  }
  return true;
}
function matchesSelector(el, sel) {
  return String(sel)
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)
    .some((one) => {
      const chain = one.split('>').map((part) => part.trim()).filter(Boolean);
      let node = el;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (!node || !matchSimple(node, chain[i] === '*' ? '' : chain[i])) return false;
        if (i > 0) node = node.parentElement;
      }
      return true;
    });
}
const descendants = (el, out = []) => {
  for (const child of el.children ?? []) {
    out.push(child);
    descendants(child, out);
  }
  return out;
};

function makeBackEl(tag, attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? '',
    disabled: false,
    children: [],
    parentElement: null,
    dataset: {},
    style: {},
    textContent: '',
    clicks: 0,
    _attrs: new Map(),
    _box: { width: 100, height: 40, left: 10, top: 10, right: 110, bottom: 50 },
    getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; },
    setAttribute(n, v) { this._attrs.set(n, String(v)); },
    removeAttribute(n) { this._attrs.delete(n); },
    hasAttribute(n) { return this._attrs.has(n); },
    getAttributeNames() { return [...this._attrs.keys()]; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    closest(sel) { for (let n = this; n; n = n.parentElement) if (matchesSelector(n, sel)) return n; return null; },
    getBoundingClientRect() { return this._box; },
    click() { this.clicks += 1; },
    querySelector(sel) { return descendants(this).find((e) => matchesSelector(e, sel)) ?? null; },
    querySelectorAll(sel) { return descendants(this).filter((e) => matchesSelector(e, sel)); },
    contains() { return false; },
  };
  for (const [k, v] of Object.entries(attrs)) if (k !== 'id') el._attrs.set(k, String(v));
  // 手势判定里有 `el instanceof Element`：桩子得让造出来的元素真的是它的实例，
  // 否则那一行会直接 break，任何归属判断都测不出来（假通过）。
  if (typeof globalThis.Element === 'function') Object.setPrototypeOf(el, globalThis.Element.prototype);
  return el;
}

/** 造一个够布局控制器 + 返回键 API + 手势用的 DOM；返回里面的关键元素，方便断言 */
function installBackDom({ width = 390, drawerOpen = true, bodyAttrs = {} } = {}) {
  globalThis.Element = class Element {}; // 手势判定的 `instanceof Element` 需要它
  const html = makeBackEl('html');
  const head = makeBackEl('head');
  const body = makeBackEl('body', bodyAttrs);
  html.appendChild(head);
  html.appendChild(body);

  const root = makeBackEl('div', { 'data-slot': 'root' });
  const frame = makeBackEl('div');
  root.appendChild(frame);
  body.appendChild(root);
  if (!drawerOpen) frame.setAttribute('data-sidebar-collapsed', '');

  const openDrawer = makeBackEl('button', { 'aria-label': '打开侧边栏' });
  const closeDrawer = makeBackEl('button', { 'aria-label': '收起侧边栏' });
  body.appendChild(openDrawer);
  body.appendChild(closeDrawer);

  const styles = [];
  const dispatched = [];
  // 文档级监听（插件用它认「点了一条会话」与输入框抢焦点）：这里按类型存起来，测试里手动喂事件
  const docListeners = new Map();
  const doc = {
    documentElement: html,
    head,
    body,
    createElement: (tag) => {
      const el = makeBackEl(tag);
      if (tag === 'style') styles.push(el);
      return el;
    },
    getElementById: (id) => [html, ...descendants(html)].find((e) => e.id === id) ?? null,
    // style[data-ra-layout-css=…] 在真实 DOM 里是 dataset 写出来的属性，桩子里单独认一下
    querySelector: (sel) => {
      if (String(sel).startsWith('style[')) return styles.find((s) => s.dataset.raLayoutCss) ?? null;
      return [html, ...descendants(html)].find((e) => matchesSelector(e, sel)) ?? null;
    },
    querySelectorAll: (sel) => [html, ...descendants(html)].filter((e) => matchesSelector(e, sel)),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { docListeners.get(type)?.delete(fn); },
    dispatchEvent: (ev) => { dispatched.push(ev); return true; },
  };
  globalThis.document = doc;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.KeyboardEvent = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  globalThis.window.matchMedia = (query) => ({
    matches: /max-width/.test(query) ? width <= Number(/max-width:\s*(\d+)/.exec(query)[1]) : false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  // 手势是自己挂在 window 上的三个监听：这里记下来，测试里手动喂合成事件
  const listeners = new Map();
  globalThis.window.addEventListener = (type, fn) => { listeners.set(type, fn); };
  globalThis.window.removeEventListener = (type) => { listeners.delete(type); };
  globalThis.window.innerWidth = width;
  globalThis.window.innerHeight = 844;
  // horizontalOwner 会读计算样式：桩子里只给「不命中」的默认值，测试要命中就写在元素上
  globalThis.getComputedStyle = (el) => ({
    overflowX: el?._overflowX ?? 'visible',
    touchAction: el?._touchAction ?? 'auto',
  });
  const fire = (type, event) => {
    const fn = listeners.get(type);
    if (fn) fn(event);
    return Boolean(fn);
  };
  /** 喂一次文档级事件（冒泡阶段与捕获阶段共用这一份表） */
  const fireDoc = (type, event) => {
    const set = docListeners.get(type);
    if (!set) return 0;
    for (const fn of [...set]) fn(event);
    return set.size;
  };
  return { html, body, frame, styles, dispatched, openDrawer, closeDrawer, makeBackEl, fire, fireDoc, docListeners, listeners };
}

/** 只挂布局控制器，并把它的清理函数抓出来（返回 stop()，selectPanel 的调用记在 stop.calls 上） */
function applyBackController({ isLoopback, remoteLayout, activePanel = null, withLayout = true }) {
  // ctx.effect 的契约：回调可以「返回一个清理函数」，停用时由宿主执行。
  // 插件里注册了不止一个 effect，所以这里要全收着，停用时按同样的规矩跑。
  const effects = [];
  const calls = [];
  plugin.apply({
    // 可选服务：插件只该用 ctx.get 取它（inject 里加必需服务会让加载直接失败）
    get: (name) => (withLayout && name === 'layout'
      ? {
          panelInfo: { getSnapshot: () => ({ activePanelId: activePanel }) },
          selectPanel: (id) => { calls.push(id); },
        }
      : undefined),
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
        mutate: async () => ({ ok: true, value: {} }),
      },
      $on: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => { effects.push(fn); },
    slots: { inject: (_n, cb) => cb(), register: () => () => {} },
  });
  const stop = () => {
    for (const fn of effects) {
      try {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanup();
      } catch { /* 忽略 */ }
    }
  };
  stop.calls = calls;
  return stop;
}

// ---- 远程页面 + 手机布局：抽屉开着 → 1 层；官方浮层盖在上面 → 2 层，且先关浮层
const backDom = installBackDom({ drawerOpen: true });
applyBackController({ isLoopback: false, remoteLayout: 'phone' });
await sleep(80);
check(
  '手机布局：给外壳留了返回键入口（window.__dshRaBack）',
  typeof globalThis.window.__dshRaBack?.count === 'function' && typeof globalThis.window.__dshRaBack?.closeTop === 'function',
);
check(
  '手机布局：抽屉开着算 1 层',
  globalThis.window.__dshRaBack?.count() === 1,
  String(globalThis.window.__dshRaBack?.count()),
);

// 官方浮层（设置面板这类 Modal）盖在抽屉上：层数变 2，且 closeTop 先走它
const dialog = backDom.makeBackEl('div', { role: 'dialog', 'aria-modal': 'true' });
const dialogClose = backDom.makeBackEl('button', { 'data-slot': 'settings.close' });
dialog.appendChild(dialogClose);
backDom.body.appendChild(dialog);
check(
  '手机布局：官方浮层 + 抽屉 = 2 层',
  globalThis.window.__dshRaBack?.count() === 2,
  String(globalThis.window.__dshRaBack?.count()),
);
const closedDialog = globalThis.window.__dshRaBack?.closeTop();
check(
  '官方浮层在最上面：closeTop() 派发 Escape 关它，而不是去点抽屉',
  closedDialog === true && backDom.dispatched.some((ev) => ev.type === 'keydown' && ev.key === 'Escape') && backDom.closeDrawer.clicks === 0,
  `closed=${closedDialog} dispatched=${backDom.dispatched.length} 抽屉点击=${backDom.closeDrawer.clicks}`,
);

// 浮层关掉（桩子里用「不可见」模拟）→ 回到抽屉那一层
dialog._box = { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
check(
  '浮层没了就只剩抽屉：1 层',
  globalThis.window.__dshRaBack?.count() === 1,
  String(globalThis.window.__dshRaBack?.count()),
);
const closedDrawer = globalThis.window.__dshRaBack?.closeTop();
check(
  '抽屉在最上面：closeTop() 点它自己的「收起侧边栏」',
  closedDrawer === true && backDom.closeDrawer.clicks === 1,
  `closed=${closedDrawer} 抽屉点击=${backDom.closeDrawer.clicks}`,
);

// ---- 主区停在「插件 / 自动化任务」这类全局面板上：返回键要能回会话
//      （左上角面板列表选中的那个；状态读官方 ctx.layout.panelInfo，关它走 layout.selectPanel(null)）
const panelDom = installBackDom({ drawerOpen: false });
const panelCtl = applyBackController({ isLoopback: false, remoteLayout: 'phone', activePanel: 'plugins' });
await sleep(80);
check(
  '全局面板（插件/自动化任务）：算 1 层',
  globalThis.window.__dshRaBack?.count() === 1,
  `count=${globalThis.window.__dshRaBack?.count()} 抽屉点击=${panelDom.closeDrawer.clicks}`,
);
const backToChat = globalThis.window.__dshRaBack?.closeTop();
check(
  '关这一层走官方入口 layout.selectPanel(null)（回会话），不是自己改状态、也不去点抽屉',
  backToChat === true && panelCtl.calls.length === 1 && panelCtl.calls[0] === null && panelDom.closeDrawer.clicks === 0,
  `closed=${backToChat} selectPanel=${JSON.stringify(panelCtl.calls)} 抽屉点击=${panelDom.closeDrawer.clicks}`,
);

// 会话面板（activePanelId = null）不算一层；layout 服务缺席时也不该炸
const convCtl = applyBackController({ isLoopback: false, remoteLayout: 'phone', activePanel: null });
await sleep(80);
check(
  '会话面板不算一层，closeTop() 不接手',
  globalThis.window.__dshRaBack?.count() === 0 && globalThis.window.__dshRaBack?.closeTop() === false,
  `count=${globalThis.window.__dshRaBack?.count()} selectPanel=${JSON.stringify(convCtl.calls)}`,
);
const noLayoutCtl = applyBackController({ isLoopback: false, remoteLayout: 'phone', withLayout: false });
await sleep(80);
check(
  'layout 服务缺席（更老的 DSH）：不报错、层数照常为 0',
  globalThis.window.__dshRaBack?.count() === 0 && globalThis.window.__dshRaBack?.closeTop() === false,
  `selectPanel=${JSON.stringify(noLayoutCtl.calls)}`,
);

// ---- 手势归属：壁纸引擎的 data-we-* 页面级锚点挂在 <body> 上，不能因此让整页划不动
//
// 真机症状：**新会话首页**左右滑不出面板，聊天页却正常。原因是判定里把「带 data-we* 属性的
// 元素」一律当成横向归属方，而 `data-we-glass-page` / `data-we-wallpaper` / `data-we-parallax`
// 这批是插件一启用就恒挂在 body 上的 CSS 门控锚点；首页 DOM 浅（往上几层就到 body）→ 整页被吃掉，
// 聊天页嵌套深、14 层内走不到 body 才侥幸正常。这里把三种起手点都喂一遍。
function swipeRight(dom, target, from = 20, to = 110, y = 400) {
  dom.fire('touchstart', { touches: [{ clientX: from, clientY: y }], target, cancelable: true, preventDefault() {} });
  dom.fire('touchmove', { touches: [{ clientX: (from + to) / 2, clientY: y + 2 }], cancelable: true, preventDefault() {} });
  dom.fire('touchend', { changedTouches: [{ clientX: to, clientY: y + 4 }] });
}

const gestureDom = installBackDom({ drawerOpen: false, bodyAttrs: { 'data-we-glass-page': 'on', 'data-we-wallpaper': 'on' } });
applyBackController({ isLoopback: false, remoteLayout: 'phone', activePanel: null });
await sleep(80);
const plainTarget = gestureDom.makeBackEl('div'); // 首页上那种普通容器：往上几层就是 body
gestureDom.body.appendChild(plainTarget);
swipeRight(gestureDom, plainTarget);
check(
  '首页（body 上挂着壁纸 data-we-* 锚点）向右滑照样调出抽屉',
  gestureDom.openDrawer.clicks === 1,
  `打开侧边栏点击=${gestureDom.openDrawer.clicks}`,
);

const pickerCard = gestureDom.makeBackEl('div', { 'data-we-id': '42' }); // 壁纸选择器卡片：真的带交互标记
gestureDom.body.appendChild(pickerCard);
swipeRight(gestureDom, pickerCard);
check(
  '真正带交互标记的元素（壁纸卡片 data-we-id）仍然不让开',
  gestureDom.openDrawer.clicks === 1,
  `打开侧边栏点击=${gestureDom.openDrawer.clicks}`,
);

const mascot = gestureDom.makeBackEl('div'); // 吉祥物 .we-rope：靠 touch-action:none 保护
mascot._touchAction = 'none';
gestureDom.body.appendChild(mascot);
swipeRight(gestureDom, mascot);
check(
  '吉祥物（touch-action:none，可拖拽）仍然不让开',
  gestureDom.openDrawer.clicks === 1,
  `打开侧边栏点击=${gestureDom.openDrawer.clicks}`,
);

const deskBackDom = installBackDom({ drawerOpen: true });
applyBackController({ isLoopback: false, remoteLayout: 'desktop' });
await sleep(80);
check(
  '电脑布局：层数恒为 0，closeTop() 不接手',
  globalThis.window.__dshRaBack?.count() === 0 && globalThis.window.__dshRaBack?.closeTop() === false,
  `count=${globalThis.window.__dshRaBack?.count()} 抽屉点击=${deskBackDom.closeDrawer.clicks}`,
);

// ---- 本机（回环）页面：连入口都不装（先把上一台控制器的入口清掉，证明不是残留）
delete globalThis.window.__dshRaBack;
const localBackDom = installBackDom({ drawerOpen: true });
applyBackController({ isLoopback: true, remoteLayout: 'phone' });
await sleep(80);
check(
  '本机页面：不装返回键入口（本机窗口再窄也一样）',
  globalThis.window.__dshRaBack === undefined && localBackDom.html.getAttribute('data-ra-layout') === null,
  typeof globalThis.window.__dshRaBack,
);

// ---- 停用（控制器清理）：入口要收回，别让外壳问到一个已经停掉的页面
const stopBack = applyBackController({ isLoopback: false, remoteLayout: 'phone' });
await sleep(80);
const installed = typeof globalThis.window.__dshRaBack?.count === 'function';
stopBack();
check(
  '清理后收回入口',
  installed && globalThis.window.__dshRaBack === undefined,
  `装上了=${installed} 清理后=${typeof globalThis.window.__dshRaBack}`,
);

// ---------------------------------------------------------------- 场景七：点会话行 → 立刻收起抽屉 + 不聚焦输入框
//
// 手机布局里「左侧工作区列表」就是抽屉：点一条会话，DSH 切过去、抽屉却还盖着正文，
// 而且它会在切换时把光标塞进输入框（电脑上的好意，手机上直接弹键盘）。
// 这一段验两件事：抽屉被收起（走它自己的「收起侧边栏」），输入框在那一下之后拿不到焦点。

/** 造一份「侧栏 + 一条会话行 + 一行工作区 + 一个输入框」的 DOM；返回关键元素与派发函数 */
function installSessionRowDom({ drawerOpen = true, loopback = false, remoteLayout = 'phone' } = {}) {
  const dom = installBackDom({ width: 390, drawerOpen });
  const sidebar = dom.makeBackEl('div', { 'data-ra-sidebar': '' });
  const sessionRow = dom.makeBackEl('div', { 'data-row-key': 'session:abc', role: 'treeitem' });
  const sessionTitle = dom.makeBackEl('span');
  const rowActionButton = dom.makeBackEl('button', { 'aria-label': '会话操作' });
  const workspaceRow = dom.makeBackEl('div', { 'data-row-key': 'workspace:key1' });
  const composer = dom.makeBackEl('div', { 'data-composer-input': '' });
  const blurs = [];
  composer.inert = false; // 真 DOM 里没设过 inert 时是 false，桩子也得是这个初值
  composer.blur = () => { blurs.push(1); };
  sidebar.appendChild(sessionRow);
  sidebar.appendChild(workspaceRow);
  sessionRow.appendChild(sessionTitle);
  sessionRow.appendChild(rowActionButton);
  dom.body.appendChild(sidebar);
  dom.body.appendChild(composer);
  const stop = applyBackController({ isLoopback: loopback, remoteLayout });
  return { ...dom, sidebar, sessionRow, sessionTitle, rowActionButton, workspaceRow, composer, blurs, stop };
}

const rowDom = installSessionRowDom();
await sleep(80);
check(
  '会话行：手机布局下装了文档级监听（click + focusin）',
  rowDom.docListeners.get('click')?.size === 1 && rowDom.docListeners.get('focusin')?.size === 1,
  `click=${rowDom.docListeners.get('click')?.size ?? 0} focusin=${rowDom.docListeners.get('focusin')?.size ?? 0}`,
);
rowDom.fireDoc('click', { target: rowDom.sessionTitle });
check(
  '会话行：点一条会话 → 立刻收起抽屉（走它自己的「收起侧边栏」）',
  rowDom.closeDrawer.clicks === 1 && rowDom.openDrawer.clicks === 0,
  `收起=${rowDom.closeDrawer.clicks} 打开=${rowDom.openDrawer.clicks}`,
);
check('会话行：同一时刻输入框被按住（inert），键盘弹不出来', rowDom.composer.inert === true, String(rowDom.composer.inert));

// 兜底那一手：inert 不管用的 WebView 上，窗口内谁把焦点塞进输入框就交回去
rowDom.fireDoc('focusin', { target: rowDom.composer });
rowDom.fireDoc('focusin', { target: rowDom.sessionTitle }); // 别的元素不管
check('会话行：窗口内输入框抢到焦点 → 立刻 blur（别的元素不碰）', rowDom.blurs.length === 1, `blur ${rowDom.blurs.length} 次`);

await sleep(450);
check('会话行：窗口一过，输入框恢复可聚焦（用户自己点它照常能打字）', rowDom.composer.inert === false, String(rowDom.composer.inert));
rowDom.fireDoc('focusin', { target: rowDom.composer });
check('会话行：窗口过了就不再管焦点', rowDom.blurs.length === 1, `blur ${rowDom.blurs.length} 次`);

// 行内按钮（…菜单 / 置顶 / 归档）不是「选了这条会话」
rowDom.fireDoc('click', { target: rowDom.rowActionButton });
check(
  '会话行：点行内按钮不收抽屉（那是行操作，不是选会话）',
  rowDom.closeDrawer.clicks === 1,
  `收起=${rowDom.closeDrawer.clicks}`,
);
// 工作区分组行只是展开/收起，也不是「选了会话」
rowDom.fireDoc('click', { target: rowDom.workspaceRow });
check('会话行：点工作区分组行不收抽屉', rowDom.closeDrawer.clicks === 1, `收起=${rowDom.closeDrawer.clicks}`);

// 抽屉本来就是收着的：这一下只是页面上的普通点击
const closedRowDom = installSessionRowDom({ drawerOpen: false });
await sleep(80);
closedRowDom.fireDoc('click', { target: closedRowDom.sessionTitle });
check(
  '会话行：抽屉没开时什么都不做（不重复点收起、也不按住输入框）',
  closedRowDom.closeDrawer.clicks === 0 && closedRowDom.composer.inert === false,
  `收起=${closedRowDom.closeDrawer.clicks} inert=${closedRowDom.composer.inert}`,
);

// 电脑布局：侧栏是普通一列，点完本来就看得到正文 —— 不该替用户收任何东西
const deskRowDom = installSessionRowDom({ remoteLayout: 'desktop' });
await sleep(80);
deskRowDom.fireDoc('click', { target: deskRowDom.sessionTitle });
check(
  '会话行：电脑布局下不接管（不收抽屉、不动输入框）',
  deskRowDom.closeDrawer.clicks === 0 && deskRowDom.composer.inert === false,
  `收起=${deskRowDom.closeDrawer.clicks} inert=${deskRowDom.composer.inert}`,
);

// 本机页面：连控制器都不装（「本机不动」这条硬约束）
const localRowDom = installSessionRowDom({ loopback: true });
await sleep(80);
localRowDom.fireDoc('click', { target: localRowDom.sessionTitle });
check(
  '会话行：本机页面一个监听都不装（点会话行什么都不发生）',
  localRowDom.closeDrawer.clicks === 0 &&
    localRowDom.composer.inert === false &&
    (localRowDom.docListeners.get('click')?.size ?? 0) === 0,
  `收起=${localRowDom.closeDrawer.clicks} 监听=${localRowDom.docListeners.get('click')?.size ?? 0}`,
);

// 停用：监听收回，被按住的输入框放开
const stopRowDom = installSessionRowDom();
await sleep(80);
stopRowDom.fireDoc('click', { target: stopRowDom.sessionTitle });
const wasHeld = stopRowDom.composer.inert === true;
stopRowDom.stop();
stopRowDom.fireDoc('click', { target: stopRowDom.sessionTitle });
check(
  '会话行：停用后监听收回、输入框放开',
  wasHeld &&
    stopRowDom.composer.inert === false &&
    (stopRowDom.docListeners.get('click')?.size ?? 0) === 0 &&
    (stopRowDom.docListeners.get('focusin')?.size ?? 0) === 0,
  `按住了=${wasHeld} inert=${stopRowDom.composer.inert} 监听=${stopRowDom.docListeners.get('click')?.size ?? 0}`,
);

// ---------------------------------------------------------------- 窗口可见性上报（只在本机页面）
//
// 这是「电脑只有托盘时才通知手机」那一半的网页侧：本机页面的 client.js 必须把
// document.visibilityState 报给宿主。三条要验的：只在本机页面上报、变化时报、
// 心跳在、清理后彻底安静（否则停用的插件还在偷偷发请求）。

const presencePosts = [];
const presenceTimers = new Map();
let presenceTimerSeq = 0;
let presenceVisibilityListener = null;
/** 收集 ctx.effect 接手到的清理函数：插件停用时宿主会调它们 */
const presenceDisposers = [];

function installPresenceEnv({ withFetch = true } = {}) {
  globalThis.document = {
    documentElement: { getAttribute: () => null, setAttribute() {}, removeAttribute() {}, hasAttribute: () => false },
    head: { appendChild() {} },
    body: { appendChild() {} },
    visibilityState: 'visible',
    createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (type === 'visibilitychange') presenceVisibilityListener = fn; },
    removeEventListener: (type) => { if (type === 'visibilitychange') presenceVisibilityListener = null; },
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  if (withFetch) {
    globalThis.window.fetch = (url, init) => {
      presencePosts.push({ url, init });
      return Promise.resolve({ ok: true });
    };
  } else {
    delete globalThis.window.fetch;
  }
  globalThis.window.setInterval = (fn, ms) => {
    const id = ++presenceTimerSeq;
    presenceTimers.set(id, { fn, ms });
    return id;
  };
  globalThis.window.clearInterval = (id) => presenceTimers.delete(id);
}

/** 只挂「窗口可见性上报」那一段：其余控制器在本机页面上都是空清理，不会干扰这里的断言 */
function applyPresence({ isLoopback }) {
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
        describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } }),
        mutate: async () => ({ ok: false, error: { message: 'n/a' } }),
      },
      $on: () => () => {},
    },
    on: () => () => {},
    // 真 Cordis 的 ctx.effect：立刻跑一遍回调，并接管它返回的清理函数
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') presenceDisposers.push(dispose);
    },
    slots: { inject: (_n, cb) => cb(), register: () => () => {} },
  });
}

installPresenceEnv();
presenceDisposers.length = 0;
applyPresence({ isLoopback: true });
check(
  '窗口可见性：本机页面进页面就报一次（此刻可见）',
  presencePosts.length === 1 &&
    presencePosts[0].url === '/__remote_access__/presence' &&
    JSON.parse(presencePosts[0].init.body).visible === true &&
    presencePosts[0].init.headers['content-type'] === 'application/json',
  JSON.stringify(presencePosts[0] ?? {}).slice(0, 110),
);
check('窗口可见性：上报带 25 秒心跳（页面被关掉后宿主那份报告会过期）',
  [...presenceTimers.values()].some((t) => t.ms === 25000), `${presenceTimers.size} 个定时器`);
globalThis.document.visibilityState = 'hidden';
presenceVisibilityListener?.();
check(
  '窗口可见性：窗口藏起来时报 hidden（宿主据此决定要不要通知手机）',
  presencePosts.length === 2 && JSON.parse(presencePosts[1].init.body).visible === false,
  `${presencePosts.length} 次上报`,
);

// 停用插件（模拟宿主回收 effect）：监听与心跳都要收回，否则停用的页面还在偷偷发请求
const postsBeforeDispose = presencePosts.length;
for (const dispose of presenceDisposers.splice(0)) {
  try { dispose(); } catch { /* 忽略 */ }
}
globalThis.document.visibilityState = 'visible';
presenceVisibilityListener?.();
await sleep(30);
check(
  '窗口可见性：清理后彻底安静（监听收回、心跳停掉）',
  presencePosts.length === postsBeforeDispose && presenceTimers.size === 0,
  `清理后又发了 ${presencePosts.length - postsBeforeDispose} 次，剩 ${presenceTimers.size} 个定时器`,
);

// 远程页面（手机）绝不上报：那是「手机自己可见吗」，该由外壳 App 回答，不能混进「电脑窗口」的判断
const postsBeforeRemote = presencePosts.length;
applyPresence({ isLoopback: false });
await sleep(60);
check(
  '窗口可见性：远程（手机）页面一个请求都不发',
  presencePosts.length === postsBeforeRemote && presenceTimers.size === 0,
  `${presencePosts.length - postsBeforeRemote} 个请求`,
);

// 没有 fetch 的环境（更老的 WebView）：安静跳过，不抛异常
installPresenceEnv({ withFetch: false });
try {
  applyPresence({ isLoopback: true });
  check('窗口可见性：没有 fetch 时安静跳过（不抛异常）', presencePosts.length === postsBeforeRemote && presenceTimers.size === 0);
} catch (err) {
  check('窗口可见性：没有 fetch 时安静跳过（不抛异常）', false, String(err?.message ?? err));
}
for (const dispose of presenceDisposers.splice(0)) {
  try { dispose(); } catch { /* 忽略 */ }
}
installPresenceEnv();

delete globalThis.document;
delete globalThis.MutationObserver;
delete globalThis.KeyboardEvent;
delete globalThis.Element;
delete globalThis.getComputedStyle;

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
