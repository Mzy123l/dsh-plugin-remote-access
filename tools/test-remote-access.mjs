// test-remote-access.mjs —— 不依赖 DSH 的功能测试（node tools/test-remote-access.mjs）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { apply } = await import(new URL('../index.js', import.meta.url).href);

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

// 假上游：模拟 DSH 界面（把收到的 Host/Origin/token 回显出来）+ 一个 upgrade 端点
const upstream = http.createServer((req, res) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token') ?? '-';
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(
    `upstream host=${req.headers.host} origin=${req.headers.origin ?? '-'} xff=${req.headers['x-forwarded-for'] ?? '-'} token=${token}`,
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
const makeCtx = () => ({
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
  connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=TESTTOKEN` },
  effect: () => {},
});

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

// ---- 场景 5：解锁密码（网段内输一次即进；输错一次拉黑）----
const statusFile2 = path.join(os.tmpdir(), `ra-unlock-${Date.now()}.txt`);
const banFile = path.join(os.tmpdir(), `ra-ban-${Date.now()}.txt`);
const unlockCfg = {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile2,
  banFile,
  accessCode: '126710',
};
const dispose4 = apply(makeCtx(), unlockCfg);
await sleep(400);
const s4 = readUrl(statusFile2);
const port4 = s4.url ? Number(new URL(s4.url).port) : 0;
check('解锁模式：状态文件给出裸地址与密码状态', /手机访问: http:\/\/127\.0\.0\.1:\d+\//.test(s4.text) && s4.text.includes('未设置') === false);
check('解锁模式：密码不进状态文件', !s4.text.includes('126710'));

const nav = await call(port4, { headers: { accept: 'text/html' } });
check('裸地址拿到解锁页（不复制 token）', nav.status === 200 && nav.body.includes('/__remote_access__/unlock'), `HTTP ${nav.status}`);

const empty = await unlockO(port4, 'code=');
check('空密码不算一次尝试（不拉黑）', empty.status === 200 && !fs.existsSync(banFile), `HTTP ${empty.status}`);

const wrong = await unlockO(port4, 'code=000000');
check('密码错误 → 403', wrong.status === 403, `HTTP ${wrong.status}`);
check('错一次就写进拉黑名单', fs.existsSync(banFile) && fs.readFileSync(banFile, 'utf8').includes('127.0.0.1'));
const banned = await call(port4, { headers: { accept: 'text/html' } });
check('拉黑后一律 403', banned.status === 403, `HTTP ${banned.status}`);

// 删掉名单 + 重来一个实例（模拟「解封后重新打开」）
fs.rmSync(banFile, { force: true });
const dispose5 = apply(makeCtx(), unlockCfg);
await sleep(400);
const port5 = Number(new URL(readUrl(statusFile2).url).port);
const ok = await unlockO(port5, 'code=126710');
const setCookie = String(ok.headers['set-cookie'] ?? '');
check('密码正确 → 303 + 放行 cookie', ok.status === 303 && setCookie.includes('dsh-ra-ok='), `HTTP ${ok.status}`);
const cookie = setCookie.split(';')[0];
const unlocked = await call(port5, { headers: { cookie, accept: 'text/html' } });
check('解锁后直达上游', unlocked.status === 200 && unlocked.body.includes('upstream host='), `HTTP ${unlocked.status}`);
check('服务端补票：浏览器看不到 token', unlocked.body.includes('token=TESTTOKEN'), (unlocked.body.match(/token=\S*/) ?? [''])[0]);

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

for (const d of [dispose1, dispose2, dispose3, dispose4, dispose5, dispose6]) {
  try {
    d();
  } catch {
    /* 忽略 */
  }
}
upstream.close();
for (const f of [statusFile, statusFile2, banFile, hotFile]) {
  try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
