// test-remote-access.mjs —— 不依赖 DSH 的功能测试（node tools/test-remote-access.mjs）
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { apply } = await import(new URL('../index.js', import.meta.url).href);

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

// 假上游：模拟 DSH 界面（把收到的 Host/Origin 回显出来）+ 一个 upgrade 端点
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`upstream host=${req.headers.host} origin=${req.headers.origin ?? '-'} xff=${req.headers['x-forwarded-for'] ?? '-'}`);
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

for (const d of [dispose1, dispose2, dispose3]) {
  try {
    d();
  } catch {
    /* 忽略 */
  }
}
upstream.close();

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
