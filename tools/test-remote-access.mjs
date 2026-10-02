// test-remote-access.mjs —— 不依赖 DSH 的功能测试（node tools/test-remote-access.mjs）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
const { apply, runOutsideHmr, banCidrOf, bannedHostsOf, mergeDenyCidrs, normalizeAccessCode } = await import(
  new URL('../index.js', import.meta.url).href
);

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

// 假上游：模拟 DSH 界面（把收到的 Host/Origin/token 回显出来）+ 一个 upgrade 端点
const upstream = http.createServer((req, res) => {
  const cookie = String(req.headers.cookie ?? '');
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  // 顺便模拟 DSH 的鉴权：cookie 失效且没票 → 401（那句英文）；带票 → 303 + 发一张新 cookie
  if (cookie.includes('dsh-auth-stale') && !token) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    return;
  }
  if (cookie.includes('dsh-auth-stale') && token) {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-fresh; Path=/; HttpOnly' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(
    `upstream host=${req.headers.host} origin=${req.headers.origin ?? '-'} xff=${req.headers['x-forwarded-for'] ?? '-'} token=${token ?? '-'}`,
  );
});
upstream.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.write('hello-ws');
  socket.end();
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

const statusFile = path.join(os.tmpdir(), `ra-test-${Date.now()}.txt`);
const logs = [];
const makeCtx = (extra = {}) => {
  const { configEditor, ...rest } = extra;
  return {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
    connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=TESTTOKEN` },
    effect: () => {},
    // 插件是用 ctx.get('configEditor') 取服务的（cordis 的访问器），所以这里要装成 get()
    get: (name) => (name === 'configEditor' ? configEditor : undefined),
    ...rest,
  };
};

/**
 * 假 configEditor：记录 edit() 收到的整份配置，用来断言「拉黑写进了排除的网段」。
 * fail=true 时模拟写盘失败（插件应退回暂存文件并继续拦住该地址）。
 */
const makeEditor = ({ denyCidrs = [], fail = false } = {}) => {
  const entry = { options: { id: 'remote-access', name: 'dsh-remote-access-cidr', config: { denyCidrs } } };
  const state = { calls: [] };
  return {
    state,
    current: () => entry.options.config,
    entries: () => [entry],
    edit: async (row, change) => {
      if (fail) throw new Error('（测试）模拟写盘失败');
      const next = change(structuredClone(row.options.config), {});
      row.options.config = next;
      state.calls.push(next);
      return next;
    },
  };
};

const readUrl = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const m = /远程访问网址: (\S+)/.exec(text);
  return { text, url: m && m[1] !== '（尚未生成）' ? m[1] : '' };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 直接打一次代理端口，方便断言状态码 / 头 / 正文 */
const call = (port, { method = 'GET', path: p = '/', headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: 'ERR ' + e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });

const unlockO = (port, body) =>
  call(port, {
    method: 'POST',
    path: '/__remote_access__/unlock',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

// ---- 场景 1：正常配置（允许回环）----
const dispose1 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile,
});
await new Promise((r) => setTimeout(r, 400));
const s1 = readUrl(statusFile);
check('状态文件生成', s1.text.length > 0);
check('带票网址含 token', s1.url.includes('token=TESTTOKEN'), s1.url);
const port1 = s1.url ? Number(new URL(s1.url).port) : 0;
check('能解析出监听端口', port1 > 0, String(port1));

const body = await new Promise((resolve) => {
  http
    .get({ host: '127.0.0.1', port: port1, path: '/', headers: { origin: 'http://127.0.0.1:9999' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    })
    .on('error', (e) => resolve('ERR ' + e.message));
});
check('HTTP 转发到上游', body.includes('upstream host='), body.slice(0, 80));
check('Host 改写成上游 authority', body.includes(`host=127.0.0.1:${upPort}`), (body.match(/host=[^ ]+/) ?? [''])[0]);
check('Origin 一并改写', body.includes(`origin=http://127.0.0.1:${upPort}`), (body.match(/origin=[^ ]+/) ?? [''])[0]);
check('补上 x-forwarded-for', /xff=127\.0\.0\.1/.test(body), (body.match(/xff=[^ ]+/) ?? [''])[0]);

// ---- 场景 2：WebSocket 升级透传 ----
const ws = await new Promise((resolve) => {
  const sock = net.connect(port1, '127.0.0.1', () => {
    sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port1}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  });
  let d = '';
  sock.on('data', (c) => {
    d += c.toString();
    if (d.includes('hello-ws')) {
      sock.destroy();
      resolve(d);
    }
  });
  sock.on('error', (e) => resolve('ERR ' + e.message));
  setTimeout(() => {
    sock.destroy();
    resolve(d || '(超时)');
  }, 2000);
});
check('WebSocket 101 与数据透传', ws.includes('101') && ws.includes('hello-ws'), ws.split('\r\n')[0]);

// ---- 场景 3：对端不在允许网段 → 403 ----
fs.writeFileSync(statusFile, '');
const dispose2 = apply(makeCtx(), {
  allowCidrs: ['10.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile,
});
await new Promise((r) => setTimeout(r, 400));
const s2 = readUrl(statusFile);
const port2 = s2.url ? Number(new URL(s2.url).port) : 0;
const code2 = await new Promise((resolve) => {
  http
    .get({ host: '127.0.0.1', port: port2, path: '/' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
    .on('error', () => resolve(0));
});
check('网段外对端被 403 拒绝', code2 === 403, `HTTP ${code2}`);

// ---- 场景 4：拿不到令牌时仍能工作（退化但不崩）----
const dispose3 = apply(
  { logger: logs.push.bind(logs), connection: {}, effect: () => {} },
  { allowCidrs: ['127.0.0.0/8'], listen: ['127.0.0.1'], port: 0, upstream: `http://127.0.0.1:${upPort}`, urlFile: statusFile },
);
await new Promise((r) => setTimeout(r, 400));
const s3 = readUrl(statusFile);
check('无 authenticatedUrl 时也写出状态与地址', s3.url.startsWith('http://127.0.0.1:'), s3.url);

// ---- 场景 5：解锁密码（网段内输一次即进；输错一次写进「排除的网段」）----
const statusFile2 = path.join(os.tmpdir(), `ra-unlock-${Date.now()}.txt`);
const banFile = path.join(os.tmpdir(), `ra-ban-${Date.now()}.txt`);
const unlockCfg = {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile2,
  banFile,
  accessCode: '864209',
};
const editor = makeEditor();
const dispose4 = apply(makeCtx({ configEditor: editor }), unlockCfg);
await sleep(400);
const s4 = readUrl(statusFile2);
const port4 = s4.url ? Number(new URL(s4.url).port) : 0;
check('解锁模式：状态文件给出裸地址与密码状态', /手机访问: http:\/\/127\.0\.0\.1:\d+\//.test(s4.text) && s4.text.includes('未设置') === false);
check('解锁模式：密码不进状态文件', !s4.text.includes('864209'));

const nav = await call(port4, { headers: { accept: 'text/html' } });
check('裸地址拿到解锁页（不复制 token）', nav.status === 200 && nav.body.includes('/__remote_access__/unlock'), `HTTP ${nav.status}`);

const empty = await unlockO(port4, 'code=');
check(
  '空密码不算一次尝试（不拉黑）',
  empty.status === 200 && !fs.existsSync(banFile) && editor.state.calls.length === 0,
  `HTTP ${empty.status}`,
);

const stale = await call(port4, { path: '/?token=STALE-FROM-ANOTHER-INSTANCE', headers: { accept: 'text/html' } });
check(
  '旧票/别人的票不算已授权 → 给解锁页（而不是 DSH 那句英文 401）',
  stale.status === 200 && stale.body.includes('/__remote_access__/unlock'),
  `HTTP ${stale.status}`,
);
const fresh = await call(port4, { path: '/?token=TESTTOKEN' });
check('本实例当前的票可用', fresh.status === 200 && fresh.body.includes('upstream host='), `HTTP ${fresh.status}`);

const wrong = await unlockO(port4, 'code=000000');
check('密码错误 → 403', wrong.status === 403, `HTTP ${wrong.status}`);
await sleep(300); // 等它把「排除的网段」写完
check(
  '错一次就写进「排除的网段」',
  JSON.stringify(editor.state.calls).includes('127.0.0.1/32'),
  JSON.stringify(editor.state.calls),
);
check(
  '写进配置后就不再占着暂存文件',
  !fs.existsSync(banFile),
  fs.existsSync(banFile) ? fs.readFileSync(banFile, 'utf8').trim() : '(无文件)',
);
const banned = await call(port4, { headers: { accept: 'text/html' } });
check('拉黑后一律 403', banned.status === 403, `HTTP ${banned.status}`);

// 解封 = 在设置页把「排除的网段」里那一项删掉（新实例的配置里已无它，暂存文件也是空的）
const dispose5 = apply(makeCtx({ configEditor: makeEditor() }), unlockCfg);
await sleep(400);
const port5 = Number(new URL(readUrl(statusFile2).url).port);
const ok = await unlockO(port5, 'code=864209');
const setCookie = String(ok.headers['set-cookie'] ?? '');
check('密码正确 → 303 + 放行 cookie', ok.status === 303 && setCookie.includes('dsh-ra-ok='), `HTTP ${ok.status}`);
const cookie = setCookie.split(';')[0];
const unlocked = await call(port5, { headers: { cookie, accept: 'text/html' } });
check('解锁后直达上游', unlocked.status === 200 && unlocked.body.includes('upstream host='), `HTTP ${unlocked.status}`);
check('服务端补票：浏览器看不到 token', unlocked.body.includes('token=TESTTOKEN'), (unlocked.body.match(/token=\S*/) ?? [''])[0]);

// 已授权但 URL 上带着旧票：转发前必须换成本实例当前这张，否则 DSH 会回它自己的 401
const swapped = await call(port5, {
  path: '/?token=STALE-FROM-ANOTHER-INSTANCE',
  headers: { cookie, accept: 'text/html' },
});
check(
  '已授权 + 旧票：转发前换成本实例当前的票',
  swapped.status === 200 && swapped.body.includes('token=TESTTOKEN') && !swapped.body.includes('STALE'),
  swapped.body,
);

// ---- 场景 5d：浏览器那张 DSH cookie 失效时，代理自动带票重试一次（DSH 会 303 发新 cookie）----
const healed = await call(port5, { headers: { cookie: 'dsh-auth-stale', accept: 'text/html' } });
check(
  '失效的 DSH cookie：自动带票重试 → 303 + 新 cookie（不再是那句英文 401）',
  healed.status === 303 && String(healed.headers['set-cookie'] ?? '').includes('dsh-auth-fresh'),
  `HTTP ${healed.status} ${String(healed.headers['set-cookie'] ?? '').slice(0, 40)}`,
);
const healedNav = await call(port5, { headers: { cookie: 'dsh-auth-fresh', accept: 'text/html' } });
check(
  '换到新 cookie 后正常直达上游',
  healedNav.status === 200 && healedNav.body.includes('upstream host='),
  `HTTP ${healedNav.status}`,
);
const noTicket = await call(port5, { headers: { cookie: 'dsh-auth-fresh' } });
check(
  '有效 cookie 不会被塞票（塞了 DSH 每次都会 303）',
  noTicket.status === 200 && noTicket.body.includes('token=-'),
  noTicket.body,
);

// ---- 场景 5b：写配置失败时，仍然立刻拦住 + 暂存下来（失败必须可见）----
const statusFile3 = path.join(os.tmpdir(), `ra-failban-${Date.now()}.txt`);
const banFile3 = path.join(os.tmpdir(), `ra-failban-ban-${Date.now()}.txt`);
const failCfg = { ...unlockCfg, urlFile: statusFile3, banFile: banFile3 };
const dispose5b = apply(makeCtx({ configEditor: makeEditor({ fail: true }) }), failCfg);
await sleep(400);
const port5b = Number(new URL(readUrl(statusFile3).url).port);
const wrong5b = await unlockO(port5b, 'code=000000');
await sleep(300);
const failText = fs.existsSync(statusFile3) ? fs.readFileSync(statusFile3, 'utf8') : '';
check('写盘失败：仍然 403', wrong5b.status === 403, `HTTP ${wrong5b.status}`);
check(
  '写盘失败：地址先暂存进拉黑文件',
  fs.existsSync(banFile3) && fs.readFileSync(banFile3, 'utf8').includes('127.0.0.1'),
  fs.existsSync(banFile3) ? '有文件' : '没有文件',
);
check('写盘失败：状态文件里写明原因', failText.includes('写进「排除的网段」失败'));
const stillBanned = await call(port5b, { headers: { accept: 'text/html' } });
check('写盘失败：暂存期间一样被拦', stillBanned.status === 403, `HTTP ${stillBanned.status}`);
dispose5b(); // 顺手清掉它的重试定时器

// ---- 场景 5c：拉黑写进配置后，热重载/重启都不会忘（配置才是权威，删项才解封）----
const statusFile4 = path.join(os.tmpdir(), `ra-banreload-${Date.now()}.txt`);
const banFile4 = path.join(os.tmpdir(), `ra-banreload-ban-${Date.now()}.txt`);
let row4 = {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile4,
  banFile: banFile4,
  accessCode: '864209',
};
const listened4 = [];
const editor4 = makeEditor();
const ctx4 = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=TESTTOKEN` },
  effect: () => {},
  on: (name, fn) => {
    listened4.push({ name, fn });
    return () => {};
  },
  get: (name) => {
    if (name === 'configEditor') return editor4;
    if (name === 'settings') return { describe: () => [{ ns: 'remote-access', base: {}, user: { ...row4 } }] };
    return undefined;
  },
};
const dispose5c = apply(ctx4, row4);
await sleep(400);
const port5c = Number(new URL(readUrl(statusFile4).url).port);
const wrong5c = await unlockO(port5c, 'code=000000');
await sleep(300);
check('写进配置后：暂存文件已清空', !fs.existsSync(banFile4), fs.existsSync(banFile4) ? '还有文件' : '(无文件)');
// 真实 DSH 里是 configEditor.edit 落盘 → settings 重新描述；这里手动反映到「生效配置」再触发重载
row4 = { ...row4, denyCidrs: editor4.current().denyCidrs };
for (const l of listened4.filter((x) => x.name === 'app-boot/config-reload')) l.fn();
await sleep(600);
const port5cAfter = Number(new URL(readUrl(statusFile4).url).port);
const afterReload = await call(port5cAfter, { headers: { accept: 'text/html' } });
check('热重载后依旧被拦（配置才是权威，不会忘）', afterReload.status === 403, `HTTP ${afterReload.status}`);
dispose5c();

// ---- 场景 6：热重载（app-boot/config-reload → 原地重挂监听）----
const hotFile = path.join(os.tmpdir(), `ra-hot-${Date.now()}.txt`);
const hotListeners = [];
let hotRow = {
  enabled: true,
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: hotFile,
  maxConnections: 64,
};
const hotCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=TESTTOKEN` },
  effect: () => {},
  on: (name, fn) => {
    hotListeners.push({ name, fn });
    return () => {};
  },
  get: (name) =>
    name === 'settings'
      ? { describe: () => [{ ns: 'remote-access', base: {}, user: { ...hotRow } }] }
      : undefined,
};
const dispose6 = apply(hotCtx, hotRow);
await sleep(400);
const hotBefore = readUrl(hotFile);
const portBefore = Number(new URL(hotBefore.url).port);
check('热重载：已挂上 app-boot/config-reload', hotListeners.some((l) => l.name === 'app-boot/config-reload'));

hotRow = { ...hotRow, maxConnections: 7 };
for (const l of hotListeners.filter((x) => x.name === 'app-boot/config-reload')) l.fn();
await sleep(500);
const hotAfter = readUrl(hotFile);
const portAfter = Number(new URL(hotAfter.url).port);
check('热重载：生效配置跟着更新', /"maxConnections": 7/.test(hotAfter.text), (hotAfter.text.match(/"maxConnections": \d+/) ?? [''])[0]);
check('热重载：监听端口已换（真的重挂了）', portAfter > 0 && portAfter !== portBefore, `${portBefore} → ${portAfter}`);
const oldPort = await call(portBefore, {});
check('热重载：旧监听已关闭', oldPort.status === 0, `status=${oldPort.status}`);
const newPort = await call(portAfter, {});
check('热重载：新监听可用', newPort.status === 200 && newPort.body.includes('upstream host='), `status=${newPort.status}`);

// ---- 场景 7：改密码不影响已登录状态（放行密钥与 accessCode 解耦）----
const rotFile = path.join(os.tmpdir(), `ra-rot-${Date.now()}.txt`);
const rotBan = path.join(os.tmpdir(), `ra-rotban-${Date.now()}.txt`);
const rotListeners = [];
let rotRow = {
  enabled: true,
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: rotFile,
  banFile: rotBan,
  accessCode: '864209',
};
const rotCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=TESTTOKEN` },
  effect: () => {},
  on: (name, fn) => {
    rotListeners.push({ name, fn });
    return () => {};
  },
  get: (name) =>
    name === 'settings'
      ? { describe: () => [{ ns: 'remote-access', base: {}, user: { ...rotRow } }] }
      : undefined,
};
const dispose7 = apply(rotCtx, rotRow);
await sleep(400);
const port7 = Number(new URL(readUrl(rotFile).url).port);

const firstUnlock = await unlockO(port7, 'code=864209');
const cookie7 = String(firstUnlock.headers['set-cookie'] ?? '').split(';')[0];
const beforeRotate = await call(port7, { headers: { cookie: cookie7, accept: 'text/html' } });
check('改密码前：放行 cookie 可用', beforeRotate.status === 200 && beforeRotate.body.includes('upstream host='), `HTTP ${beforeRotate.status}`);

// 模拟「在设置页把密码改成新的」→ 热重载
rotRow = { ...rotRow, accessCode: '246813' };
for (const l of rotListeners.filter((x) => x.name === 'app-boot/config-reload')) l.fn();
await sleep(500);
const port7b = Number(new URL(readUrl(rotFile).url).port);
const afterRotate = await call(port7b, { headers: { cookie: cookie7, accept: 'text/html' } });
check('改密码后：同一个 cookie 仍然可用（不踢人）',
  afterRotate.status === 200 && afterRotate.body.includes('upstream host='), `HTTP ${afterRotate.status}`);

const staleCode = await unlockO(port7b, 'code=864209');
check('改密码后：旧密码不再放行', staleCode.status === 403, `HTTP ${staleCode.status}`);

for (const d of [dispose1, dispose2, dispose3, dispose4, dispose5, dispose6, dispose7]) {
  try {
    d();
  } catch {
    /* 忽略 */
  }
}
upstream.close();
for (const f of [
  statusFile,
  statusFile2,
  statusFile3,
  statusFile4,
  banFile,
  banFile3,
  banFile4,
  hotFile,
  rotFile,
  rotBan,
  path.join(os.tmpdir(), 'remote-access-secret'),
]) {
  try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
}

// ---- 纯函数：拉黑地址 → CIDR、合并进「排除的网段」、以及逃出 HMR 的异步上下文 ----
check('banCidrOf：IPv4 用 /32', banCidrOf('100.64.0.5') === '100.64.0.5/32', banCidrOf('100.64.0.5'));
check('banCidrOf：IPv6 用 /128', banCidrOf('fe80::1') === 'fe80::1/128', banCidrOf('fe80::1'));
const mergedCidrs = mergeDenyCidrs({ denyCidrs: ['10.0.0.0/8'] }, {}, '10.0.0.5/32');
check(
  'mergeDenyCidrs：追加在原有项后面',
  mergedCidrs.denyCidrs.join(',') === '10.0.0.0/8,10.0.0.5/32',
  mergedCidrs.denyCidrs.join(','),
);
check('mergeDenyCidrs：重复项不会写两遍', mergeDenyCidrs(mergedCidrs, {}, '10.0.0.5/32').denyCidrs.length === 2);
check(
  'mergeDenyCidrs：patch 里没有该字段时基于继承值',
  mergeDenyCidrs({}, { denyCidrs: ['172.16.0.0/12'] }, '172.16.0.9/32').denyCidrs.join(',') ===
    '172.16.0.0/12,172.16.0.9/32',
);
const singleHosts = bannedHostsOf(['10.0.0.0/8', '100.64.0.5/32', '::1/128', '1.2.3.4']);
check(
  'bannedHostsOf：只挑单主机项（网段不算）',
  [...singleHosts].sort().join(',') === '1.2.3.4,100.64.0.5,::1',
  [...singleHosts].join(','),
);
const als = new AsyncLocalStorage();
const seenStore = als.run({ hmr: true }, () => runOutsideHmr(() => als.getStore() ?? null));
check(
  'runOutsideHmr：能逃出 HMR 的 AsyncLocalStorage（否则写配置必报嵌套）',
  seenStore === null,
  String(seenStore),
);

// ---- 场景 8：访问密码的规则（曾经静默丢弃非法值 → 用户以为设好了，手机却撞见英文 401）----
//
// 注意：主上游在场景 7 结束时已经 close 了，这里自己起一个「像 DSH 那样鉴权」的假上游：
// 只认本进程当前那张 TESTTOKEN，认了就 303 + 发新 cookie，否则一律回那句英文 401。
const authUpstream = http.createServer((req, res) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  if (token !== 'TESTTOKEN') {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    return;
  }
  res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-fresh; Path=/; HttpOnly' });
  res.end();
});
await new Promise((r) => authUpstream.listen(0, '127.0.0.1', r));
const authPort = authUpstream.address().port;

check('normalizeAccessCode：接受 4–12 位纯数字', normalizeAccessCode('864209') === '864209');
check('normalizeAccessCode：接受字母数字混排', normalizeAccessCode('1433223m') === '1433223m');
check('normalizeAccessCode：去掉首尾空白后仍然接受', normalizeAccessCode('  ab12cd  ') === 'ab12cd');
check('normalizeAccessCode：内有空格 → 不收', normalizeAccessCode('12 34 56') === '', JSON.stringify(normalizeAccessCode('12 34 56')));
check('normalizeAccessCode：含符号 → 不收', normalizeAccessCode('12-34-56') === '');
check('normalizeAccessCode：太短 → 不收', normalizeAccessCode('123') === '');
check('normalizeAccessCode：太长 → 不收', normalizeAccessCode('1234567890123') === '');

const illegalFile = path.join(os.tmpdir(), `ra-illegal-${Date.now()}.txt`);
const dispose8 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${authPort}`,
  urlFile: illegalFile,
  accessCode: '12-34-56', // 非法：含符号
});
await new Promise((r) => setTimeout(r, 400));
const illegalText = fs.readFileSync(illegalFile, 'utf8');
check(
  '非法密码不再静默失效：日志/状态文件里明确写出来',
  illegalText.includes('「访问密码」没生效'),
  (illegalText.match(/「访问密码」没生效[^\n]*/) ?? ['(没有告警)'])[0].slice(0, 60),
);
check('非法密码不会回显进状态文件', !illegalText.includes('12-34-56'));
const illegalPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(illegalText)?.[1] ?? 0);
check('非法密码时仍然照常监听（不带解锁页）', illegalPort > 0, String(illegalPort));
dispose8();

// ---- 场景 9：字母密码真的能用（解锁 → 放行）----
const alphaFile = path.join(os.tmpdir(), `ra-alpha-${Date.now()}.txt`);
const dispose9 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${authPort}`,
  urlFile: alphaFile,
  accessCode: '1433223m',
});
await new Promise((r) => setTimeout(r, 400));
const alphaPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(alphaFile, 'utf8'))?.[1] ?? 0);
check('字母密码：状态文件认作已设置', /解锁密码: 已设置/.test(fs.readFileSync(alphaFile, 'utf8')));
const alphaNav = await call(alphaPort, { headers: { accept: 'text/html' } });
check('字母密码：裸地址给解锁页', alphaNav.status === 200 && alphaNav.body.includes('/__remote_access__/unlock'), `HTTP ${alphaNav.status}`);
const alphaOk = await unlockO(alphaPort, 'code=1433223m');
check('字母密码：输对 → 303 + 放行 cookie', alphaOk.status === 303 && String(alphaOk.headers['set-cookie']).includes('dsh-ra-ok='), `HTTP ${alphaOk.status}`);
dispose9();

// ---- 场景 10：没凭据时的 401 页面（原来直接把 DSH 那句英文甩给用户）----
const noCredFile = path.join(os.tmpdir(), `ra-nocred-${Date.now()}.txt`);
const dispose10 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${authPort}`,
  urlFile: noCredFile,
  // 上游只有在带票时才放行：这里模拟「浏览器带了 DSH 认不出的 cookie」
});
await new Promise((r) => setTimeout(r, 400));
const noCredPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(noCredFile, 'utf8'))?.[1] ?? 0);

// 一张作废的票、浏览器里也没有任何 DSH cookie → 判不出身份 → 原样透传 → 上游 401
// （带 dsh-auth- cookie 的情况属于「已授权但 cookie 失效」，那条路是自动补票，见场景 5d）
const staleTicket = await call(noCredPort, {
  path: '/?token=STALE',
  headers: { accept: 'text/html' },
});
check(
  '作废的票：页面导航不再出现 DSH 那句英文',
  !staleTicket.body.includes('dsh web authentication required'),
  staleTicket.body.slice(0, 60),
);
check('作废的票：给出中文说明页', staleTicket.body.includes('这次没能通过校验'));
check(
  '作废的票：说明页里绝不带 token',
  !/token=[A-Za-z0-9]/.test(staleTicket.body),
  (staleTicket.body.match(/token=\S*/) ?? ['(无)'])[0],
);
check('作废的票：状态码仍然是 401（不假装通过）', staleTicket.status === 401, `HTTP ${staleTicket.status}`);
check('作废的票：说的是「票已作废」而不是「没带票」', staleTicket.body.includes('已经作废'));

// 完全没带票
const noCredTicket = await call(noCredPort, { headers: { accept: 'text/html' } });
check('完全没带票：也回中文说明页', noCredTicket.status === 401 && noCredTicket.body.includes('这次没能通过校验'));

// 子资源（非导航）的 401 必须保持原样，别把机器可读的错误换成 HTML
const subResource = await call(noCredPort, {
  path: '/api/thing?token=STALE',
  headers: { accept: 'application/json' },
});
check(
  '非导航请求的 401 原样透传（不动 RPC/子资源的语义）',
  subResource.status === 401 && subResource.body.includes('dsh web authentication required'),
  `HTTP ${subResource.status} ${subResource.body.slice(0, 40)}`,
);
dispose10();

// ××× 设了解锁密码但凭据失效 → 回解锁页重新输，而不是英文 401
const reUnlockFile = path.join(os.tmpdir(), `ra-reunlock-${Date.now()}.txt`);
const dispose11 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${authPort}`,
  urlFile: reUnlockFile,
  accessCode: '864209',
});
await new Promise((r) => setTimeout(r, 400));
const reUnlockPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(reUnlockFile, 'utf8'))?.[1] ?? 0);
// 浏览器里有一张「本插件发过的」放行 cookie（值为过期的那张）→ authorize 认它，
// 于是直接进上游；上游照着「cookie + 没票」回 401 → 插件必须回到解锁页。
const staleUnlock = await call(reUnlockPort, {
  headers: { accept: 'text/html', cookie: 'dsh-ra-ok=expired-value' },
});
check(
  '解锁 cookie 过期：回解锁页重新输密码（不是英文 401）',
  staleUnlock.status === 200 && staleUnlock.body.includes('/__remote_access__/unlock'),
  `HTTP ${staleUnlock.status}`,
);
dispose11();

// ---- 场景 11：上游「慢」不再被默认 5 秒空闲超时掐断（视频/大文件/壁纸都栽在这上面）----
//
// 这个用例故意要 5 秒多：Node ≥19 的 http.globalAgent 自带 { keepAlive: true, timeout: 5000 }，
// 只有真的等过 5 秒才能证明「我们没继承那个超时」。Node 18 上它恒过（没有那个默认值）。
const slowPath = `/${Date.now()}-slow`;

const slowUpstream = http.createServer((req, res) => {
  if (req.url === slowPath) {
    // 5.3 秒后才给响应头：默认 5s 空闲超时会在第 5 秒把请求 destroy 掉
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('slow-ok');
    }, 5300);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => slowUpstream.listen(0, '127.0.0.1', r));
const slowPort = slowUpstream.address().port;
const slowFile = path.join(os.tmpdir(), `ra-slow-${Date.now()}.txt`);
const dispose12 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${slowPort}`,
  urlFile: slowFile,
  timeoutMs: 0,
});
await new Promise((r) => setTimeout(r, 400));
const slowProxyPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(slowFile, 'utf8'))?.[1] ?? 0);
const slowStart = Date.now();
const slow = await call(slowProxyPort, { path: slowPath });
const slowMs = Date.now() - slowStart;
check(
  'timeoutMs=0 时不会继承 agent 的 5 秒空闲超时（慢上游照常拿到完整响应）',
  slow.status === 200 && slow.body === 'slow-ok',
  `HTTP ${slow.status} body=${JSON.stringify(slow.body)} 用时 ${slowMs}ms`,
);
dispose12();
slowUpstream.close();

// 显式设了超时也只是「等响应头」：头一到就交棒，正文慢慢来也不许掐
const headPath = `/${Date.now()}-head`;
const headUpstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.write('head-');
  setTimeout(() => res.end('tail'), 1200);
});
await new Promise((r) => headUpstream.listen(0, '127.0.0.1', r));
const headPort = headUpstream.address().port;
const headFile = path.join(os.tmpdir(), `ra-head-${Date.now()}.txt`);
const dispose13 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${headPort}`,
  urlFile: headFile,
  timeoutMs: 500, // 头立刻就到；正文 1.2 秒后才完 —— 超时必须只作用于「等头」
});
await new Promise((r) => setTimeout(r, 400));
const headProxyPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(headFile, 'utf8'))?.[1] ?? 0);
const headRes = await call(headProxyPort, { path: '/anything' });
check(
  'timeoutMs 只作用于「等响应头」：正文慢于超时也不会被掐断',
  headRes.status === 200 && headRes.body === 'head-tail',
  `HTTP ${headRes.status} body=${JSON.stringify(headRes.body)}`,
);
dispose13();
headUpstream.close();

// ---- 场景 12：上游半路断掉时，下游不能一直挂着 ----
/**
 * 「只求有结果」的调用：像真浏览器一样把 end / aborted / close / error 都当成结束。
 * 用来证明「代理端没有悬挂」：真正的问题是 res 既不 end 也不 destroy，
 * 那时这个函数会一直不 resolve（外层 Promise.race 判它悬挂）。
 */
const callUntilClose = (port, { path: p = '/', headers = {} } = {}) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (why, status, body) => {
      if (done) return;
      done = true;
      resolve({ why, status, body });
    };
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => finish('end', res.statusCode, d));
      res.on('aborted', () => finish('aborted', res.statusCode, d));
      res.on('close', () => finish('close', res.statusCode, d));
      res.on('error', (e) => finish('res-error:' + e.code, res.statusCode, d));
    });
    req.on('error', (e) => finish('req-error:' + e.code, 0, ''));
    req.end();
  });

const brokenUpstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
  res.write('partial');
  setTimeout(() => res.socket?.destroy(), 60);
});
await new Promise((r) => brokenUpstream.listen(0, '127.0.0.1', r));
const brokenPort = brokenUpstream.address().port;
const brokenFile = path.join(os.tmpdir(), `ra-broken-${Date.now()}.txt`);
const dispose14 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${brokenPort}`,
  urlFile: brokenFile,
});
await new Promise((r) => setTimeout(r, 400));
const brokenProxyPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(brokenFile, 'utf8'))?.[1] ?? 0);
const brokenRes = await Promise.race([
  callUntilClose(brokenProxyPort, { path: '/x' }).then((r) => ({ ...r, hung: false })),
  new Promise((r) => setTimeout(() => r({ why: 'timeout', status: 0, body: '', hung: true }), 3000)),
]);
check(
  '上游半路断掉：代理端不悬挂（下游被一起收掉，3 秒内结束）',
  brokenRes.hung !== true,
  brokenRes.hung ? '客户端还在等（悬挂）' : `结束方式=${brokenRes.why} status=${brokenRes.status} body=${JSON.stringify(brokenRes.body)}`,
);
dispose14();
brokenUpstream.close();

authUpstream.close();

for (const f of [illegalFile, alphaFile, noCredFile, reUnlockFile, slowFile, headFile, brokenFile]) {
  try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
