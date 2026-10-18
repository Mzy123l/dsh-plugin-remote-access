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
globalThis.window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, enabled: true, pending: [], desktop: { known: false, visible: false }, phone: { app: pkgVersion, notifications: true, importance: 4, importanceFinish: 4 } }) });
remount();
await sleep(40);
check(
  '手机页面：宿主支持时报「已支持提问通知」，并带上手机端自报的两个通道状态',
  String(footerOf()).includes('已支持提问通知') &&
    String(footerOf()).includes(`手机端 App ${pkgVersion}`) &&
    String(footerOf()).includes('提问通道=4') &&
    String(footerOf()).includes('结束通道=4'),
  String(footerOf()),
);
globalThis.window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, enabled: true, pending: [], desktop: { known: false, visible: false }, phone: { app: pkgVersion, notifications: true, importance: 2, importanceFinish: 2 } }) });
remount();
await sleep(40);
check(
  '手机页面：任一通道被调低时，页脚直接说「弹不出来」（两个通道分开报）',
  String(footerOf()).includes('提问通道=2') &&
    String(footerOf()).includes('结束通道=2') &&
    (String(footerOf()).match(/弹不出来/g) ?? []).length === 2,
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
    // 0.2.1 的 UI 设置投影会读/写 body 的 CSS 变量；这里给一个最小可用的 style
    style: {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] ?? ''; },
    },
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

// ---------------------------------------------------------------- 场景五之二：DSH 0.2.1 的远程 UI 设置
//
// 0.2.1 的 ui-settings 取消了「非回环 → memory」降级：ConfigFormController 的快照里
// 不再有 mode，远程页面调官方 setter 会直接写宿主。这里断言本插件改走「只投影到本页」：
//   * 官方 setTheme / setFontSize / 五个入口一个都不调用（不写电脑）；
//   * 外观与字号真的落到了本页 DOM；
//   * 电脑端主题变化后，手机仍保留自己的外观。
function applyWithUiSettings021(config) {
  const calls = [];
  let themeChange = null;
  const hostTheme = {
    preference: 'light',
    fontSizes: { text: 14, code: 13, terminal: 13 },
    active: { colorScheme: 'light', tokens: {} },
    themes: [],
  };
  plugin.apply({
    get: (name) => {
      if (name === 'theme') {
        return {
          getTheme: () => hostTheme,
          setTheme: (id) => calls.push(['setTheme', id]),
          setFontSize: (...args) => calls.push(['setFontSize', ...args]),
        };
      }
      if (name === 'configForms') {
        return { developerTools: { setEnabled: (on) => calls.push(['setDeveloperTools', on]) } };
      }
      return null;
    },
    configForms: {
      // 关键：没有 mode → 当作 0.2.1
      get: () => ({
        getSnapshot: () => ({ status: 'unavailable', writable: false, revision: undefined, value: undefined }),
        subscribe: () => () => {},
        mutate: async () => false,
      }),
      describe: () => ({ load: async () => {} }),
    },
    remote: {
      $host: { home: undefined, isLoopback: false },
      settings: {
        describe: async () => ({
          ok: true,
          value: { writable: true, hasDocument: true, namespaces: [{ ns: 'remote-access', value: { ...config }, revision: 1 }] },
        }),
        mutate: async () => ({ ok: true, value: { ns: 'remote-access', value: { ...config }, revision: 2 } }),
      },
      $on: () => () => {},
    },
    on: (event, fn) => {
      if (event === 'theme/change') themeChange = fn;
      return () => {
        if (themeChange === fn) themeChange = null;
      };
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: () => () => {},
      entries: (key) =>
        key === 'settings.general.item'
          ? [
              { options: { id: 'transcript-view' }, inject: () => ({ setTranscriptView: (mode) => calls.push(['setTranscriptView', mode]) }) },
              { options: { id: 'performance-usage' }, inject: () => ({ setPerformanceUsage: (mode) => calls.push(['setPerformanceUsage', mode]) }) },
            ]
          : [],
    },
  });
  return { calls, fireThemeChange: () => themeChange?.() };
}

const ui021 = applyWithUiSettings021({
  remoteLayout: 'phone',
  remoteTheme: 'dark',
  remoteFontSize: 16,
  remoteTranscriptView: 'verbose',
  remoteDeveloperTools: 'off',
  remotePerformanceUsage: 'compact',
});
await sleep(120);
check('0.2.1：不调用任何会写宿主的官方入口', ui021.calls.length === 0, JSON.stringify(ui021.calls));
check(
  '0.2.1：外观只投影到本页（root 标记 + 深色属性）',
  document.documentElement.getAttribute('data-ds-theme-source') === 'dark' && document.body.hasAttribute('data-ds-dark-theme'),
  `${document.documentElement.getAttribute('data-ds-theme-source')} / ${document.body.hasAttribute('data-ds-dark-theme')}`,
);
check(
  '0.2.1：字号只投影正文（代码/终端保持官方值）',
  document.body.style.getPropertyValue('--dsh-content-font-size') === '16px' &&
    document.body.style.getPropertyValue('--dsh-code-font-size') === '13px' &&
    document.body.style.getPropertyValue('--dsh-terminal-font-size') === '13px',
  JSON.stringify({
    text: document.body.style.getPropertyValue('--dsh-content-font-size'),
    code: document.body.style.getPropertyValue('--dsh-code-font-size'),
    terminal: document.body.style.getPropertyValue('--dsh-terminal-font-size'),
  }),
);

ui021.fireThemeChange();
check(
  '0.2.1：电脑端主题变化后，手机仍保留自己的外观',
  document.documentElement.getAttribute('data-ds-theme-source') === 'dark' && ui021.calls.length === 0,
  `${document.documentElement.getAttribute('data-ds-theme-source')} / ${JSON.stringify(ui021.calls)}`,
);

const ui021Factory = applyWithUiSettings021({
  remoteLayout: 'phone',
  remoteTheme: 'default',
  remoteFontSize: 0,
});
await sleep(120);
check(
  '0.2.1：出厂值也走本页投影（system + 官方字号）',
  document.documentElement.getAttribute('data-ds-theme-source') === 'system' &&
    document.body.style.getPropertyValue('--dsh-content-font-size') === '14px' &&
    ui021Factory.calls.length === 0,
  `${document.documentElement.getAttribute('data-ds-theme-source')} / ${document.body.style.getPropertyValue('--dsh-content-font-size')} / ${JSON.stringify(ui021Factory.calls)}`,
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

// 「缓存」这一层下一级菜单：同样默认收起；那一行自检只在**展开时**才去问宿主（平时零请求）
const cacheHeader = flatten(tree).find((n) => n?.type === 'button' && String(n?.props?.children ?? '').includes('缓存'));
check(
  '设置页有「缓存」这一层下一级菜单（默认收起，不铺满一屏）',
  cacheHeader !== undefined && cacheHeader.props['aria-expanded'] === 'false' && byKey(tree, 'cacheEnabled-i') === undefined,
  cacheHeader ? `aria-expanded=${cacheHeader.props['aria-expanded']}` : '(没有这一组)',
);

const cacheFetches = [];
globalThis.window.fetch = async (url) => {
  cacheFetches.push(String(url));
  return {
    status: 200,
    ok: true,
    json: async () => ({
      ok: true,
      policy: {
        enabled: true,
        ttlMinutes: 10,
        swrHours: 12,
        probe: true,
        storesOnHost: false,
        honorsNoStore: false,
        overrideNoStore: true,
        overrideRange: true,
      },
      stats: { immutable: 3, validated: 1, ttl: 12, notModified: 4, inline: 2, probe: 5, probeFail: 0, override: 2 },
      recent: [],
      // 流量账：组合包那类响应是 DSH 自己发的 immutable，缓存计数看不见它们 —— 只能靠这里的字节数
      traffic: {
        since: 0,
        totalIn: 2048,
        totalOut: 1258291,
        wsIn: 4096,
        wsOut: 629145,
        uncachedOut: 1048576,
        top: [
          { key: 'GET /plugins/', hits: 3, in: 0, out: 1180000, cached: 2 },
          { key: 'GET /wallpaper/big.jpg', hits: 2, in: 0, out: 614400, cached: 2 },
          { key: 'GET /wallpaper-engine/scene-audio/xyz', hits: 2, in: 0, out: 3986490, cached: 0, reason: '带 Range 的分段请求（bytes=0-；浏览器不缓存 206）' },
        ],
      },
    }),
  };
};
cacheHeader.props.onClick();
await sleep(40);
const cacheTexts = flatten(tree).map((n) => String(n?.props?.children ?? ''));
check(
  '设置页：主区按「服务 / 访问控制 / 手机通知 / 远程界面」分节（读起来像配置清单）',
  ['服务', '访问控制', '手机通知', '远程界面'].every((title) => cacheTexts.includes(title)),
  cacheTexts.filter((t) => ['服务', '访问控制', '手机通知', '远程界面'].includes(t)).join(' | '),
);
check(
  '设置页：字段下面带一行小字说明（不再把全部解释塞进 placeholder）',
  cacheTexts.some((t) => t.includes('关掉即停止监听')) &&
    cacheTexts.some((t) => t.includes('只有点「发送」才发送')) &&
    cacheTexts.some((t) => t.includes('输错一次即拉黑该地址')),
  cacheTexts.filter((t) => t.includes('拉黑') || t.includes('停止监听')).join(' | '),
);
check(
  '缓存：展开后才显示四个字段（启用 / 新鲜期 / 片段核对 / no-store / 整段 Range）',
  ['cacheEnabled', 'cacheTtlMinutes', 'cacheProbe', 'cacheOverrideNoStore', 'cacheFullRange'].every(
    (key) => byKey(tree, `${key}-i`) !== undefined,
  ),
  ['cacheEnabled', 'cacheTtlMinutes', 'cacheProbe', 'cacheOverrideNoStore', 'cacheFullRange']
    .map((k) => `${k}=${byKey(tree, `${k}-i`) !== undefined}`)
    .join(' '),
);
check(
  '缓存：自检那行说出实际口径与本次计数（304 次数直接可见）',
  cacheFetches.length === 1 &&
    cacheFetches[0].includes('/__remote_access__/cache') &&
    cacheTexts.some((t) => t.includes('immutable') && t.includes('10 分钟') && t.includes('304 4 次')),
  cacheFetches.join(',') || '(没发请求)',
);
check(
  '缓存：那行还带本轮流量（送出 / 无缓存口径 / WebSocket）',
  cacheTexts.some((t) => t.includes('本轮送出 1.20 MB') && t.includes('其中无缓存口径 1.00 MB') && t.includes('WebSocket 614.4 KB')),
  cacheTexts.find((t) => t.includes('本轮送出')) ?? '(没有)',
);
// 三块小标题：生效策略 / 本次会话 / 本轮流量账 —— 展开后是「报告」的样子，不是一坨字
check(
  '缓存：展开后分成「生效策略 / 本次会话 / 本轮流量账」三块',
  ['生效策略', '本次会话', '本轮流量账（按 URL 排字节）'].every((t) => cacheTexts.includes(t)),
  cacheTexts.filter((t) => t.includes('生效') || t.includes('本次') || t.includes('流量账')).join(' | '),
);
check(
  '缓存：策略那几行把两个开关的实际状态写出来（开 · 已接管 / 关 · 尊重上游）',
  cacheTexts.filter((t) => t === '开 · 已接管').length === 2 &&
    cacheTexts.includes('首/尾各 64 KB 片段指纹') &&
    cacheTexts.includes('不落宿主盘（零字节）'),
  cacheTexts.filter((t) => t.includes('接管') || t.includes('零字节')).join(' | '),
);
check(
  '缓存：本次会话把 304 / 小资源 / 探针 / 接管 都列出来',
  cacheTexts.includes('4 次') &&
    cacheTexts.includes('2 次') &&
    cacheTexts.includes('5 次（失败 0）') &&
    cacheTexts.includes('304（零字节）'),
  cacheTexts.filter((t) => t.endsWith('次') || t.endsWith('次）')).join(' | '),
);
check(
  '缓存：流量账是一张表（表头 + 字节/次数/URL 三列），并按字节从多到少排',
  cacheTexts.includes('送出') &&
    cacheTexts.includes('次数') &&
    cacheTexts.includes('URL') &&
    cacheTexts.includes('3.80 MB') &&
    cacheTexts.includes('1.13 MB') &&
    cacheTexts.some((t) => t.includes('GET /plugins/')) &&
    cacheTexts.some((t) => t.includes('GET /wallpaper-engine/scene-audio/xyz')),
  cacheTexts.filter((t) => /MB|KB|GET |B$/.test(t)).slice(0, 8).join(' | '),
);
check(
  '缓存：没带缓存口径的那几行会写明「下次仍会重传」与具体原因',
  cacheTexts.some((t) => t.includes('1 次无缓存口径 → 下次仍会重传')) &&
    cacheTexts.some((t) => t.includes('原因：带 Range 的分段请求（bytes=0-；浏览器不缓存 206）')),
  cacheTexts.filter((t) => t.includes('原因：') || t.includes('无缓存口径')).join(' | '),
);
// 「刷新 / 清零本轮统计」两个按钮：清零后走一遍，回来这几行就是那一轮的真实花费
const refreshButton = buttons(tree).find((b) => textOf(b) === '刷新');
const resetButton = buttons(tree).find((b) => textOf(b) === '清零本轮统计');
check(
  '缓存：有「刷新」与「清零本轮统计」两个按钮（按钮文案与说明分开写）',
  refreshButton !== undefined && resetButton !== undefined,
  buttons(tree).map((b) => textOf(b)).join(' | '),
);
globalThis.window.fetch = async (url) => {
  cacheFetches.push(String(url));
  return { status: 200, ok: true, json: async () => ({ ok: true, policy: {}, stats: {}, traffic: { totalOut: 0, totalIn: 0, wsOut: 0, wsIn: 0, uncachedOut: 0, top: [] } }) };
};
resetButton.props.onClick();
await sleep(40);
check(
  '缓存：点「清零本轮统计」会带 ?reset=1 再读一次',
  cacheFetches.some((url) => url.includes('reset=1')),
  cacheFetches.join(','),
);
// 收起再展开不该重复问（只在展开那一刻读一次）
const cacheFetchesAfterFirst = cacheFetches.length;
cacheHeader.props.onClick();
await sleep(10);
flatten(tree).find((n) => n?.type === 'button' && String(n?.props?.children ?? '').includes('缓存')).props.onClick();
await sleep(30);
check(
  '缓存：收起再展开才再读一次（收起状态零请求）',
  cacheFetches.length === cacheFetchesAfterFirst + 1,
  `${cacheFetchesAfterFirst} → ${cacheFetches.length}`,
);
// 宿主还没有这个接口（老版本）→ 说清「更新插件」，别含糊
globalThis.window.fetch = async () => ({ status: 404, ok: false, json: async () => null });
react.resetAll();
tree = Panel();
await sleep(60);
flatten(tree).find((n) => n?.type === 'button' && String(n?.props?.children ?? '').includes('缓存')).props.onClick();
await sleep(40);
check(
  '缓存：宿主没有缓存接口时说清「更新插件并重启」',
  flatten(tree).some((n) => String(n?.props?.children ?? '').includes('还没有缓存接口')),
  flatten(tree).map((n) => String(n?.props?.children ?? '')).find((t) => t.includes('缓存')) ?? '(没有)',
);
delete globalThis.window.fetch;

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
    // 0.2.1 的 UI 设置投影会读/写 body 的 CSS 变量；这里给一个最小可用的 style
    style: {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] ?? ''; },
    },
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
    // 编辑器桩子：插换行那三条路都要往它身上派事件；`onEvent` 让测试扮演 Lexical（收到
    // beforeinput/insertLineBreak 或 shift+回车就往 textContent 里加一个换行）
    dispatchEvent(ev) {
      this.events = this.events ?? [];
      this.events.push(ev);
      if (typeof this.onEvent === 'function') this.onEvent(ev);
      return true;
    },
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
function installBackDom({ width = 390, drawerOpen = true, bodyAttrs = {}, coarse = false } = {}) {
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
    matches: /max-width/.test(query)
      ? width <= Number(/max-width:\s*(\d+)/.exec(query)[1])
      : /pointer:\s*coarse/.test(query)
        ? coarse
        : false,
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
function applyBackController({ isLoopback, remoteLayout, activePanel = null, withLayout = true, phoneEnterNewline = true }) {
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
          value: { writable: true, hasDocument: true, namespaces: [{ ns: 'remote-access', value: { remoteLayout, phoneEnterNewline }, revision: 1 }] },
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

// ---------------------------------------------------------------- 场景八：手机端回车 = 换行（不发送）
//
// 官方把「回车发送」挂在那棵 Lexical 编辑器上（冒泡阶段）。我们在 document 的捕获阶段先吃掉它，
// 再自己插一个换行。这一节要钉住的是三件事：
//   1. 手机端的裸回车被吃掉（preventDefault + stopPropagation），并且真的插了换行；
//   2. Shift/Ctrl/Cmd/Alt、输入法合成、别的输入框、电脑布局 —— 一条都不能误伤；
//   3. 本机页面与「关掉这个开关」的页面都不装监听。

/** 造一个带主输入框的 DOM；输入框自己扮演 Lexical（收到换行指令就往 textContent 里加 \n） */
function installComposerDom({ width = 390, coarse = false } = {}) {
  const dom = installBackDom({ width, drawerOpen: false, coarse });
  const composer = dom.makeBackEl('div', { 'data-composer-input': '' });
  composer.textContent = '写点什么';
  composer.onEvent = (ev) => {
    // 扮演编辑器：beforeinput(insertLineBreak)、execCommand 的等价路径、以及 shift+回车，
    // 三种做法都当作「插入了一个换行」—— 插件只要有一条走通就不该再往下试
    const isBreak = (ev.type === 'beforeinput' && ev.inputType === 'insertLineBreak') ||
      (ev.type === 'keydown' && ev.shiftKey === true && ev.key === 'Enter');
    if (isBreak) composer.textContent += '\n';
  };
  dom.body.appendChild(composer);
  const outside = dom.makeBackEl('input', {});
  dom.body.appendChild(outside);
  return { ...dom, composer, outside };
}

/**
 * 造一个**像真编辑器那样**的输入框：收到 beforeinput 就 preventDefault（Lexical 就是这么做的，
 * `client.js:5501` 那句 `switch (e.preventDefault(), n)`），而结果**异步**落到 DOM（下一帧才 +\n）。
 *
 * 这正是「一次回车插出两个换行」那个 bug 的现场：插件原来用同步读 textContent 判断「插成了没有」，
 * 异步提交让第一条路被判成没成，于是又走了第二条（execCommand），于是多出一个换行。
 */
function installAsyncEditorDom({ width = 390, coarse = true } = {}) {
  const dom = installBackDom({ width, drawerOpen: false, coarse });
  const composer = dom.makeBackEl('div', { 'data-composer-input': '' });
  composer.textContent = '写点什么';
  const committed = [];
  composer.onEvent = (ev) => {
    if (ev.type === 'beforeinput' && ev.inputType === 'insertLineBreak') {
      // Lexical：无条件 preventDefault（同步），结果稍后提交
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      committed.push('beforeinput');
      setTimeout(() => { composer.textContent += '\n'; }, 0);
      return;
    }
    if (ev.type === 'keydown' && ev.shiftKey === true && ev.key === 'Enter') {
      committed.push('shift+enter');
      setTimeout(() => { composer.textContent += '\n'; }, 0);
    }
  };
  dom.body.appendChild(composer);
  return { ...dom, composer, committed };
}

/** 派一个「可取消」的合成按键事件（桩子的 fireDoc 不看捕获/冒泡，只按类型喂） */
function keyEvent(init) {
  return {
    type: 'keydown',
    key: 'Enter',
    keyCode: 13,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...init,
  };
}

// ---- 手机端主输入框：裸回车 → 吃掉 + 换行
const enterDom = installComposerDom({ width: 390, coarse: true });
applyBackController({ isLoopback: false, remoteLayout: 'phone', phoneEnterNewline: true });
await sleep(80);
const enterEvent = keyEvent({ target: enterDom.composer });
const listeners = enterDom.fireDoc('keydown', enterEvent);
check(
  '回车换行：装了文档级 keydown 监听（捕获阶段）',
  listeners >= 1,
  `监听=${listeners}`,
);
check(
  '回车换行：手机端的裸回车被吃掉（官方那条「回车发送」收不到）',
  enterEvent.defaultPrevented === true && enterEvent.stopped === true,
  `preventDefault=${enterEvent.defaultPrevented} stopPropagation=${enterEvent.stopped}`,
);
check(
  '回车换行：换行真的插进去了（走的 beforeinput/insertLineBreak）',
  enterDom.composer.textContent === '写点什么\n' &&
    (enterDom.composer.events ?? []).some((ev) => ev.type === 'beforeinput' && ev.inputType === 'insertLineBreak'),
  JSON.stringify(enterDom.composer.textContent),
);

// ---- `data-composer-input` 挂在外面一层时：事件要落到里层的 contenteditable 上（真实 DOM 里两种挂法都有）
const wrappedDom = installComposerDom({ width: 390, coarse: true });
const wrappedInner = wrappedDom.makeBackEl('div', { contenteditable: 'true' });
wrappedInner.textContent = '外层宿主';
wrappedDom.composer.appendChild(wrappedInner); // composer（带 data-composer-input）里再套一层真正的编辑器
wrappedDom.composer.textContent = '外层宿主';
wrappedDom.composer.onEvent = undefined;
wrappedInner.onEvent = (ev) => {
  if (ev.type === 'beforeinput' && ev.inputType === 'insertLineBreak') wrappedDom.composer.textContent += '\n';
};
applyBackController({ isLoopback: false, remoteLayout: 'phone', phoneEnterNewline: true });
await sleep(80);
const wrappedEvent = keyEvent({ target: wrappedDom.composer });
wrappedDom.fireDoc('keydown', wrappedEvent);
check(
  '回车换行：宿主在外面一层时，事件落到里层 contenteditable（两种挂法都能插进去）',
  wrappedEvent.defaultPrevented === true && wrappedDom.composer.textContent === '外层宿主\n',
  JSON.stringify(wrappedDom.composer.textContent),
);

// ---- 异步提交的编辑器（真实 Lexical 的样子）：一次回车只许插**一个**换行
//
// 这一条是给「一次回车插出两个换行」那个 bug 立的桩：编辑器同步 preventDefault、结果下一帧才落 DOM。
const asyncDom = installAsyncEditorDom();
applyBackController({ isLoopback: false, remoteLayout: 'phone', phoneEnterNewline: true });
await sleep(80);
const asyncEvent1 = keyEvent({ target: asyncDom.composer });
asyncDom.fireDoc('keydown', asyncEvent1);
await sleep(20);
check(
  '回车换行：编辑器异步提交时也只插一个换行（preventDefault 是同步信号，不再走第二条路）',
  asyncDom.committed.length === 1 &&
    asyncDom.committed[0] === 'beforeinput' &&
    asyncDom.composer.textContent === '写点什么\n',
  `committed=${JSON.stringify(asyncDom.committed)} text=${JSON.stringify(asyncDom.composer.textContent)}`,
);
const asyncEvent2 = keyEvent({ target: asyncDom.composer });
asyncDom.fireDoc('keydown', asyncEvent2);
await sleep(20);
check(
  '回车换行：连按两次就是两个换行（不翻倍）',
  asyncDom.committed.length === 2 && asyncDom.composer.textContent === '写点什么\n\n',
  `committed=${JSON.stringify(asyncDom.committed)} text=${JSON.stringify(asyncDom.composer.textContent)}`,
);

// ---- 编辑器完全不接管 beforeinput 时，才轮到第二条路，而且只走一条
const fallbackDom = installComposerDom({ width: 390, coarse: true });
fallbackDom.composer.onEvent = undefined; // 谁都不认 beforeinput
let execCalls = 0;
globalThis.document.execCommand = (cmd) => {
  execCalls += 1;
  if (cmd === 'insertLineBreak') {
    fallbackDom.composer.textContent += '\n';
    return true;
  }
  return false;
};
applyBackController({ isLoopback: false, remoteLayout: 'phone', phoneEnterNewline: true });
await sleep(80);
const fallbackEvent = keyEvent({ target: fallbackDom.composer });
fallbackDom.fireDoc('keydown', fallbackEvent);
check(
  '回车换行：编辑器不接管时才轮到 execCommand，且只调一次、只插一个',
  execCalls === 1 &&
    fallbackDom.composer.textContent === '写点什么\n' &&
    fallbackEvent.defaultPrevented === true,
  `execCommand ${execCalls} 次 / text=${JSON.stringify(fallbackDom.composer.textContent)}`,
);
delete globalThis.document.execCommand;

// ---- 放行：Shift / Ctrl / Cmd / Alt + 回车（Shift+Enter 本来就是换行；Ctrl/Cmd+Enter 是发送）
for (const [name, init] of [
  ['Shift+回车', { shiftKey: true }],
  ['Ctrl+回车', { ctrlKey: true }],
  ['Cmd+回车', { metaKey: true }],
  ['Alt+回车', { altKey: true }],
]) {
  const ev = keyEvent({ target: enterDom.composer, ...init });
  enterDom.fireDoc('keydown', ev);
  check(`回车换行：${name} 一律放行（那是官方自己的语义）`, ev.defaultPrevented === false && ev.stopped === false);
}

// ---- 放行：输入法（合成中 / 刚结束）—— 中文输入法用回车确认候选词，吃掉它等于打不了字
const composingEv = keyEvent({ target: enterDom.composer, isComposing: true });
enterDom.fireDoc('keydown', composingEv);
const imeKeyCodeEv = keyEvent({ target: enterDom.composer, keyCode: 229 });
enterDom.fireDoc('keydown', imeKeyCodeEv);
check(
  '回车换行：输入法合成中（isComposing / keyCode 229）不插手',
  composingEv.defaultPrevented === false && imeKeyCodeEv.defaultPrevented === false,
);
enterDom.fireDoc('compositionstart', { type: 'compositionstart' });
const duringCompose = keyEvent({ target: enterDom.composer });
enterDom.fireDoc('keydown', duringCompose);
enterDom.fireDoc('compositionend', { type: 'compositionend' });
const rightAfterCompose = keyEvent({ target: enterDom.composer });
enterDom.fireDoc('keydown', rightAfterCompose);
await sleep(90);
const afterGuard = keyEvent({ target: enterDom.composer });
enterDom.fireDoc('keydown', afterGuard);
check(
  '回车换行：合成中与刚合成完（60ms 窗口）都放行，窗口过了才恢复接管',
  duringCompose.defaultPrevented === false &&
    rightAfterCompose.defaultPrevented === false &&
    afterGuard.defaultPrevented === true,
  `合成中=${duringCompose.defaultPrevented} 刚结束=${rightAfterCompose.defaultPrevented} 过窗口=${afterGuard.defaultPrevented}`,
);

// ---- 放行：不在主输入框里（设置页的输入框、行内编辑器都不该被碰）
const outsideEvent = keyEvent({ target: enterDom.outside });
enterDom.fireDoc('keydown', outsideEvent);
check('回车换行：不在主输入框里的一律不碰', outsideEvent.defaultPrevented === false && outsideEvent.stopped === false);
const noTargetEvent = keyEvent({ target: null });
enterDom.fireDoc('keydown', noTargetEvent);
check('回车换行：没有 target 也不炸', noTargetEvent.defaultPrevented === false);

// ---- 别的键（打字、退格）照常放行
const letterEvent = keyEvent({ target: enterDom.composer, key: 'a', keyCode: 65 });
enterDom.fireDoc('keydown', letterEvent);
check('回车换行：别的按键完全不插手', letterEvent.defaultPrevented === false);

// ---- 关掉开关 → 回车回到「发送」
const enterOffDom = installComposerDom({ width: 390, coarse: true });
applyBackController({ isLoopback: false, remoteLayout: 'phone', phoneEnterNewline: false });
await sleep(80);
const offEvent = keyEvent({ target: enterOffDom.composer });
enterOffDom.fireDoc('keydown', offEvent);
check(
  '回车换行：配置关掉后恢复原样（回车仍然是发送）',
  offEvent.defaultPrevented === false && offEvent.stopped === false && enterOffDom.composer.textContent === '写点什么',
  JSON.stringify(enterOffDom.composer.textContent),
);

// ---- 电脑布局 + 不是触摸设备 → 不接管（远程的电脑浏览器保持原样）
const deskEnterDom = installComposerDom({ width: 1400, coarse: false });
applyBackController({ isLoopback: false, remoteLayout: 'desktop', phoneEnterNewline: true });
await sleep(80);
const deskEvent = keyEvent({ target: deskEnterDom.composer });
deskEnterDom.fireDoc('keydown', deskEvent);
check(
  '回车换行：电脑布局 + 非触摸 → 不接管（回车仍然是发送）',
  deskEvent.defaultPrevented === false && deskEnterDom.composer.textContent === '写点什么',
);

// ---- 粗指针设备（平板/触摸笔记本）即使选了电脑布局也要接管 —— 这是「两者都算」的那一半
const coarseDeskDom = installComposerDom({ width: 1400, coarse: true });
applyBackController({ isLoopback: false, remoteLayout: 'desktop', phoneEnterNewline: true });
await sleep(80);
const coarseEvent = keyEvent({ target: coarseDeskDom.composer });
coarseDeskDom.fireDoc('keydown', coarseEvent);
check(
  '回车换行：粗指针设备（触摸）就算选了电脑布局也接管',
  coarseEvent.defaultPrevented === true && coarseDeskDom.composer.textContent === '写点什么\n',
  JSON.stringify(coarseDeskDom.composer.textContent),
);

// ---- 本机页面：一个监听都不装（连 data-ra-layout 都不会有）
const localEnterDom = installComposerDom({ width: 390, coarse: true });
applyBackController({ isLoopback: true, remoteLayout: 'phone', phoneEnterNewline: true });
await sleep(80);
const localEvent = keyEvent({ target: localEnterDom.composer });
const localListeners = localEnterDom.fireDoc('keydown', localEvent);
check(
  '回车换行：本机页面不装监听（本机界面一个像素、一个按键都不动）',
  localListeners === 0 && localEvent.defaultPrevented === false && localEnterDom.composer.textContent === '写点什么',
  `监听=${localListeners}`,
);

// ---- 停用（控制器清理）→ 监听收回
const stopEnterDom = installComposerDom({ width: 390, coarse: true });
const stopEnter = applyBackController({ isLoopback: false, remoteLayout: 'phone', phoneEnterNewline: true });
await sleep(80);
const beforeStop = keyEvent({ target: stopEnterDom.composer });
stopEnterDom.fireDoc('keydown', beforeStop);
stopEnter();
const afterStop = keyEvent({ target: stopEnterDom.composer });
stopEnterDom.fireDoc('keydown', afterStop);
check(
  '回车换行：停用后监听收回（HMR 重挂 / 卸载后不留后手）',
  beforeStop.defaultPrevented === true &&
    afterStop.defaultPrevented === false &&
    (stopEnterDom.docListeners.get('keydown')?.size ?? 0) === 0,
  `停用前=${beforeStop.defaultPrevented} 停用后=${afterStop.defaultPrevented} 监听=${stopEnterDom.docListeners.get('keydown')?.size ?? 0}`,
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
