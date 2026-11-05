// test-client.mjs —— 用极简 React / 宿主桩子把 client.js 真跑一遍（不需要 DSH、不需要浏览器）。
//
// 1.5.0 起的契约：设置页**只**通过本插件自己的 `/__remote_access__/config` 读写
// `$DSH_HOME/remote-access-config.json`，不碰 DSH 的 configForms / ctx.remote.settings。
// 这里用一个假的 fetch 模拟宿主端点，覆盖：读、保存（只提交改动字段 + revision 栅栏）、
// 409 冲突、读失败、本机/远程两种页面、布局与 UI 投影。
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
      queueMicrotask(fn);
    },
  };
  return {
    React,
    reset: () => { cursor = 0; },
    resetAll: () => { hooks = []; deps = []; cursor = 0; },
    onSchedule: (fn) => { schedule = fn; },
  };
}

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
const allText = (tree) => flatten(tree).map((n) => String(n?.props?.children ?? '')).join('\n');

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
check('注册进 settings.section', plugin.inject.includes('slots') && plugin.inject.includes('remote'));
check(
  '不再声明 configForms / remote.settings（不读写共享 profile）',
  !plugin.inject.includes('configForms') && !plugin.inject.includes('remote.settings'),
  plugin.inject.join(','),
);

const pkgVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(clientPath), 'package.json'), 'utf8')).version;
const declared = /const CLIENT_VERSION = '([^']+)'/.exec(fs.readFileSync(clientPath, 'utf8'))?.[1];
check('CLIENT_VERSION 与 package.json 一致', declared === pkgVersion, `client=${declared} package=${pkgVersion}`);

// ---------------------------------------------------------------- 假宿主：配置端点 + 通知/缓存
const CONFIG_PATH = '/__remote_access__/config';
const CONFIG_FILE = 'C:\\Users\\tester\\.dsh\\remote-access-config.json';
let serverConfig = {
  enabled: true,
  allowCidrs: ['100.64.0.0/10'],
  denyCidrs: [],
  port: 19388,
  maxConnections: 66,
  logLevel: 'silent',
  accessCode: '864209',
  remoteLayout: 'auto',
};
let serverRevision = 3;
let configFails = false;
/** 自定义 CSS 端点返回的内容（空串 = 文件不存在） */
let customCss = '';
const fetchCalls = [];
const jsonRes = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
globalThis.window.fetch = async (url, init = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, init });
  if (u.startsWith(CONFIG_PATH)) {
    if (configFails) throw new Error('（测试）连接断了');
    if (String(init.method ?? 'GET').toUpperCase() === 'GET') {
      return jsonRes({ ok: true, path: CONFIG_FILE, revision: serverRevision, config: { ...serverConfig } });
    }
    const body = JSON.parse(String(init.body ?? '{}'));
    if (body.revision !== undefined && body.revision !== serverRevision) {
      return jsonRes({ ok: true, error: 'revision mismatch', path: CONFIG_FILE, revision: serverRevision, config: { ...serverConfig } }, 409);
    }
    serverConfig = { ...serverConfig, ...(body.patch ?? {}) };
    serverRevision += 1;
    return jsonRes({ ok: true, path: CONFIG_FILE, revision: serverRevision, config: { ...serverConfig } });
  }
  if (u.startsWith('/__remote_access__/notify')) {
    return jsonRes({ ok: true, enabled: true, pending: [], desktop: { known: false, visible: false }, phone: null });
  }
  if (u.startsWith('/__remote_access__/cache')) {
    return jsonRes({ ok: true, policy: { enabled: true, ttlMinutes: 10, probe: true }, stats: {}, traffic: null });
  }
  if (u.startsWith('/__remote_access__/presence')) return { status: 204, ok: true, json: async () => null };
  if (u.startsWith('/__remote_access__/custom.css')) {
    return jsonRes({ ok: true, present: customCss !== '', css: customCss, path: 'C:\\Users\\tester\\.dsh\\remote-access-custom.css', error: '' });
  }
  return jsonRes({ ok: false, error: 'not found' }, 404);
};

// ---------------------------------------------------------------- 页面桩子
let Panel = null;
/** 最后一次 slots.register 传进去的 label（验证 i18n 的 section 标题） */
let lastRegisteredLabel = null;
function makeCtx({ isLoopback = false, themeCalls = null } = {}) {
  const ctx = {
    remote: { $host: { isLoopback } },
    on: () => () => {},
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => {
        Panel = Component;
        lastRegisteredLabel = options?.label ?? null;
        return () => {};
      },
    },
    get: (name) => {
      if (name !== 'theme' || themeCalls === null) return undefined;
      return {
        getTheme: () => ({ preference: 'system', active: { colorScheme: 'light', tokens: {} }, fontSizes: { text: 14, code: 14, terminal: 14 } }),
        setTheme: (id) => themeCalls.push(['setTheme', id]),
        setFontSize: (...args) => themeCalls.push(['setFontSize', ...args]),
      };
    },
  };
  return ctx;
}

let tree = null;
const render = () => {
  react.reset();
  tree = Panel();
};
react.onSchedule(render);
const valueOf = (key) => byKey(tree, `${key}-i`)?.props?.value;

// ---------------------------------------------------------------- 场景一：远程（手机）页面
serverConfig = { ...serverConfig, port: 19388, maxConnections: 66, logLevel: 'silent' };
serverRevision = 3;
plugin.apply(makeCtx({ isLoopback: false }));
check('拿到设置页组件', typeof Panel === 'function');
render();
await sleep(80);

check('远程页面：从插件端点读到端口', valueOf('port') === '19388', JSON.stringify(valueOf('port')));
check('远程页面：读到并发上限', valueOf('maxConnections') === '66', JSON.stringify(valueOf('maxConnections')));
check('远程页面：读到访问密码', valueOf('accessCode') === '864209', JSON.stringify(valueOf('accessCode')));
check('远程页面：0 值显示成空（让占位符露出）', byKey(tree, 'port-i')?.props?.placeholder === '0=随机');
check('远程页面：页脚显示配置来源，不再是共享 profile', allText(tree).includes(CONFIG_FILE) && allText(tree).includes('插件不读也不写共享 profile'));

// 保存：只提交改动字段，并带 revision
byKey(tree, 'port-i').props.onChange({ target: { value: '19389' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(80);
const postCall = fetchCalls.find((c) => c.url.startsWith(CONFIG_PATH) && String(c.init.method ?? '').toUpperCase() === 'POST');
const postBody = postCall ? JSON.parse(String(postCall.init.body)) : null;
check('保存：只把改动过的字段提交给插件端点', postBody !== null && JSON.stringify(Object.keys(postBody.patch)) === '["port"]' && postBody.patch.port === 19389, JSON.stringify(postBody));
check('保存：带上了 revision 栅栏', postBody?.revision === 3, String(postBody?.revision));
check('保存：服务端文件更新后再渲染出新值', serverConfig.port === 19389 && valueOf('port') === '19389', JSON.stringify(serverConfig.port));
check('保存：页面提示已保存', allText(tree).includes('已保存'));

// 409：别处改过 → 不当成功，提示重新读取
serverRevision += 1;
byKey(tree, 'maxConnections-i').props.onChange({ target: { value: '12' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(80);
check('保存冲突：提示「重新读取」而不是谎报成功', allText(tree).includes('重新读取') || allText(tree).includes('写入被拒绝'), allText(tree).split('\n').find((t) => t.includes('拒绝') || t.includes('重新读取')) ?? '');

// 读失败：页面上看得见，不是空白
configFails = true;
plugin.apply(makeCtx({ isLoopback: false }));
react.resetAll();
render();
await sleep(120);
check('读失败：页面写明「读不到本用户配置」', allText(tree).includes('读不到本用户配置'), allText(tree).match(/读不到本用户配置[^\n]*/)?.[0] ?? '');
configFails = false;
serverRevision += 1;

// ---------------------------------------------------------------- 场景二：本机（回环）页面
//
// 同一套端点、同一份 JSON；这里没有任何 configForms / remote.settings 可退。
serverConfig = { ...serverConfig, port: 19388, maxConnections: 64, logLevel: 'info' };
serverRevision += 1;
plugin.apply(makeCtx({ isLoopback: true }));
react.resetAll();
render();
await sleep(80);
check('本机页面：同样从插件端点读到 64', valueOf('maxConnections') === '64', JSON.stringify(valueOf('maxConnections')));
const beforeLocalPosts = fetchCalls.filter((c) => c.url.startsWith(CONFIG_PATH) && String(c.init.method ?? '').toUpperCase() === 'POST').length;
byKey(tree, 'maxConnections-i').props.onChange({ target: { value: '70' } });
await sleep(10);
buttons(tree).find((b) => textOf(b) === '保存').props.onClick();
await sleep(80);
const afterLocalPosts = fetchCalls.filter((c) => c.url.startsWith(CONFIG_PATH) && String(c.init.method ?? '').toUpperCase() === 'POST').length;
check('本机页面：保存走的也是同一个插件端点（没有 configForms）', afterLocalPosts === beforeLocalPosts + 1);
check('本机页面：写进同一份 JSON', serverConfig.maxConnections === 70, String(serverConfig.maxConnections));

// ---------------------------------------------------------------- 场景三：远程 UI 布局
function makeEl(tag, attrs = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentElement: null,
    dataset: {},
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
    querySelectorAll(sel) {
      const s = String(sel);
      const all = collectAll(this).slice(1);
      if (s === 'button') return all.filter((el) => el.tagName === 'BUTTON');
      if (s.startsWith('[class*=')) return all.filter((el) => String(el.getAttribute('class') ?? '').includes('_railMark') || String(el.getAttribute('class') ?? '').includes('_panelIcon'));
      return [];
    },
    contains() { return false; },
  };
  return el;
}
function installDom({ width = 1386, coarse = false, lang = null } = {}) {
  const html = makeEl('html');
  // 真实 DOM 里 lang 是 IDL 属性（client.js 读的是 documentElement.lang），
  // 只塞 attribute 是读不到的 —— 这一行的缺失曾让英文分支长期零覆盖。
  html.lang = lang ?? '';
  const head = makeEl('head');
  const body = makeEl('body');
  const styles = [];
  const customTags = [];
  // 侧栏桩：client.js 用 querySelector('[data-ra-sidebar]') 找侧栏、在里面找官方展开按钮
  const sidebarStub = installSidebarStub();
  const fakeSidebar = makeEl('div');
  fakeSidebar.setAttribute('data-ra-sidebar', '');
  fakeSidebar.appendChild(sidebarStub.toggle);
  fakeSidebar.appendChild(sidebarStub.other);
  // frame：syncDom 的一切标记都挂在它上面。**必须存在**，否则 syncDom 会在第一行就 return，
  // 收起态 / 自定义 CSS 的用例全都会假失败。
  const fakeFrame = makeEl('div');
  // 侧栏**收起**态 = frame 带 data-sidebar-collapsed（这正是 syncDom 判 drawer 的依据）。
  // 不加这一行，frame 会被当成「抽屉展开」，收起态那组用例永远不会走到。
  fakeFrame.setAttribute('data-sidebar-collapsed', '');
  fakeFrame.appendChild(fakeSidebar);
  const media = (query) => ({
    matches: /max-width/.test(query) ? width <= Number(/max-width:\s*(\d+)/.exec(query)[1]) : coarse,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.document = {
    documentElement: html,
    head,
    body,
    createElement: (tag) => {
      const el = makeEl(tag);
      if (tag === 'style') styles.push(el);
      return el;
    },
    getElementById: () => null,
    querySelector: (sel) => {
      const s = String(sel);
      if (s === '[data-slot="root"] > *') return fakeFrame;
      if (s === '[data-ra-sidebar]') return fakeSidebar;
      if (s.startsWith('[data-ra-frame]')) return fakeFrame;
      if (s.startsWith('style[')) {
        if (s.includes('custom.css')) return customTags.find((el) => el.dataset.raCustomCss) ?? null;
        return styles.find((el) => el.dataset.raLayoutCss) ?? null;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const s = String(sel);
      if (s === '[data-ra-rail-float]') {
        return [...fakeSidebar.children, ...collectAll(body)].filter((el) => el.hasAttribute('data-ra-rail-float'));
      }
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  // createElement 产生的 <style> 也要能被 querySelector 找到（自定义 CSS 用）
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'style') {
      customTags.push(el);
      const origSet = el.setAttribute;
      el.setAttribute = (n, v) => {
        origSet.call(el, n, v);
        if (n === 'data-ra-custom-css') styles.push(el);
      };
    }
    return el;
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.window.matchMedia = media;
  globalThis.window.setTimeout = setTimeout;
  return { html, head, body, styles, customTags, sidebar: fakeSidebar, frame: fakeFrame, toggle: sidebarStub.toggle, other: sidebarStub.other };
}

/** 递归收集元素树（给 querySelectorAll 的桩子用） */
function collectAll(root, out = []) {
  if (!root) return out;
  out.push(root);
  for (const child of root.children ?? []) collectAll(child, out);
  return out;
}


/**
 * 一个够用的「官方侧栏」：收起态那枚官方展开按钮（带鲸鱼 railMark），
 * 外加一枚不该被误标的正文按钮。用来验证零宽收起态只认官方那枚。
 */
function installSidebarStub({ expandLabel = '打开侧边栏' } = {}) {
  const railMark = makeEl('span');
  railMark.setAttribute('class', 'x_railMark');
  const toggle = makeEl('button');
  toggle.setAttribute('aria-label', expandLabel);
  toggle.appendChild(railMark);
  const other = makeEl('button');
  other.setAttribute('aria-label', '发送');
  return { toggle, other };
}

function applyWithLayout({ isLoopback, remoteLayout }) {
  serverConfig = { ...serverConfig, remoteLayout };
  serverRevision += 1;
  let panel = null;
  plugin.apply({
    remote: { $host: { isLoopback } },
    on: () => () => {},
    slots: { inject: (_n, cb) => cb(), register: (_o, C) => { panel = C; return () => {}; } },
  });
  return panel;
}

const localDom = installDom({ width: 390, coarse: true }); // 故意用手机尺寸：判据不是宽度
applyWithLayout({ isLoopback: true, remoteLayout: 'phone' });
await sleep(100);
check('本机页面：不设 data-ra-layout（哪怕 390px + 配置 phone）', localDom.html.getAttribute('data-ra-layout') === null, String(localDom.html.getAttribute('data-ra-layout')));
check('本机页面：不注入任何样式', localDom.styles.length === 0, `${localDom.styles.length} 个 <style>`);

const forcedDom = installDom({ width: 1386, coarse: false });
applyWithLayout({ isLoopback: false, remoteLayout: 'phone' });
await sleep(100);
check('远程页面：配置 phone 时无视宽度', forcedDom.html.getAttribute('data-ra-layout') === 'phone', String(forcedDom.html.getAttribute('data-ra-layout')));
check('远程页面：注入手机布局样式表', forcedDom.styles.length === 1 && forcedDom.styles[0].textContent.includes('data-ra-settings-panel'), `${forcedDom.styles.length} 个`);

const deskDom = installDom({ width: 390, coarse: true });
applyWithLayout({ isLoopback: false, remoteLayout: 'desktop' });
await sleep(100);
check('远程页面：配置 desktop 时窄屏也不上手机布局', deskDom.html.getAttribute('data-ra-layout') === 'desktop', String(deskDom.html.getAttribute('data-ra-layout')));

const autoNarrow = installDom({ width: 390, coarse: false });
applyWithLayout({ isLoopback: false, remoteLayout: 'auto' });
await sleep(100);
check('远程页面：auto + 窄视口 → phone', autoNarrow.html.getAttribute('data-ra-layout') === 'phone', String(autoNarrow.html.getAttribute('data-ra-layout')));

const autoTouch = installDom({ width: 1180, coarse: true });
applyWithLayout({ isLoopback: false, remoteLayout: 'auto' });
await sleep(100);
check('远程页面：auto + 触摸 → phone', autoTouch.html.getAttribute('data-ra-layout') === 'phone', String(autoTouch.html.getAttribute('data-ra-layout')));

// ---------------------------------------------------------------- 场景四：UI 设置只投影本页
//
// 外观 / 字号投影到 DOM；另外三项跟随电脑设置。**官方 setTheme/setFontSize 一个都不许调**。
const uiDom = installDom({ width: 1386, coarse: false });
const themeCalls = [];
serverConfig = { ...serverConfig, remoteTheme: 'dark', remoteFontSize: 16, remoteTranscriptView: 'verbose', remoteDeveloperTools: 'off', remotePerformanceUsage: 'compact' };
serverRevision += 1;
plugin.apply(makeCtx({ isLoopback: false, themeCalls }));
await sleep(120);
check('UI 设置：外观投影到本页（dark）', uiDom.html.style.colorScheme === 'dark' && uiDom.html.getAttribute('data-ds-theme-source') === 'dark', JSON.stringify(uiDom.html.style.colorScheme));
check('UI 设置：字号投影到 body 变量（16px）', String(uiDom.body?.style?.['--dsh-content-font-size']) === '16px', String(uiDom.body?.style?.['--dsh-content-font-size']));
check('UI 设置：官方 setTheme/setFontSize 一个都不调（不写电脑）', themeCalls.length === 0, JSON.stringify(themeCalls));
const localUiDom = installDom({ width: 1386, coarse: false });
const localThemeCalls = [];
plugin.apply(makeCtx({ isLoopback: true, themeCalls: localThemeCalls }));
await sleep(80);
check(
  'UI 设置：本机页不投影（回环页面一个像素都不动）',
  localUiDom.html.style.colorScheme === undefined && localThemeCalls.length === 0,
  String(localUiDom.html.style.colorScheme),
);

// ---------------------------------------------------------------- 场景五：窗口可见性上报
installDom({ width: 1386, coarse: false });
fetchCalls.length = 0;
plugin.apply(makeCtx({ isLoopback: true }));
await sleep(80);
check('窗口可见性：本机页面进页面就上报一次', fetchCalls.some((c) => c.url.startsWith('/__remote_access__/presence')), String(fetchCalls.length));
fetchCalls.length = 0;
plugin.apply(makeCtx({ isLoopback: false }));
await sleep(80);
check('窗口可见性：远程页面一个请求都不发', !fetchCalls.some((c) => c.url.startsWith('/__remote_access__/presence')));

// ---------------------------------------------------------------- 场景六：零宽收起态（Issue #6）
//
// 默认 phoneCollapsedRail=show：与 1.5.0 完全一致（48px 图标栏，不打 data-ra-rail）。
{
  const dom = installDom({ width: 1386, coarse: false });
  serverConfig = { ...serverConfig, phoneCollapsedRail: 'show', remoteLayout: 'phone' };
  serverRevision += 1;
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(120);
  check('收起态：默认 show 不打 data-ra-rail（老用户行为不变）', dom.html.getAttribute('data-ra-rail') === null, String(dom.html.getAttribute('data-ra-rail')));
  check('收起态：默认 show 不标悬浮按钮', dom.toggle.hasAttribute('data-ra-rail-float') === false);
  const css = dom.styles.find((s) => s.dataset.raLayoutCss)?.textContent ?? '';
  // 规则本身在样式表里是常驻的（靠 data-ra-rail 选择器门控），所以「show 时不生效」
  // 由上面的属性断言 + 这条选择器门控共同保证：没有 data-ra-rail 属性就匹配不上。
  check('收起态：默认 show 时零宽规则虽然存在，但选择器要求 data-ra-rail=hide', css.includes('[data-ra-rail="hide"]') && dom.html.getAttribute('data-ra-rail') === null);
}

{
  const dom = installDom({ width: 1386, coarse: false });
  serverConfig = { ...serverConfig, phoneCollapsedRail: 'hide', remoteLayout: 'phone' };
  serverRevision += 1;
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(120);
  check('收起态 hide：html 打上 data-ra-rail=hide', dom.html.getAttribute('data-ra-rail') === 'hide', String(dom.html.getAttribute('data-ra-rail')));
  check('收起态 hide：官方那枚展开按钮被标成悬浮', dom.toggle.hasAttribute('data-ra-rail-float') === true);
  check('收起态 hide：正文里别的按钮不被误标', dom.other.hasAttribute('data-ra-rail-float') === false);
  const css = dom.styles.find((s) => s.dataset.raLayoutCss)?.textContent ?? '';
  check('收起态 hide：样式表里有 0px 轨道规则', css.includes('[data-ra-rail="hide"]:not([data-ra-drawer]) [data-ra-frame]'));
  check('收起态 hide：悬浮按钮固定在左上角且避让安全区', /left:\s*calc\(8px \+ env\(safe-area-inset-left/.test(css));
  check('收起态 hide：层叠 62 低于抽屉 70', css.includes('z-index: 62 !important') && /z-index:\s*70 !important/.test(css));
}

// 英文界面下同样是官方那枚按钮（aria-label 变成 Open sidebar）
{
  const dom = installDom({ width: 1386, coarse: false, lang: 'en' });
  serverConfig = { ...serverConfig, phoneCollapsedRail: 'hide', remoteLayout: 'phone' };
  serverRevision += 1;
  // 换成英文标签的侧栏桩
  const en = installSidebarStub({ expandLabel: 'Open sidebar' });
  dom.sidebar.children.length = 0;
  dom.sidebar.appendChild(en.toggle);
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(120);
  check('收起态 hide：英文界面也认得官方展开按钮（Open sidebar）', en.toggle.hasAttribute('data-ra-rail-float') === true);
}

// ---------------------------------------------------------------- 场景七：自定义 CSS（只在远程页）
{
  const dom = installDom({ width: 1386, coarse: false });
  customCss = 'body { --probe: 1; }';
  fetchCalls.length = 0;
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(150);
  check('自定义 CSS：远程页面会去取端点', fetchCalls.some((c) => c.url.startsWith('/__remote_access__/custom.css')));
  check('自定义 CSS：内容进了页面的 <style>', dom.styles.some((s) => String(s.textContent).includes('--probe: 1')));
}

{
  const dom = installDom({ width: 1386, coarse: false });
  fetchCalls.length = 0;
  plugin.apply(makeCtx({ isLoopback: true }));
  await sleep(120);
  check('自定义 CSS：本机页面一个请求都不发', !fetchCalls.some((c) => c.url.startsWith('/__remote_access__/custom.css')));
  check('自定义 CSS：本机页面不注入', !dom.styles.some((s) => String(s.textContent).includes('--probe')));
}

{
  const dom = installDom({ width: 1386, coarse: false });
  customCss = '';
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(150);
  check('自定义 CSS：文件不存在时安静跳过，不建空 <style>', dom.styles.every((s) => !s.dataset.raCustomCss));
}

// ---------------------------------------------------------------- 场景八：语言跟随（i18n）
{
  const dom = installDom({ width: 1386, coarse: false, lang: 'en' });
  let panel = null;
  lastRegisteredLabel = null;
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(120);
  react.reset();
  const treeEn = Panel();
  check('i18n：lang=en 时设置页是英文', allText(treeEn).includes('Allowed network ranges') && !allText(treeEn).includes('允许的网段'));
  check('i18n：lang=en 时注册的 section 标签是 Remote access', lastRegisteredLabel === 'Remote access', String(lastRegisteredLabel));
}

{
  const dom = installDom({ width: 1386, coarse: false, lang: 'zh-CN' });
  lastRegisteredLabel = null;
  plugin.apply(makeCtx({ isLoopback: false }));
  await sleep(120);
  react.reset();
  const treeZh = Panel();
  check('i18n：lang=zh-CN 时设置页仍是中文', allText(treeZh).includes('允许的网段') && !allText(treeZh).includes('Allowed network ranges'));
}

// 运行期切换语言：<html lang> 变了 + 发一次 locale/change，不需要刷新页面
{
  const dom = installDom({ width: 1386, coarse: false, lang: 'zh-CN' });
  let langHandler = null;
  lastRegisteredLabel = null;
  plugin.apply({
    remote: { $host: { isLoopback: false } },
    on: (event, fn) => { if (event === 'locale/change') langHandler = fn; return () => {}; },
    slots: {
      inject: (_n, cb) => cb(),
      register: (options, C) => { Panel = C; lastRegisteredLabel = options?.label ?? null; return () => {}; },
    },
  });
  await sleep(120);
  check('运行期切语言：初始是中文', lastRegisteredLabel === '远程访问', String(lastRegisteredLabel));
  // 模拟 DSH 切换语言：官方先写 <html lang>，再广播事件
  dom.html.lang = 'en';
  react.reset();
  if (langHandler) langHandler('en');
  await sleep(30);
  check('运行期切语言：不刷新页面，注册标签就地变成 Remote access', lastRegisteredLabel === 'Remote access', String(lastRegisteredLabel));
  react.reset();
  check('运行期切语言：面板重渲染后是英文', allText(Panel()).includes('Allowed network ranges'));
}

delete globalThis.document;
delete globalThis.MutationObserver;

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
