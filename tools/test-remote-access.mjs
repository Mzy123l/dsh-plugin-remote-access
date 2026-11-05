// test-remote-access.mjs —— 不依赖 DSH 的功能测试（node tools/test-remote-access.mjs）
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const indexModule = await import(new URL('../index.js', import.meta.url).href);
const {
  banCidrOf, bannedHostsOf, normalizeAccessCode, createChoiceCenter,
  contentRevOf, cacheSkipReason, describeAgentError, parseUpstream, resolveUpstream,
  localConfigPath, readLocalConfigFile, writeLocalConfigFile,
} = indexModule;

// 每个场景一棵独立的 $DSH_HOME：插件**只**读那里的 remote-access-config.json。
// 第二个参数（DSH profile 的 config）现在会被完全忽略 —— 测试也借此把这一点钉住。
const tempHomes = [];
let currentHome = '';
const apply = (ctx, config) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-home-'));
  currentHome = home;
  process.env.DSH_HOME = home;
  tempHomes.push(home);
  writeLocalConfigFile(path.join(home, 'remote-access-config.json'), config ?? {});
  return indexModule.apply(ctx);
};
/** 当前场景的本用户配置（插件写盘后的那份） */
const currentConfig = () => readLocalConfigFile(localConfigPath()).config ?? {};

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

// ---------------------------------------------------------------- DSH 0.2.1：地址与协议
//
// 0.2.1 的桌面端改用系统分配端口，Web 还能自己开 HTTPS。auto 必须优先读
// webServer.getOrigin()（协议 + 真实端口），不能再靠写死 19387。
check(
  '0.2.1：显式 upstream 保留 https 协议',
  JSON.stringify(parseUpstream('https://127.0.0.1:3080')) === JSON.stringify({ protocol: 'https:', host: '127.0.0.1', port: 3080 }),
  JSON.stringify(parseUpstream('https://127.0.0.1:3080')),
);
check(
  '0.2.1：显式 upstream 的 http 协议',
  JSON.stringify(parseUpstream('http://127.0.0.1:58945')) === JSON.stringify({ protocol: 'http:', host: '127.0.0.1', port: 58945 }),
  JSON.stringify(parseUpstream('http://127.0.0.1:58945')),
);
const originAuto = resolveUpstream(
  { get: (name) => (name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:58945' } : undefined) },
  { upstream: 'auto' },
  () => {},
);
check(
  '0.2.1：auto 从 getOrigin() 读到随机端口',
  originAuto?.protocol === 'http:' && originAuto?.port === 58945,
  JSON.stringify(originAuto),
);
const tlsAuto = resolveUpstream(
  { get: (name) => (name === 'webServer' ? { port: 3080, protocol: 'https:' } : undefined) },
  { upstream: 'auto' },
  () => {},
);
check(
  '0.2.1：auto 跟随 webServer.protocol=https',
  tlsAuto?.protocol === 'https:' && tlsAuto?.port === 3080,
  JSON.stringify(tlsAuto),
);

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
  const { webServer, ...rest } = extra;
  return {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
    connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=TESTTOKEN` },
    // 真 Cordis 的 ctx.effect 会立刻跑一遍回调并接管它返回的清理函数；桩子也要跑，
    // 否则「在 effect 里注册资源」的代码（窗口可见性路由）在测试里等于没挂上。
    effect: (fn) => {
      try { fn(); } catch { /* 忽略 */ }
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    ...rest,
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

// ---- 场景 5：解锁密码（网段内输一次即进；输错一次写进本用户配置的「排除的网段」）----
const statusFile2 = path.join(os.tmpdir(), `ra-unlock-${Date.now()}.txt`);
const unlockCfg = {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile2,
  accessCode: '864209',
};
const dispose4 = apply(makeCtx(), unlockCfg);
await sleep(400);
const s4 = readUrl(statusFile2);
const port4 = s4.url ? Number(new URL(s4.url).port) : 0;
check('解锁模式：状态文件给出裸地址与密码状态', /手机访问: http:\/\/127\.0\.0\.1:\d+\//.test(s4.text) && s4.text.includes('未设置') === false);
check('解锁模式：密码不进状态文件', !s4.text.includes('864209'));
check('本用户配置：状态文件写明唯一配置源', s4.text.includes(localConfigPath()) && s4.text.includes('唯一配置源'));

const nav = await call(port4, { headers: { accept: 'text/html' } });
check('裸地址拿到解锁页（不复制 token）', nav.status === 200 && nav.body.includes('/__remote_access__/unlock'), `HTTP ${nav.status}`);

const empty = await unlockO(port4, 'code=');
check(
  '空密码不算一次尝试（不拉黑）',
  empty.status === 200 && (currentConfig().denyCidrs ?? []).length === 0,
  `HTTP ${empty.status} deny=${JSON.stringify(currentConfig().denyCidrs)}`,
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
await sleep(300); // 等它把「排除的网段」写进本用户配置
check(
  '错一次就写进本用户配置的「排除的网段」',
  (currentConfig().denyCidrs ?? []).includes('127.0.0.1/32'),
  JSON.stringify(currentConfig().denyCidrs),
);
const banned = await call(port4, { headers: { accept: 'text/html' } });
check('拉黑后一律 403', banned.status === 403, `HTTP ${banned.status}`);

// 解封 = 把「排除的网段」里那一项删掉（新实例按新配置起来）
const dispose5 = apply(makeCtx(), unlockCfg);
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

// ---- 场景 5b：配置端点（本机 webServer）——只读写本用户 JSON ----
const cfgRoutes = [];
const cfgWebServer = { register: (route) => { cfgRoutes.push(route); return () => {}; } };
const cfgStatus = path.join(os.tmpdir(), `ra-cfg-${Date.now()}.txt`);
const disposeCfg = apply(makeCtx({ webServer: cfgWebServer }), { ...unlockCfg, urlFile: cfgStatus });
await sleep(400);
const cfgRoute = cfgRoutes.find((r) => r.path === '/__remote_access__/config');
check('配置端点：本机 webServer 上已注册', !!cfgRoute);
// 上面的最小 req 不足以驱动 readSmallBody；用一个真正的事件发射器重做
const cfgCallReal = (method, body, headers = { 'content-type': 'application/json' }) => new Promise((resolve) => {
  const listeners = new Map();
  const req = {
    method,
    url: '/__remote_access__/config',
    headers,
    on(name, fn) { listeners.set(name, fn); return this; },
  };
  const res = {
    status: 0,
    writeHead(code, h) { this.status = code; this.headers = h; },
    end(text) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(text || '{}') }); },
    destroyed: false,
    writableEnded: false,
    destroy() {},
  };
  cfgRoute.handler(req, res);
  if (body !== undefined) {
    listeners.get('data')?.(Buffer.from(body));
    listeners.get('end')?.();
  }
});
const gotCfg = await cfgCallReal('GET');
check(
  '配置端点：GET 返回本用户配置与固定路径',
  gotCfg.status === 200 && gotCfg.body.ok === true && gotCfg.body.config.accessCode === '864209' && gotCfg.body.path === localConfigPath(),
  JSON.stringify({ status: gotCfg.status, path: gotCfg.body.path }),
);
const revCfg = gotCfg.body.revision;
const postCfg = await cfgCallReal('POST', JSON.stringify({ patch: { maxConnections: 9 }, revision: revCfg }));
check(
  '配置端点：POST 写盘并热重挂（配置只在 JSON 里）',
  postCfg.status === 200 && currentConfig().maxConnections === 9,
  JSON.stringify({ status: postCfg.status, maxConnections: currentConfig().maxConnections }),
);
const staleCfg = await cfgCallReal('POST', JSON.stringify({ patch: { maxConnections: 10 }, revision: revCfg }));
check(
  '配置端点：revision 过旧回 409 并带回当前值',
  staleCfg.status === 409 && staleCfg.body.config.maxConnections === 9,
  JSON.stringify({ status: staleCfg.status, maxConnections: staleCfg.body.config?.maxConnections }),
);
const putCfg = await cfgCallReal('PUT', '{}');
check('配置端点：只接受 GET/POST', putCfg.status === 405, `HTTP ${putCfg.status}`);
const badTypeCfg = await cfgCallReal('POST', '{}', { 'content-type': 'text/plain' });
check('配置端点：POST 要求 application/json', badTypeCfg.status === 415, `HTTP ${badTypeCfg.status}`);
disposeCfg();

// ---- 场景 5c：端口被占用 → 换空闲端口并写回本用户配置 ----
const occupier = net.createServer(() => {});
await new Promise((r) => occupier.listen(0, '127.0.0.1', r));
const busyPort = occupier.address().port;
const fbStatus1 = path.join(os.tmpdir(), `ra-fb1-${Date.now()}.txt`);
const disposeFb1 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: busyPort,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: fbStatus1,
});
await sleep(900);
const fbText1 = readUrl(fbStatus1).text;
const fbPort1 = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fbText1)?.[1] ?? 0);
check('端口被占用：没有卡死，换端口后照常监听', fbPort1 > 0 && fbPort1 !== busyPort, `${busyPort} → ${fbPort1}`);
check('端口被占用：诊断里写明原因', fbText1.includes('已被占用'));
check('端口被占用：实际端口写进本用户配置', currentConfig().port === fbPort1, JSON.stringify(currentConfig().port));
const fbHome = currentHome;
disposeFb1();
await sleep(200);
// 同一个 $DSH_HOME 再起一次：共享 profile 没有参与，靠的是本用户 JSON 里记住的端口
const fbStatus2 = path.join(os.tmpdir(), `ra-fb2-${Date.now()}.txt`);
const disposeFb2 = indexModule.apply(Object.assign(makeCtx(), {}));
await sleep(600);
const fbPort2 = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(readUrl(fbStatus1).text)?.[1] ?? 0);
check('端口被占用：重启后仍用记住的端口', fbPort2 === fbPort1 && fbPort2 > 0, `${fbPort1} / ${fbPort2}`);
disposeFb2();
await new Promise((r) => occupier.close(r));

// ---- 场景 5e：改密码不影响已登录状态（放行密钥与 accessCode 解耦）----
const rotFile = path.join(os.tmpdir(), `ra-rot-${Date.now()}.txt`);
const rotCfg = {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: rotFile,
  accessCode: '864209',
};
const dispose7 = apply(makeCtx(), rotCfg);
await sleep(400);
const rotHome = currentHome;
const port7 = Number(new URL(readUrl(rotFile).url).port);
const firstUnlock = await unlockO(port7, 'code=864209');
const cookie7 = String(firstUnlock.headers['set-cookie'] ?? '').split(';')[0];
const beforeRotate = await call(port7, { headers: { cookie: cookie7, accept: 'text/html' } });
check('改密码前：放行 cookie 可用', beforeRotate.status === 200 && beforeRotate.body.includes('upstream host='), `HTTP ${beforeRotate.status}`);
dispose7();
await sleep(200);
writeLocalConfigFile(localConfigPath(), { ...currentConfig(), accessCode: '246813' });
process.env.DSH_HOME = rotHome;
const dispose7b = indexModule.apply(makeCtx());
await sleep(400);
const port7b = Number(new URL(readUrl(rotFile).url).port);
const afterRotate = await call(port7b, { headers: { cookie: cookie7, accept: 'text/html' } });
check('改密码后：同一个 cookie 仍然可用（不踢人）', afterRotate.status === 200 && afterRotate.body.includes('upstream host='), `HTTP ${afterRotate.status}`);
const staleCode = await unlockO(port7b, 'code=864209');
check('改密码后：旧密码不再放行', staleCode.status === 403, `HTTP ${staleCode.status}`);

for (const d of [dispose1, dispose2, dispose3, dispose4, dispose5, dispose7b]) {
  try { d(); } catch { /* 忽略 */ }
}
upstream.close();
for (const f of [statusFile, statusFile2, rotFile, cfgStatus, fbStatus1]) {
  try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
}

// ---- 纯函数：拉黑地址 → CIDR；本用户配置文件的读写形态 ----
check('banCidrOf：IPv4 用 /32', banCidrOf('100.64.0.5') === '100.64.0.5/32', banCidrOf('100.64.0.5'));
check('banCidrOf：IPv6 用 /128', banCidrOf('fe80::1') === 'fe80::1/128', banCidrOf('fe80::1'));
const singleHosts = bannedHostsOf(['10.0.0.0/8', '100.64.0.5/32', '::1/128', '1.2.3.4']);
check(
  'bannedHostsOf：只挑单主机项（网段不算）',
  [...singleHosts].sort().join(',') === '1.2.3.4,100.64.0.5,::1',
  [...singleHosts].join(','),
);
check('localConfigPath：固定为 $DSH_HOME/remote-access-config.json', localConfigPath().endsWith('remote-access-config.json') && localConfigPath() === path.join(process.env.DSH_HOME, 'remote-access-config.json'));
const shapeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-shape-'));
const shapeFile = path.join(shapeHome, 'remote-access-config.json');
writeLocalConfigFile(shapeFile, { port: 19388, accessCode: 'abcd12', unknownKey: 'x' });
const shapeRaw = JSON.parse(fs.readFileSync(shapeFile, 'utf8'));
check('writeLocalConfigFile：写 {version, config} 包装、只保留已知字段', shapeRaw.version === 1 && shapeRaw.config.port === 19388 && !('unknownKey' in shapeRaw.config));
check('writeLocalConfigFile：不写 sharedBaseline（没有共享 profile 这回事）', !('sharedBaseline' in shapeRaw));
check('readLocalConfigFile：读回 config', readLocalConfigFile(shapeFile).config?.accessCode === 'abcd12');
fs.writeFileSync(shapeFile, JSON.stringify({ port: 19389, logLevel: 'debug' }));
check('readLocalConfigFile：兼容手写的扁平 JSON', readLocalConfigFile(shapeFile).config?.port === 19389 && readLocalConfigFile(shapeFile).config?.logLevel === 'debug');
fs.writeFileSync(shapeFile, '{ bad json');
check('readLocalConfigFile：坏 JSON 报原因（不抛）', readLocalConfigFile(shapeFile).ok === false && String(readLocalConfigFile(shapeFile).reason).includes('JSON'));
fs.rmSync(shapeHome, { recursive: true, force: true });

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

// ---- 场景 13：下游先断开、上游后响应 → 不许抛出未捕获异常 ----
//
// 线上事故复现：手机上关标签/切后台之后，上游的响应才到，`stream.pipeline(upRes, res)`
// 会**同步抛** ERR_STREAM_UNABLE_TO_PIPE；它抛在 HTTP 请求回调里 → uncaughtException
// → DSH 宿主进程直接退出（外壳报 `host exited with 1` 并重启）。
//
// 这里有个**版本陷阱**，改这段之前务必知道：
//   下游已经 destroyed 时，pipeline 在 **Node ≥ 24 才会同步抛**，Node 22/20 根本不抛
//   （本机实测同一矩阵：Node 22.18 全部 no-throw，Electron 44 的 Node 24.21 全部 SYNC-THROW）。
//   DSH 宿主的 Node 正是 24.x，而开发机常常是 22 —— 所以「用未捕获异常来断言」在开发机上会假过。
// 因此主判据用**版本无关**的那一条：状态文件里必须留下「下游已断开，丢弃这次上游响应」。
// （另加一条 uncaughtException 断言，在 Node ≥ 24 上才真正有牙齿。）
const lateUpstream = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('late-body');
  }, 300);
});
await new Promise((r) => lateUpstream.listen(0, '127.0.0.1', r));
const lateUpPort = lateUpstream.address().port;
const lateFile = path.join(os.tmpdir(), `ra-late-${Date.now()}.txt`);
const dispose15 = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${lateUpPort}`,
  urlFile: lateFile,
  logLevel: 'debug',
});
await new Promise((r) => setTimeout(r, 400));
const lateProxyPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(lateFile, 'utf8'))?.[1] ?? 0);

const uncaught = [];
const collectUncaught = (err) => uncaught.push(err);
process.on('uncaughtException', collectUncaught);
try {
  // 发一条请求，然后在下游**立刻**断开（60ms 后发 RST；上游 300ms 才回应）
  const probe = net.connect(lateProxyPort, '127.0.0.1');
  await new Promise((resolve) => {
    probe.on('connect', () => {
      probe.write('GET /late HTTP/1.1\r\nHost: probe\r\n\r\n');
      setTimeout(() => { probe.resetAndDestroy(); resolve(); }, 60);
    });
    probe.on('error', () => resolve());
  });
  await new Promise((r) => setTimeout(r, 800)); // 等上游那次响应到达代理
} finally {
  process.off('uncaughtException', collectUncaught);
}
const lateText = fs.readFileSync(lateFile, 'utf8');
check(
  '下游断开后上游才响应：识别为「下游已断开」并丢弃，不去 pipe',
  lateText.includes('下游已断开，丢弃这次上游响应'),
  (lateText.match(/下游已断开[^\n]*/) ?? ['(没有这条记录)'])[0].slice(0, 70),
);
check(
  '下游断开后上游才响应：不抛未捕获异常（Node ≥ 24 上这条才有牙齿）',
  uncaught.length === 0,
  `${uncaught.map((e) => e?.code ?? e?.message).join(', ') || '(无)'}；本机 node ${process.versions.node}`,
);
dispose15();
lateUpstream.close();

// ---- 场景 16：待答选择中心（单元）----
// 时间可控：报告过期、rev 递增这些都得在假时钟上验，不能靠 sleep 150 秒。
let fakeNow = 1_000_000;
const center = createChoiceCenter(() => fakeNow);
check('待答中心：初始没有待答选择，也没收到过窗口报告', center.pendingCount() === 0 && center.desktopView().known === false);
const clearA = center.track({
  questions: [{ id: 'a', header: '方案', question: '要用哪个方案？', options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] }],
  wait: { callId: 'call-a', timed: false },
});
const viewA = center.view({ notifyOnChoice: true, notifyOnlyWhenWindowHidden: true });
check(
  '待答中心：记下问题正文与选项',
  viewA.pending.length === 1 &&
    viewA.pending[0].question === '要用哪个方案？' &&
    viewA.pending[0].options.join('|') === '甲|乙|丙',
  JSON.stringify(viewA.pending[0] ?? {}).slice(0, 90),
);
check('待答中心：同一次提问按 callId 去重', (() => {
  const again = center.track({ questions: [{ id: 'a', question: '要用哪个方案？' }], wait: { callId: 'call-a' } });
  const size = center.pendingCount();
  again();
  return size === 1;
})());
clearA();
check('待答中心：清除函数幂等，清完就没有待答', center.pendingCount() === 0 && (clearA(), center.pendingCount() === 0));

center.reportDesktop(false);
check('待答中心：窗口报告「不可见」', center.desktopView().known === true && center.desktopView().visible === false);
center.reportDesktop(true);
check('待答中心：窗口报告「可见」', center.desktopView().visible === true);
fakeNow += 200000; // 超过 DESKTOP_FRESH_MS（150 秒）
check('待答中心：报告过期 → 退回「不知道」（手机端照常通知）', center.desktopView().known === false);

const wakeSeen = [];
const offWake = center.subscribe(() => wakeSeen.push(center.rev()));
const revBefore = center.rev();
let resolveQuestion;
const questionDone = new Promise((r) => { resolveQuestion = r; });
const clearB = center.track({ questions: [{ id: 'b', question: '继续吗？' }], wait: { callId: 'call-b' } });
check('待答中心：状态一变就叫醒挂着的长轮询', wakeSeen.length === 1 && center.rev() > revBefore, `rev ${revBefore} → ${center.rev()}`);
center.subscribe(() => {}); // 第二个订阅者
offWake();
resolveQuestion();
clearB();
check('待答中心：订阅可以退订，退订后不再被叫醒', wakeSeen.length === 1);
check('待答中心：开关原样透给外壳', (() => {
  const off = center.view({ notifyOnChoice: false, notifyOnlyWhenWindowHidden: false });
  return off.enabled === false && off.onlyWhenWindowHidden === false;
})());
void questionDone;

// ---- 场景 17：/__remote_access__/notify（安卓外壳轮询的那个端点）----
const notifyFile = path.join(os.tmpdir(), `ra-notify-${Date.now()}.txt`);
let presenceHandler = null;
let questionListener = null;
let questionListenerPrepend = null;
/** 「一轮结束」那两个监听：agent/status（running ↔ idle）与 agent/error */
let agentStatusListener = null;
let agentErrorListener = null;
const notifyCtx = makeCtx({
  webServer: {
    register: (route) => {
      if (route?.path === '/__remote_access__/presence') presenceHandler = route.handler;
      return () => { presenceHandler = null; };
    },
  },
  on: (event, listener, options) => {
    if (event === 'user-questions/request') {
      questionListener = listener;
      questionListenerPrepend = options?.prepend === true;
    }
    // 「一轮结束」那两个事件：宿主侧只观察、不改行为，测试里把监听收起来手动喂
    if (event === 'agent/status') agentStatusListener = listener;
    if (event === 'agent/error') agentErrorListener = listener;
  },
});
const dispose16 = apply(notifyCtx, {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: notifyFile,
  logLevel: 'debug',
});
await sleep(400);
const notifyStatus = readUrl(notifyFile);
const notifyPort = notifyStatus.url ? Number(new URL(notifyStatus.url).port) : 0;
const notifyToken = notifyStatus.url ? new URL(notifyStatus.url).searchParams.get('token') : '';
check('通知端点：默认挂上了 user-questions/request 监听', typeof questionListener === 'function');
check(
  '通知端点：这条监听挂在最外层（prepend）—— 官方转发会持有请求且不调 next()，排在后面就轮不到',
  questionListenerPrepend === true,
  String(questionListenerPrepend),
);
check('通知端点：默认注册了窗口可见性路由', typeof presenceHandler === 'function');

const notifyPath = (extra = '') => `/__remote_access__/notify${extra}`;
const unauthorized = await call(notifyPort, { path: notifyPath() });
check('通知端点：没授权 → 401（这里会带上「模型在问什么」，不能白给）', unauthorized.status === 401, `HTTP ${unauthorized.status}`);
const first = await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) });
let notifyJson = null;
try { notifyJson = JSON.parse(first.body); } catch { /* 下面断言会说是空的 */ }
check(
  '通知端点：带票 → JSON 状态（没有待答、窗口未知）',
  first.status === 200 && notifyJson?.ok === true && notifyJson.pending.length === 0 && notifyJson.desktop.known === false,
  `HTTP ${first.status} ${first.body.slice(0, 80)}`,
);
check(
  '通知端点：只允许 GET',
  (await call(notifyPort, { method: 'POST', path: notifyPath(`?token=${notifyToken}`), body: 'x' })).status === 405,
);

// 外壳自报的通知环境：设置页底部那行自检与状态文件都靠它（「通知发了却不弹横幅」只有手机知道）
const revBeforeReport = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) })).body).rev;
const reported = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}&wait=0&av=1.3.5&n=1&ch=4`) })).body);
check(
  '外壳自报：端点回显 App 版本 / 通知开没开 / 通道重要性',
  reported.phone?.app === '1.3.5' && reported.phone.notifications === true && reported.phone.importance === 4,
  JSON.stringify(reported.phone ?? null),
);
check(
  '外壳自报：不推进 rev（外壳每次轮询都报一次，推进 rev 就成了自己叫醒自己的死循环）',
  reported.rev === revBeforeReport,
  `rev ${revBeforeReport} → ${reported.rev}`,
);
const stillThere = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) })).body);
check(
  '外壳自报：设置页那次探测（不带 av）不会把它清空',
  stillThere.phone?.app === '1.3.5',
  JSON.stringify(stillThere.phone ?? null),
);
const lowChannel = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}&wait=0&av=1.3.5&n=1&ch=2`) })).body);
check(
  '外壳自报：通道被调低时如实回显（页脚据此说「横幅弹不出来」）',
  lowChannel.phone?.importance === 2,
  JSON.stringify(lowChannel.phone ?? null),
);

// 模型提问 → 端点立刻能看到；回答（瀑布结束）→ 立刻消失
let resolveAsk;
const askDone = new Promise((r) => { resolveAsk = r; });
const waterfallResult = questionListener(
  {
    questions: [
      { id: 'q1', header: '选方案', question: '要用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] },
      { id: 'q2', question: '顺便确认一下？' },
    ],
    wait: { callId: 'call-1', timed: false },
    signal: new AbortController().signal,
  },
  () => askDone,
);
check('通知端点：监听不抢答（把 next() 的结果原样交回瀑布）', typeof waterfallResult?.then === 'function');
const withPending = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) })).body);
check(
  '通知端点：模型提问 → pending 里带出正文 / 选项 / 题目条数',
  withPending.pending.length === 1 &&
    withPending.pending[0].question === '要用哪个方案？' &&
    withPending.pending[0].header === '选方案' &&
    withPending.pending[0].options.join('|') === '甲|乙' &&
    withPending.pending[0].count === 2,
  JSON.stringify(withPending.pending[0] ?? {}).slice(0, 110),
);

// 长轮询：带着当前 rev 挂住 → 状态一变立刻回（不等满 wait）
const pollStart = Date.now();
const longPoll = call(notifyPort, { path: notifyPath(`?token=${notifyToken}&rev=${withPending.rev}&wait=5`) });
await sleep(150);
resolveAsk({ answers: [] });
const polled = await longPoll;
const pollMs = Date.now() - pollStart;
const polledJson = JSON.parse(polled.body);
check(
  '通知端点：长轮询挂住，状态一变立刻回（rev 也往前走）',
  polled.status === 200 && polledJson.rev > withPending.rev && pollMs < 2000,
  `用时 ${pollMs}ms，rev ${withPending.rev} → ${polledJson.rev}`,
);
const afterAnswer = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) })).body);
check('通知端点：回答之后待答清空（手机上的通知该消失）', afterAnswer.pending.length === 0);

// 窗口可见性：本机页面 POST 上来，端点里就能看到（这也是「电脑只有托盘」的判据）
const presenceServer = http.createServer((req, res) => presenceHandler(req, res));
await new Promise((r) => presenceServer.listen(0, '127.0.0.1', r));
const presencePort = presenceServer.address().port;
const postPresence = (body, headers = { 'content-type': 'application/json' }) =>
  call(presencePort, { method: 'POST', path: '/__remote_access__/presence', headers, body });
check('窗口可见性：收下页面回报（204）', (await postPresence('{"visible":false}')).status === 204);
const hidden = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) })).body);
check(
  '窗口可见性：窗口不可见 → 端点报 visible=false 且 known=true（手机该响）',
  hidden.desktop.known === true && hidden.desktop.visible === false,
  JSON.stringify(hidden.desktop),
);
check('窗口可见性：窗口可见 → 端点报 visible=true（手机不该响）', await (async () => {
  await postPresence('{"visible":true}');
  const view = JSON.parse((await call(notifyPort, { path: notifyPath(`?token=${notifyToken}`) })).body);
  return view.desktop.visible === true;
})());
check('窗口可见性：要 JSON 类型（挡住跨站表单 POST）', (await postPresence('{"visible":true}', { 'content-type': 'text/plain' })).status === 415);
check('窗口可见性：GET 不收', (await call(presencePort, { path: '/__remote_access__/presence' })).status === 405);
check('窗口可见性：body 不是 JSON → 400', (await postPresence('visible=true')).status === 400);
check('窗口可见性：字段类型不对 → 400', (await postPresence('{"visible":"yes"}')).status === 400);

// 关掉开关：外壳仍能轮询，但会看到 enabled=false（它据此完全不打扰用户）
const dispose17 = apply(notifyCtx, {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: notifyFile,
  logLevel: 'debug',
  notifyOnChoice: false,
  notifyOnlyWhenWindowHidden: false,
});
await sleep(400);
const offStatus = readUrl(notifyFile);
const offPort = offStatus.url ? Number(new URL(offStatus.url).port) : 0;
const offToken = offStatus.url ? new URL(offStatus.url).searchParams.get('token') : '';
const offJson = JSON.parse((await call(offPort, { path: `/__remote_access__/notify?token=${offToken}` })).body);
check(
  '通知开关：关掉后端点如实回答 enabled=false / onlyWhenWindowHidden=false',
  offJson.enabled === false && offJson.onlyWhenWindowHidden === false,
  JSON.stringify(offJson).slice(0, 90),
);
dispose17();
dispose16();
presenceServer.close();

// ---------------------------------------------------------------- 一轮结束的通知（正常 / 异常）
//
// 事件来自 DSH 自己，不是猜的：`agent/status` 的 running→idle 就是「这一轮跑完了」，
// `agent/error` 带着错误对象。这里用假 agent 手动喂（`id === session.id` 才算主 agent），钉住：
//   正常结束会记一条、异常结束带分类、子 agent 不打扰、idle 有防抖、结束会推 rev（长轮询立刻回）。
const finishFile = path.join(os.tmpdir(), `ra-finish-${Date.now()}.txt`);
let finishStatusListener = null;
let finishErrorListener = null;
const finishCtx = makeCtx({
  on: (event, listener) => {
    if (event === 'agent/status') finishStatusListener = listener;
    if (event === 'agent/error') finishErrorListener = listener;
  },
});
const disposeFinish = apply(finishCtx, {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: finishFile,
  logLevel: 'debug',
});
await sleep(400);
const finishUrl = readUrl(finishFile).url;
const finishPort = Number(new URL(finishUrl).port);
const finishToken = new URL(finishUrl).searchParams.get('token');
const readFinish = async () =>
  JSON.parse((await call(finishPort, { path: `/__remote_access__/notify?token=${finishToken}` })).body);

const mainAgent = { id: 'sess-1', session: { id: 'sess-1' } };
const subAgent = { id: 'sub-9', session: { id: 'sess-1' } };
check(
  '一轮结束：装上了 agent/status 与 agent/error 两个监听',
  typeof finishStatusListener === 'function' && typeof finishErrorListener === 'function',
);
// 子 agent（子任务）跑完不该打扰用户：它有自己的 id，不等于 session.id
finishStatusListener?.({ agent: subAgent, status: 'running' });
finishStatusListener?.({ agent: subAgent, status: 'idle' });
await sleep(2300);
check(
  '一轮结束：子 agent 跑完不通知（只有主 agent 才算「这一轮」）',
  (await readFinish()).finish === null,
  JSON.stringify((await readFinish()).finish),
);
// 正常一轮：running → idle；idle 不立刻落地（2 秒防抖，因为 running→maintenance 也会映射成 idle）
finishStatusListener?.({ agent: mainAgent, status: 'running' });
await sleep(50);
finishStatusListener?.({ agent: mainAgent, status: 'idle' });
check(
  '一轮结束：idle 有 2 秒防抖（不把中间态的 maintenance 当成「跑完了」）',
  (await readFinish()).finish === null,
  JSON.stringify((await readFinish()).finish),
);
await sleep(2300);
const afterDone = await readFinish();
check(
  '一轮结束：正常跑完 → 记一条 ok=true（外壳据此弹「跑完了」）',
  afterDone.finish && afterDone.finish.ok === true && afterDone.finish.id === 1 && afterDone.finish.ms >= 2000,
  JSON.stringify(afterDone.finish),
);
// 长轮询：结束也要推 rev，否则外壳要等下一轮才看到 —— 那就不是通知了
const finishPoll = call(finishPort, {
  path: `/__remote_access__/notify?token=${finishToken}&rev=${afterDone.rev}&wait=5`,
});
await sleep(150);
finishStatusListener?.({ agent: mainAgent, status: 'running' });
await sleep(50);
finishErrorListener?.({
  agent: mainAgent,
  turn: 1,
  step: 2,
  error: Object.assign(new Error('insufficient balance'), { code: 'ACCOUNT_QUOTA' }),
});
finishStatusListener?.({ agent: mainAgent, status: 'idle' });
await sleep(2300);
const finishPolled = JSON.parse((await finishPoll).body);
check(
  '一轮结束：结束会推 rev（长轮询立刻回）',
  finishPolled.finish && finishPolled.finish.id === 2,
  JSON.stringify(finishPolled.finish),
);
check(
  '一轮结束：余额/额度不足翻成一句人话（不是把英文栈甩给用户）',
  finishPolled.finish.ok === false && finishPolled.finish.reason.includes('余额') && finishPolled.finish.message.length > 0,
  JSON.stringify(finishPolled.finish),
);

const finishStatusLine = (readUrl(finishFile).text.match(/^一轮结束: .*$/m) ?? ['(没有这一行)'])[0];
check(
  '一轮结束：状态文件里写明最近一次的结论（异常 + 分类）',
  finishStatusLine.includes('异常结束') && finishStatusLine.includes('余额'),
  finishStatusLine,
);

// 「一条消息弹两次」的第一个来源：idle 会重复出现（中间态 maintenance、以及紧接着又跑一轮）。
// 规矩是「一次 running 只兑现一次结束」—— 没有 running 过的 idle 一律忽略。
const idBeforeExtraIdle = finishPolled.finish.id;
finishStatusListener?.({ agent: mainAgent, status: 'idle' });
finishStatusListener?.({ agent: mainAgent, status: 'idle' });
await sleep(2400);
const afterExtraIdle = await readFinish();
check(
  '一轮结束：没有 running 过的 idle 不报（中间态不会弹出第二条）',
  afterExtraIdle.finish.id === idBeforeExtraIdle,
  `id ${idBeforeExtraIdle} → ${afterExtraIdle.finish.id}`,
);
// 一次完整的一轮：running → idle →（多余的 idle）只兑现一条
finishStatusListener?.({ agent: mainAgent, status: 'running' });
finishStatusListener?.({ agent: mainAgent, status: 'idle' });
await sleep(2300);
const afterOneCycle = (await readFinish()).finish;
finishStatusListener?.({ agent: mainAgent, status: 'idle' });
await sleep(2300);
const afterSecondIdle = (await readFinish()).finish;
check(
  '一轮结束：一次 running 只兑现一次结束（running → idle → idle 只多一条）',
  afterOneCycle.id === idBeforeExtraIdle + 1 && afterSecondIdle.id === afterOneCycle.id,
  `id ${idBeforeExtraIdle} → ${afterOneCycle.id} → ${afterSecondIdle.id}`,
);
const finishBoot = (await readFinish()).boot;
check(
  '一轮结束：载荷带宿主实例标记 boot（外壳用它 + id 去重，跨 DSH 重启不会误判成新的一条）',
  typeof finishBoot === 'string' && finishBoot.length >= 4,
  JSON.stringify(finishBoot),
);
check(
  '错误分类：模型输出格式错 / 网络 / 限流 / 凭据 / 上下文 / 服务端 各归各类',
  describeAgentError({ code: 'MALFORMED_RESPONSE', message: 'bad json' }).reason.includes('格式') &&
    describeAgentError({ code: 'ECONNREFUSED' }).reason.includes('网络') &&
    describeAgentError({ code: 'RATE_LIMIT' }).reason.includes('限流') &&
    describeAgentError({ code: 'INVALID_CREDENTIAL' }).reason.includes('凭据') &&
    describeAgentError({ code: 'CONTEXT_WINDOW_EXCEEDED' }).reason.includes('上下文') &&
    describeAgentError({ code: 'SERVER', message: 'HTTP 503' }).reason.includes('服务端'),
  [
    describeAgentError({ code: 'MALFORMED_RESPONSE' }).reason,
    describeAgentError({ code: 'ECONNREFUSED' }).reason,
    describeAgentError({ code: 'RATE_LIMIT' }).reason,
    describeAgentError({ code: 'INVALID_CREDENTIAL' }).reason,
    describeAgentError({ code: 'CONTEXT_WINDOW_EXCEEDED' }).reason,
    describeAgentError({ code: 'SERVER' }).reason,
  ].join(' | '),
);
check(
  '错误分类：认不出来的错误老实说「出错」并带上原文（不编造分类）',
  describeAgentError(new Error('something weird happened')).reason === '出错' &&
    describeAgentError(new Error('something weird happened')).detail.includes('something weird'),
  JSON.stringify(describeAgentError(new Error('something weird happened'))),
);
// 关掉这个开关 → 端点如实回答（外壳据此不弹；原有的「提问」不受影响）
const disposeFinishOff = apply(finishCtx, {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: finishFile,
  notifyOnFinish: false,
});
await sleep(400);
const offFinishUrl = readUrl(finishFile).url;
const offFinish = JSON.parse(
  (await call(Number(new URL(offFinishUrl).port), {
    path: `/__remote_access__/notify?token=${new URL(offFinishUrl).searchParams.get('token')}`,
  })).body,
);
check(
  '一轮结束：开关关掉时端点如实回答 enabledFinish=false（enabled 仍是 true）',
  offFinish.enabledFinish === false && offFinish.enabled === true,
  JSON.stringify({ enabled: offFinish.enabled, enabledFinish: offFinish.enabledFinish }),
);
disposeFinishOff();
disposeFinish();
try { fs.rmSync(finishFile, { force: true }); } catch { /* 忽略 */ }

authUpstream.close();

// ---------------------------------------------------------------- 手机端缓存（1.3.8）
//
// 这一节的判据都是「通用 HTTP 事实」：方法与状态码、上游给没给缓存头 / 校验器、响应类型白名单。
// 这里刻意**不提任何插件名**：壁纸只是「上游什么都不发的静态大文件」的一个例子。
//
// 假上游按上游真实行为分三类：
//   · 内容寻址（rev= / 哈希文件名）—— 上游发 immutable，或干脆什么都不发；
//   · 上游自己给了校验器（ETag/Last-Modified）—— 我们只补新鲜期，不改它的校验器；
//   · 什么都不给的大静态文件 —— 我们补新鲜期 + 自铸弱校验器，并用首/尾片段核对。
const cacheFile = path.join(os.tmpdir(), `ra-cache-${Date.now()}.txt`);
/** 壁纸那类大文件的内容；`version` 一变就换内容，用来验「换了图但字节数一模一样」 */
let bigVersion = 'A';
const bigBody = (fill) => Buffer.alloc(300 * 1024, fill);
let cacheUpstreamHits = 0;

const serveRange = (req, res, body, contentType, extraHeaders = {}) => {
  const range = req.headers.range;
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', ...extraHeaders };
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': String(body.length) });
    res.end(body);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  if (m && !m[1] && m[2]) {
    start = Math.max(0, body.length - Number(m[2]));
    end = body.length - 1;
  }
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${body.length}`,
    'content-length': String(end - start + 1),
  });
  res.end(body.subarray(start, end + 1));
};

const cacheUpstream = http.createServer((req, res) => {
  cacheUpstreamHits += 1;
  const path0 = String(req.url).split('?')[0];
  if (path0 === '/assets/index-5SrrfWpU.js') {
    // Vite 哈希产物：上游一个缓存头都不发（实测如此）
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end('console.log(1)');
    return;
  }
  if (path0.startsWith('/plugins/')) {
    // DSH 自己给聚合包发的就是 immutable —— 我们不许改它、也不许再加一个头
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' });
    res.end('plugin-bundle');
    return;
  }
  if (path0 === '/wallpaper/big.jpg') {
    serveRange(req, res, bigBody(bigVersion), 'image/jpeg');
    return;
  }
  if (path0 === '/wallpaper/small.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.alloc(3 * 1024, 7));
    return;
  }
  if (path0 === '/wallpaper/validated.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg', etag: '"upstream-1"', 'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT' });
    res.end(Buffer.alloc(1024, 3));
    return;
  }
  if (path0 === '/wallpaper/never.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(Buffer.alloc(1024, 4));
    return;
  }
  if (path0 === '/wallpaper/never-big.jpg') {
    // 壁纸那类「实时抓帧」的真实样子：几 MB、上游明确 no-store —— 每次进页面都要重传
    const body = Buffer.alloc(200 * 1024, 9);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(body.length) });
    res.end(body);
    return;
  }
  if (path0 === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"state":"live"}');
    return;
  }
  if (path0 === '/api/tiny.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(1024, 5));
    return;
  }
  if (path0 === '/data/big.bin') {
    // 真实的大二进制（.pkg / .tex 这类）都会带 Content-Length —— 我们靠它判断值不值得缓存
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(100 * 1024) });
    res.end(Buffer.alloc(100 * 1024, 6));
    return;
  }
  if (path0 === '/wallpaper/frame-chunked.png') {
    // 与真实抓帧逐字一致：createReadStream 直接 pipe（**分块传输、没有 content-length**）+ no-store
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(Buffer.alloc(300 * 1024, 11));
    return;
  }
  if (path0 === '/wallpaper/tiny-live.gif') {
    // 每秒钟来一次的实时小端点（没有长度、no-store）：不能被 override 顺手缓存
    res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
    res.end(Buffer.alloc(120, 12));
    return;
  }
  if (path0 === '/audio/track.mp3') {
    // 媒体元素的分段取：客户端发 Range: bytes=0-，上游回覆盖整份的 206（浏览器永远不缓存它）
    const body = Buffer.alloc(120 * 1024, 13);
    if (req.headers.range) {
      res.writeHead(206, {
        'content-type': 'audio/mpeg',
        'accept-ranges': 'bytes',
        'content-range': `bytes 0-${body.length - 1}/${body.length}`,
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});
await new Promise((r) => cacheUpstream.listen(0, '127.0.0.1', r));
const cacheUpPort = cacheUpstream.address().port;

const disposeCache = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${cacheUpPort}`,
  urlFile: cacheFile,
  logLevel: 'debug',
});
await sleep(400);
const cacheStatus = readUrl(cacheFile);
const cachePort = cacheStatus.url ? Number(new URL(cacheStatus.url).port) : 0;
const cacheToken = cacheStatus.url ? new URL(cacheStatus.url).searchParams.get('token') : '';

/** 只关心「头 + 正文长度」的请求 */
const callRaw = (p, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: cachePort, method: 'GET', path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.from('ERR ' + e.message) }));
    req.end();
  });

// 内容寻址：URL 里的哈希就是内容身份 → 一年不用再问（这是原来只认 /plugins//assets/ 前缀的通用化）
const viteAsset = await callRaw('/assets/index-5SrrfWpU.js?token=' + cacheToken);
check(
  '缓存：哈希文件名的静态产物 → immutable（上游本来什么都不发）',
  String(viteAsset.headers['cache-control'] ?? '').includes('immutable'),
  String(viteAsset.headers['cache-control'] ?? '(无)'),
);
check(
  '缓存：普通文件名不算内容哈希（client.js 这种不许被钉一年）',
  contentRevOf('/plugins/dsh-plugin-remote-access/client.js') === '' &&
    contentRevOf('/assets/vendor-BNsW4eBh.css') === 'name:BNsW4eBh' &&
    contentRevOf('/plugins/??a/client.js,b/client.js&rev=3c6a5cf08bfc') === 'rev:3c6a5cf08bfc',
);

// 上游已有自己的口径 → 一个字都不改（这是「尊重上游」那条纪律）
const pluginBundle = await callRaw('/plugins/whatever/client.js?rev=deadbeef01&token=' + cacheToken);
check(
  '缓存：上游已发 immutable 的聚合包 → 原样透传，不加第二个头',
  pluginBundle.headers['cache-control'] === 'public, max-age=31536000, immutable',
  String(pluginBundle.headers['cache-control'] ?? '(无)'),
);

// 无校验器的大静态文件：补新鲜期 + 自铸弱校验器（壁纸就是这一类）
const big1 = await callRaw('/wallpaper/big.jpg?token=' + cacheToken);
const bigEtag = String(big1.headers.etag ?? '');
check(
  '缓存：上游什么都不给的大图 → 补新鲜期（private + max-age + SWR）',
  String(big1.headers['cache-control'] ?? '').includes('max-age=600') &&
    String(big1.headers['cache-control'] ?? '').includes('stale-while-revalidate') &&
    String(big1.headers['cache-control'] ?? '').startsWith('private'),
  String(big1.headers['cache-control'] ?? '(无)'),
);
check(
  '缓存：同时铸一个弱校验器（我们自己发的，带 dshra- 前缀）',
  /^W\/"dshra-\d+-\w+-\w+(-\w+)?"$/.test(bigEtag),
  bigEtag,
);
check('缓存：正文照常发给手机（没被缓存层吃掉）', big1.body.length === 300 * 1024, `${big1.body.length} 字节`);

// 手机拿着这个校验器回来 → 只读几 KB 片段就能回 304（零字节）
const hitsBefore = cacheUpstreamHits;
const bigAgain = await callRaw(`/wallpaper/big.jpg?token=${cacheToken}`, { 'if-none-match': bigEtag });
check(
  '缓存：条件请求命中 → 304 且零字节（这就是「不再重传」的关键一步）',
  bigAgain.status === 304 && bigAgain.body.length === 0,
  `HTTP ${bigAgain.status} / ${bigAgain.body.length} 字节`,
);
check(
  '缓存：判定只用「头部 + 首/尾片段」的探针（读的是 206 片段，不是整份）',
  cacheUpstreamHits - hitsBefore <= 3,
  `上游被打了 ${cacheUpstreamHits - hitsBefore} 次`,
);

// 换了壁纸、但字节数一模一样 → 首/尾片段指纹必须发现它变了（弱长度校验会漏掉这一种）
bigVersion = 'B';
const bigChanged = await callRaw(`/wallpaper/big.jpg?token=${cacheToken}`, { 'if-none-match': bigEtag });
check(
  '缓存：换了图但长度一模一样 → 不会误判成 304（首/尾片段指纹）',
  bigChanged.status === 200 && String(bigChanged.headers.etag ?? '') !== bigEtag,
  `HTTP ${bigChanged.status} / ${bigChanged.headers.etag}`,
);

// 小资源：缓冲整份算精确校验器（不发探针）
const small1 = await callRaw('/wallpaper/small.png?token=' + cacheToken);
const smallEtag = String(small1.headers.etag ?? '');
const small2 = await callRaw(`/wallpaper/small.png?token=${cacheToken}`, { 'if-none-match': smallEtag });
check(
  '缓存：小图片缓冲整份算精确校验器，条件请求同样回 304',
  small1.body.length === 3 * 1024 && small2.status === 304 && small2.body.length === 0,
  `HTTP ${small2.status} / ${small2.body.length} 字节`,
);

// 上游自己有校验器 → 只补新鲜期，校验器仍然是上游那一份（条件请求继续由上游回答）
const validated = await callRaw('/wallpaper/validated.jpg?token=' + cacheToken);
check(
  '缓存：上游已有 ETag/Last-Modified → 只补新鲜期，校验器原样保留',
  validated.headers.etag === '"upstream-1"' &&
    String(validated.headers['cache-control'] ?? '').includes('max-age=600'),
  `${validated.headers.etag} / ${validated.headers['cache-control']}`,
);

// 上游说 no-store → 尊重它（壁纸插件对「随时可能变」的那些端点是这么写的）
const never = await callRaw('/wallpaper/never.jpg?token=' + cacheToken);
check(
  '缓存：上游 no-store 的资源一个字都不改',
  never.headers['cache-control'] === 'no-store' && never.headers.etag === undefined,
  String(never.headers['cache-control'] ?? '(无)'),
);

// 默认关的那个开关：连 no-store 的大媒体也缓存（壁纸抓帧就是这个场景，一次几 MB）
const neverBig = await callRaw('/wallpaper/never-big.jpg?token=' + cacheToken);
const neverBigJson = JSON.parse((await call(cachePort, { path: `/__remote_access__/cache?token=${cacheToken}` })).body);
check(
  '缓存：默认不碰 no-store（哪怕它是 200 KB 的大图）',
  neverBig.headers['cache-control'] === 'no-store' && neverBig.headers.etag === undefined,
  `${neverBig.headers['cache-control']} / etag=${neverBig.headers.etag ?? '(无)'}`,
);
check(
  '流量账：大且没带缓存口径的那一行会写明原因（排查时唯一能直接读懂的一列）',
  (neverBigJson.traffic.top.find((row) => row.key === 'GET /wallpaper/never-big.jpg')?.reason ?? '').includes('no-store'),
  JSON.stringify(neverBigJson.traffic.top.find((row) => row.key === 'GET /wallpaper/never-big.jpg') ?? null),
);
check(
  '缓存原因：Range / no-store / JSON 各说各的原因（不是一句含糊的「没缓存」）',
  cacheSkipReason({ url: '/a.jpg', status: 200, method: 'GET', headers: { 'content-type': 'image/jpeg' }, cfg: {}, range: 'bytes=0-' }).includes('Range') &&
    cacheSkipReason({ url: '/a.jpg', status: 200, method: 'GET', headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }, cfg: {} }).includes('no-store') &&
    cacheSkipReason({ url: '/api/x', status: 200, method: 'GET', headers: { 'content-type': 'application/json' }, cfg: {} }).includes('JSON') &&
    cacheSkipReason({ url: '/x', status: 200, method: 'POST', headers: {}, cfg: {} }).includes('POST'),
);

// 打开开关后：同一个 no-store 大图会被补上新鲜期 + 弱校验器，条件请求也能 304
const disposeCacheForce = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${cacheUpPort}`,
  urlFile: cacheFile,
  cacheOverrideNoStore: true,
});
await sleep(400);
const forcePort = Number(new URL(readUrl(cacheFile).url).port);
const forceToken = new URL(readUrl(cacheFile).url).searchParams.get('token');
const forceRaw = (p, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: forcePort, method: 'GET', path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.from('ERR ' + e.message) }));
    req.end();
  });
const forced = await forceRaw('/wallpaper/never-big.jpg?token=' + forceToken);
const forcedEtag = String(forced.headers.etag ?? '');
check(
  '缓存：开了「no-store 的大媒体也缓存」后，大图带上新鲜期与弱校验器',
  String(forced.headers['cache-control'] ?? '').includes('max-age=600') &&
    /^W\/"dshra-/.test(forcedEtag) &&
    forced.body.length === 200 * 1024,
  `${forced.headers['cache-control']} / ${forcedEtag}`,
);
const forcedAgain = await forceRaw(`/wallpaper/never-big.jpg?token=${forceToken}`, { 'if-none-match': forcedEtag });
check(
  '缓存：这类资源同样能靠片段指纹回 304（不用把整份再传一遍）',
  forcedAgain.status === 304 && forcedAgain.body.length === 0,
  `HTTP ${forcedAgain.status} / ${forcedAgain.body.length} 字节`,
);

// 真实抓帧的形态：**分块传输、没有 content-length**（上一版就是卡在这里一次都没生效）
const forcedChunked = await forceRaw('/wallpaper/frame-chunked.png?token=' + forceToken);
const forcedChunkedEtag = String(forcedChunked.headers.etag ?? '');
check(
  '缓存：没有 content-length 的分块抓帧也能缓存（按探针首段判大小，不靠长度头）',
  String(forcedChunked.headers['cache-control'] ?? '').includes('max-age=600') &&
    /^W\/"dshra-/.test(forcedChunkedEtag) &&
    forcedChunked.body.length === 300 * 1024,
  `${forcedChunked.headers['cache-control']} / ${forcedChunkedEtag} / ${forcedChunked.body.length} 字节`,
);
const forcedChunkedAgain = await forceRaw(`/wallpaper/frame-chunked.png?token=${forceToken}`, { 'if-none-match': forcedChunkedEtag });
check(
  '缓存：分块抓帧的条件请求同样回 304',
  forcedChunkedAgain.status === 304 && forcedChunkedAgain.body.length === 0,
  `HTTP ${forcedChunkedAgain.status} / ${forcedChunkedAgain.body.length} 字节`,
);
// 每秒来一次的实时小端点：不能被 override 顺手缓存（那是在缓存一个「当前值」）
const tinyLive = await forceRaw('/wallpaper/tiny-live.gif?token=' + forceToken);
check(
  '缓存：override 不碰实时小响应（120 字节、没有长度）',
  tinyLive.headers['cache-control'] === 'no-store' && tinyLive.headers.etag === undefined,
  `${tinyLive.headers['cache-control']} / etag=${tinyLive.headers.etag ?? '(无)'}`,
);
const forceJson = JSON.parse((await call(forcePort, { path: `/__remote_access__/cache?token=${forceToken}` })).body);
check(
  '缓存：自检端点在开关打开时如实报 overrideNoStore / overrideRange / honorsNoStore',
  forceJson.policy.overrideNoStore === true &&
    forceJson.policy.overrideRange === false &&
    forceJson.policy.honorsNoStore === false &&
    forceJson.stats.override >= 1,
  JSON.stringify(forceJson.policy),
);
disposeCacheForce();

// ---------------------------------------------------------------- 整段 Range 当整份（cacheFullRange）
//
// 媒体元素取大文件时发 `Range: bytes=0-`，上游回覆盖整份的 206 —— 而浏览器**永远不缓存 206**，
// 于是每次进页面都重下整段（实测壁纸音轨 3.8 MB × 2）。这个开关把这一种改写成整份 200。
const halfRange = await callRaw(`/audio/track.mp3?token=${cacheToken}`, { range: 'bytes=0-' });
check(
  '缓存：默认不动带 Range 的请求（206 原样透传，一个字都不改）',
  halfRange.status === 206 && halfRange.headers['cache-control'] === undefined && halfRange.headers.etag === undefined,
  `HTTP ${halfRange.status} / cc=${halfRange.headers['cache-control'] ?? '(无)'}`,
);

const disposeFullRange = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${cacheUpPort}`,
  urlFile: cacheFile,
  cacheFullRange: true,
});
await sleep(400);
const fullPort = Number(new URL(readUrl(cacheFile).url).port);
const fullToken = new URL(readUrl(cacheFile).url).searchParams.get('token');
const fullRaw = (p, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: fullPort, method: 'GET', path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.from('ERR ' + e.message) }));
    req.end();
  });
const wholeAudio = await fullRaw('/audio/track.mp3?token=' + fullToken, { range: 'bytes=0-' });
check(
  '缓存：开了「整段 Range 当整份」后，206 改写成可缓存的 200（字节一模一样）',
  wholeAudio.status === 200 &&
    wholeAudio.headers['content-range'] === undefined &&
    String(wholeAudio.headers['cache-control'] ?? '').includes('max-age=600') &&
    wholeAudio.headers.etag !== undefined &&
    wholeAudio.body.length === 120 * 1024,
  `HTTP ${wholeAudio.status} / cc=${wholeAudio.headers['cache-control']} / ${wholeAudio.body.length} 字节`,
);
const wholeAudioAgain = await fullRaw('/audio/track.mp3?token=' + fullToken, {
  range: 'bytes=0-',
  'if-none-match': String(wholeAudio.headers.etag),
});
check(
  '缓存：改写后的整份同样能 304（第二次进页面零字节）',
  wholeAudioAgain.status === 304 && wholeAudioAgain.body.length === 0,
  `HTTP ${wholeAudioAgain.status} / ${wholeAudioAgain.body.length} 字节`,
);
// 只取中间一段（比如拖动进度）绝不能被当成整份
const partial = await fullRaw('/audio/track.mp3?token=' + fullToken, { range: 'bytes=100-200' });
check(
  '缓存：不是「从 0 到结尾」的分段一律原样透传（拖动定位不受影响）',
  partial.status === 206,
  `HTTP ${partial.status}`,
);
disposeFullRange();

// 接口与未知二进制不碰：JSON 只有内容寻址才敢动；小的 octet-stream 多半是接口
const apiState = await callRaw('/api/state?token=' + cacheToken);
const tinyBin = await callRaw('/api/tiny.bin?token=' + cacheToken);
check(
  '缓存：JSON 接口与小块二进制不加任何缓存头（不做通用 HTTP 缓存）',
  apiState.headers['cache-control'] === undefined &&
    apiState.headers.etag === undefined &&
    tinyBin.headers['cache-control'] === undefined &&
    tinyBin.headers.etag === undefined,
);
// 大块二进制（.pkg / .tex 这类未知类型）才值得缓存
const bigBin = await callRaw('/data/big.bin?token=' + cacheToken);
check(
  '缓存：大块未知二进制（≥64 KB）照常补新鲜期 + 校验器',
  String(bigBin.headers['cache-control'] ?? '').includes('max-age=600') && bigBin.headers.etag !== undefined,
  `${bigBin.headers['cache-control']} / ${bigBin.headers.etag}`,
);

// Range 请求一律不碰：那是 <video> 在拖进度，206 不该被当成一份完整副本
const ranged = await callRaw(`/wallpaper/big.jpg?token=${cacheToken}`, { range: 'bytes=0-1023' });
check(
  '缓存：带 Range 的请求原样透传（不给 206 加任何缓存口径）',
  ranged.status === 206 &&
    ranged.headers['cache-control'] === undefined &&
    ranged.headers.etag === undefined &&
    ranged.body.length === 1024,
  `HTTP ${ranged.status} / cc=${ranged.headers['cache-control'] ?? '(无)'}`,
);

// 关掉开关 → 一律不插手（用户随时可以退回去）
const disposeCacheOff = apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${cacheUpPort}`,
  urlFile: cacheFile,
  cacheEnabled: false,
});
await sleep(400);
const offCachePort = Number(new URL(readUrl(cacheFile).url).port);
const offCacheToken = new URL(readUrl(cacheFile).url).searchParams.get('token');
const offAsset = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: offCachePort, method: 'GET', path: `/assets/index-5SrrfWpU.js?token=${offCacheToken}` }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
  });
  req.end();
});
check(
  '缓存：cacheEnabled=false 时一个头都不加（开关真的能退回去）',
  offAsset.headers['cache-control'] === undefined,
  String(offAsset.headers['cache-control'] ?? '(无)'),
);
disposeCacheOff();

// 自检端点：设置页「缓存」子菜单展开时读它
const cacheNoAuth = await call(cachePort, { path: '/__remote_access__/cache' });
const cacheJson = JSON.parse((await call(cachePort, { path: `/__remote_access__/cache?token=${cacheToken}` })).body);
check('缓存自检端点：没授权 401（不白给）', cacheNoAuth.status === 401, `HTTP ${cacheNoAuth.status}`);
check(
  '缓存自检端点：报出口径与计数（手机端设置页那行字就是它）',
  cacheJson.ok === true &&
    cacheJson.policy.ttlMinutes === 10 &&
    cacheJson.policy.storesOnHost === false &&
    cacheJson.policy.honorsNoStore === true &&
    cacheJson.stats.notModified >= 2 &&
    Array.isArray(cacheJson.recent),
  JSON.stringify(cacheJson.policy),
);
check(
  '缓存自检端点：只允许 GET',
  (await call(cachePort, { method: 'POST', path: `/__remote_access__/cache?token=${cacheToken}` })).status === 405,
);

// 流量账：排查「退出重进还是大流量」靠它 —— 组合包那类响应是 DSH 自己发的 immutable，
// 「我们加了什么头」的计数看不见它们，所以这里按 URL 记字节（谁在重传、重传了多少）。
check(
  '流量账：按 URL 记字节（大图那笔就是 300 KB 量级）',
  cacheJson.traffic.totalOut > 300 * 1024 &&
    cacheJson.traffic.top.some((row) => row.key === 'GET /wallpaper/big.jpg' && row.out >= 300 * 1024),
  JSON.stringify(cacheJson.traffic.top.slice(0, 3)),
);
check(
  '流量账：单独记 WebSocket 与「没有缓存口径」的字节（后者就是下次还会重传的量）',
  cacheJson.traffic.wsOut === 0 && typeof cacheJson.traffic.uncachedOut === 'number',
  `wsOut=${cacheJson.traffic.wsOut} uncachedOut=${cacheJson.traffic.uncachedOut}`,
);
const resetJson = JSON.parse(
  (await call(cachePort, { path: `/__remote_access__/cache?reset=1&token=${cacheToken}` })).body,
);
check(
  '流量账：?reset=1 清零（复现问题时先清一次，再看这一轮花了多少）',
  resetJson.traffic.totalOut === 0 && resetJson.traffic.top.length === 0 && resetJson.stats.notModified > 0,
  JSON.stringify(resetJson.traffic).slice(0, 140),
);
disposeCache();
cacheUpstream.close();
try { fs.rmSync(cacheFile, { force: true }); } catch { /* 忽略 */ }

// ---------------------------------------------------------------- 场景：DSH 0.2.1 的 HTTPS 上游
//
// 0.2.1 的 Web 可以自己开 HTTPS。这里用 openssl 现场签一张自签证书，起一个 HTTPS 假上游，
// 再让插件以 https:// 为上游跑一遍 HTTP 转发 + WebSocket 透传。没有 openssl 就明确 SKIP。
let httpsUpstream = null;
let httpsDispose = null;
let httpsDir = null;
try {
  httpsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-https-'));
  const keyFile = path.join(httpsDir, 'key.pem');
  const certFile = path.join(httpsDir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'],
    { stdio: 'ignore' },
  );
  httpsUpstream = https.createServer(
    { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`secure host=${req.headers.host} origin=${req.headers.origin ?? '-'}`);
    },
  );
  httpsUpstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write('hello-tls');
    socket.end();
  });
  await new Promise((r) => httpsUpstream.listen(0, '127.0.0.1', r));
  const httpsPort = httpsUpstream.address().port;
  const httpsStatus = path.join(os.tmpdir(), `ra-https-status-${Date.now()}.txt`);
  httpsDispose = apply(makeCtx(), {
    allowCidrs: ['127.0.0.0/8'],
    listen: ['127.0.0.1'],
    port: 0,
    upstream: `https://127.0.0.1:${httpsPort}`,
    urlFile: httpsStatus,
  });
  await new Promise((r) => setTimeout(r, 400));
  const httpsUrl = readUrl(httpsStatus);
  const httpsProxyPort = httpsUrl.url ? Number(new URL(httpsUrl.url).port) : 0;

  const secureBody = await new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port: httpsProxyPort, path: '/', headers: { origin: 'http://127.0.0.1:9999' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      })
      .on('error', (e) => resolve('ERR ' + e.message));
  });
  check(
    '0.2.1：HTTPS 上游能正常转发（Host/Origin 按 https 改写）',
    secureBody.includes('secure host=127.0.0.1:') && secureBody.includes(`origin=https://127.0.0.1:${httpsPort}`),
    secureBody.slice(0, 120),
  );

  const secureWs = await new Promise((resolve) => {
    const sock = net.connect(httpsProxyPort, '127.0.0.1', () => {
      sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${httpsProxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    });
    let d = '';
    sock.on('data', (c) => {
      d += c.toString();
      if (d.includes('hello-tls')) {
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
  check('0.2.1：HTTPS 上游的 WebSocket 也能透传', secureWs.includes('101') && secureWs.includes('hello-tls'), secureWs.split('\r\n')[0]);
  httpsDispose();
  httpsDispose = null;
  await new Promise((r) => httpsUpstream.close(r));
  httpsUpstream = null;
  fs.rmSync(httpsStatus, { force: true });
} catch (err) {
  check('0.2.1：HTTPS 上游测试（openssl 不可用则 SKIP）', true, `SKIP: ${String(err?.message ?? err).slice(0, 100)}`);
  try { httpsDispose?.(); } catch { /* 忽略 */ }
  try { httpsUpstream?.close(); } catch { /* 忽略 */ }
} finally {
  try {
    if (httpsDir) fs.rmSync(httpsDir, { recursive: true, force: true });
  } catch { /* 忽略 */ }
}

// ---- 场景 12：配置只认本用户 JSON（DSH profile 的 config 被完全忽略）----
const tailUp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('tail-upstream'); });
await new Promise((r) => tailUp.listen(0, '127.0.0.1', r));
const tailUpPort = tailUp.address().port;
const onlyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-only-home-'));
process.env.DSH_HOME = onlyHome;
const onlyFile = path.join(onlyHome, 'remote-access-config.json');
const onlyStatus = path.join(onlyHome, 'status.txt');
writeLocalConfigFile(onlyFile, {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${tailUpPort}`,
  urlFile: onlyStatus,
  logLevel: 'silent',
});
const disposeOnly = indexModule.apply(makeCtx(), {
  port: 9999,
  allowCidrs: ['10.0.0.0/8'],
  accessCode: 'SHOULD-NOT-EXIST',
  logLevel: 'debug',
});
await sleep(400);
const onlyText = fs.readFileSync(onlyStatus, 'utf8');
check(
  '配置来源：DSH 传入的 config 被完全忽略（端口 / 网段 / 密码都不采用）',
  !onlyText.includes('9999') && !onlyText.includes('10.0.0.0/8') && !onlyText.includes('SHOULD-NOT-EXIST'),
  (onlyText.match(/"accessCode": "[^"]*"/) ?? [''])[0],
);
check(
  '配置来源：生效配置就是 JSON 里那份',
  /"port": 0/.test(onlyText) && /"allowCidrs": \[\s*"127\.0\.0\.0\/8"/.test(onlyText),
  (onlyText.match(/"port": \d+/) ?? [''])[0],
);
const onlyPort = Number(/远程访问网址: http:\/\/127\.0\.0\.1:(\d+)/.exec(onlyText)?.[1] ?? 0);
check('配置来源：按 JSON 里的 allowCidrs 监听成功', onlyPort > 0, String(onlyPort));

// 远程（手机）页面的配置端点：走代理，先过访问门
const noAuthCfg = await call(onlyPort, { path: '/__remote_access__/config', headers: { accept: 'application/json' } });
check('配置端点（远程）：没票 401（能读到访问密码，不能白给）', noAuthCfg.status === 401, `HTTP ${noAuthCfg.status}`);
const remoteGet = await call(onlyPort, { path: '/__remote_access__/config?token=TESTTOKEN', headers: { accept: 'application/json' } });
let remoteGetJson = null;
try { remoteGetJson = JSON.parse(remoteGet.body); } catch { /* 非 JSON */ }
check(
  '配置端点（远程）：带票 GET 读到本用户配置',
  remoteGet.status === 200 && remoteGetJson?.ok === true && remoteGetJson?.path === onlyFile,
  `HTTP ${remoteGet.status}`,
);
const remoteRev = remoteGetJson?.revision;
const remotePost = await call(onlyPort, {
  method: 'POST',
  path: '/__remote_access__/config?token=TESTTOKEN',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ patch: { remoteTheme: 'light' }, revision: remoteRev }),
});
let remotePostJson = null;
try { remotePostJson = JSON.parse(remotePost.body); } catch { /* 非 JSON */ }
check(
  '配置端点（远程）：POST 写进同一个 JSON',
  remotePost.status === 200 && readLocalConfigFile(onlyFile).config?.remoteTheme === 'light',
  `HTTP ${remotePost.status}`,
);
disposeOnly();
await new Promise((r) => tailUp.close(r));

// ---- 场景 13：首次启动按默认值建文件；坏文件先备份再重建 ----
const seedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-seed-home-'));
process.env.DSH_HOME = seedHome;
const seedStatus = path.join(seedHome, 'status.txt');
const seedUp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('seed-up'); });
await new Promise((r) => seedUp.listen(0, '127.0.0.1', r));
const seedUpPort = seedUp.address().port;
const disposeSeed = indexModule.apply(makeCtx(), {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${seedUpPort}`,
  urlFile: seedStatus,
  localConfigFile: 'off', // 这个键现在不存在，会被忽略
});
await sleep(300);
const seeded = readLocalConfigFile(path.join(seedHome, 'remote-access-config.json'));
check('首次启动：文件不存在 → 按代码默认值建一份', seeded.ok && seeded.config?.allowCidrs?.[0] === '100.64.0.0/10' && seeded.config?.port === 0, JSON.stringify(seeded.config?.allowCidrs));
disposeSeed();
await sleep(150);
// 默认值里没有 upstream/urlFile，监听会失败；上面那条只关心文件。
const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-bad-home-'));
process.env.DSH_HOME = badHome;
fs.writeFileSync(path.join(badHome, 'remote-access-config.json'), '{ 这不是 JSON');
const disposeBad2 = indexModule.apply(makeCtx());
await sleep(200);
const badRebuilt = readLocalConfigFile(path.join(badHome, 'remote-access-config.json'));
const badBackups = fs.readdirSync(badHome).filter((n) => n.startsWith('remote-access-config.json.bad-'));
check('坏文件：先备份、再按默认值重建', badRebuilt.ok && badBackups.length === 1, `${badBackups.length} 个备份`);
disposeBad2();
await new Promise((r) => seedUp.close(r));
for (const dir of [onlyHome, seedHome, badHome]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
for (const f of [illegalFile, alphaFile, noCredFile, reUnlockFile, slowFile, headFile, brokenFile, lateFile, notifyFile]) {
  try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);