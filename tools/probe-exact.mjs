// 精确量出正文列与输入框的实际宽度/内边距，对比两种改法的差异。
// 用法: node tools/probe-exact.mjs <url> <code> [cdp-port]
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/15861/.dsh/profiles/desktop/package.json');
const WebSocket = require('ws');

const url = process.argv[2];
const code = process.argv[3];
const port = Number(process.argv[4] || 9336);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });
await sleep(6000);
await evaluate(`(() => {
  const inp = document.querySelector('input[type="password"], input');
  if (!inp) return;
  inp.value = ${JSON.stringify(code)};
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.closest('form')?.submit();
})()`);
await sleep(10000);

const out = await evaluate(`(() => {
  const cs = (el) => getComputedStyle(el);
  const res = { viewport: innerWidth, raCenterExists: !!document.querySelector('[data-ra-center]') };

  // 所有匹配 _scroll 的元素，逐个打印内边距
  res.scrolls = [...document.querySelectorAll('[class*="_scroll"]')].slice(0, 6).map((el) => {
    const s = cs(el);
    const r = el.getBoundingClientRect();
    return {
      cls: String(el.className || '').slice(0, 30),
      w: Math.round(r.width),
      padL: s.paddingLeft, padR: s.paddingRight,
      clearance: s.getPropertyValue('--dsh-composer-side-clearance').trim(),
      insideCenter: !!el.closest('[data-ra-center]'),
    };
  });

  // 正文列实际宽度（chat 包的 column）
  const col = document.querySelector('[class*="_column"]');
  if (col) {
    const r = col.getBoundingClientRect();
    const s = cs(col);
    res.column = { w: Math.round(r.width), x: Math.round(r.x), right: Math.round(r.right), maxW: s.maxWidth, contentW: s.getPropertyValue('--dsh-chat-content-width').trim() };
  }

  // 输入框卡片
  const card = document.querySelector('[data-slot="conversation.composer.bar"] [class*="_card"]');
  if (card) {
    const r = card.getBoundingClientRect();
    const s = cs(card);
    res.composerCard = { w: Math.round(r.width), x: Math.round(r.x), right: Math.round(r.right), padL: s.paddingLeft, padR: s.paddingRight };
  }
  return res;
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
await sleep(300);
