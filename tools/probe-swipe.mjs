// 用合成 TouchEvent 验证手势代码路径：派发一次从右向左的滑动，看右栏是否真的打开。
// 同时记录 horizontalOwner 的判定结果，定位是哪一层把它挡掉的。
// 用法: node tools/probe-swipe.mjs <url> [cdp-port]
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/15861/.dsh/profiles/desktop/package.json');
const WebSocket = require('ws');

const url = process.argv[2];
const port = Number(process.argv[3] || 9336);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* 等 */ }
    await sleep(250);
  }
  throw new Error('没有可用的页面 target');
}

const page = await getPage();
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

let seq = 0;
const pending = new Map();
const logs = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url });
await sleep(12000);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

// 1) 基础环境检查
const env = await evaluate(`(() => {
  const html = document.documentElement;
  return {
    raLayout: html.getAttribute('data-ra-layout'),
    hasFrame: !!document.querySelector('[data-ra-frame]'),
    hasBackApi: !!window.__dshRaBack,
    hasLayoutService: (() => { try { return typeof window.__dshRemote !== 'undefined'; } catch { return null; } })(),
    rightExpandBtn: !!document.querySelector('[data-sidebar-right-expand]'),
    openerBtn: !!document.querySelector('[data-sidebar-opener]'),
    touchSupported: typeof TouchEvent !== 'undefined',
    innerW: innerWidth,
  };
})()`);
console.log('=== 环境 ===');
console.log(JSON.stringify(env, null, 2));

// 2) 派发一次「向左滑」：从 x=300 滑到 x=150（位移 150px，远超阈值）
const swipeResult = await evaluate(`(() => {
  const target = document.elementFromPoint(200, 400);
  if (!target) return { error: 'no element at 200,400' };
  const mk = (type, x, y) => {
    const t = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
    return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true });
  };
  const before = { rightOpen: !!document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]') };
  window.dispatchEvent(mk('touchstart', 300, 400));
  window.dispatchEvent(mk('touchmove', 260, 402));
  window.dispatchEvent(mk('touchmove', 200, 404));
  window.dispatchEvent(mk('touchmove', 150, 405));
  window.dispatchEvent(mk('touchend', 150, 405));
  return { before, dispatched: true, targetTag: target.tagName, targetCls: String(target.className||'').slice(0,60) };
})()`);
console.log('\n=== 派发左滑 ===');
console.log(JSON.stringify(swipeResult, null, 2));

await sleep(1500);

const after = await evaluate(`(() => ({
  rightPanelOpenAttr: document.querySelector('[data-sidebar-right-panel]')?.getAttribute('data-sidebar-right-open') ?? null,
  frameAttrs: [...(document.querySelector('[data-ra-frame]')?.attributes ?? [])].map(a => a.name),
  rightToggleVisible: (() => { const b = document.querySelector('[data-sidebar-right-toggle]'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0; })(),
}))()`);
console.log('\n=== 左滑之后 ===');
console.log(JSON.stringify(after, null, 2));

console.log('\n=== 页面日志 ===');
console.log(logs.slice(-15).join('\n') || '(空)');

ws.close();
await sleep(300);
