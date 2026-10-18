// e2e-cache-local.mjs —— 手机端缓存的「真 HTTP」手动验证（不依赖 DSH，也不改任何配置）
//
// 它做一件事：起一个**什么都不发缓存头**的假上游（正是壁纸那类大资源的样子），
// 把本插件的代理挂在前面，然后打印代理端口与带票网址。之后你可以：
//   · 用手机/电脑浏览器打开它，看大图（第一次 200、第二次应当零请求或 304）；
//   · 或者用 curl/Invoke-WebRequest 手打（脚本每 10 秒打一次上游被打次数与缓存计数）：
//       curl -s -D - -o NUL "http://127.0.0.1:<端口>/big.jpg?token=E2ETOKEN"                      # 200 + 我们铸的 ETag
//       curl -s -D - -o NUL -H "If-None-Match: <上面那个 etag>" ".../big.jpg?token=E2ETOKEN"      # 304 + 0 字节
//       curl -s "http://127.0.0.1:<端口>/__remote_access__/cache?token=E2ETOKEN"                   # 口径与计数
//
// 新鲜期在这里被压到 1 分钟（`cacheTtlMinutes: 1`），所以「过期后重验证」在几分钟内就能看到。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { apply } = await import(new URL('../index.js', import.meta.url).href);

// 假上游：300 KB 的「壁纸」，**不带任何缓存头**，支持 Range（视频/大图拖进度就是这条）
const big = Buffer.alloc(300 * 1024);
for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
let upstreamHits = 0;

const upstream = http.createServer((req, res) => {
  upstreamHits += 1;
  const p = String(req.url).split('?')[0];
  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta charset=utf-8><title>cache-e2e</title><h1>cache e2e</h1><img id=img src="/big.jpg" width=200>');
    return;
  }
  if (p === '/big.jpg') {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), big.length - 1) : big.length - 1;
      res.writeHead(206, {
        'content-type': 'image/jpeg',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${big.length}`,
        'content-length': String(end - start + 1),
      });
      res.end(big.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'accept-ranges': 'bytes' });
    res.end(big);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

const statusFile = path.join(os.tmpdir(), `ra-e2e-${Date.now()}.txt`);
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: (m) => console.log('ERR', m) },
  connection: { authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=E2ETOKEN` },
  effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
  get: () => undefined,
  on: () => () => {},
};

apply(ctx, {
  allowCidrs: ['127.0.0.0/8'],
  listen: ['127.0.0.1'],
  port: 0,
  upstream: `http://127.0.0.1:${upPort}`,
  urlFile: statusFile,
  localConfigFile: 'off', // 手动验证不该在真实 ~/.dsh 里留下配置
  logLevel: 'debug',
  cacheEnabled: true,
  cacheTtlMinutes: 1,
  cacheProbe: true,
});
await new Promise((r) => setTimeout(r, 600));

const text = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8') : '';
const url = /远程访问网址: (\S+)/.exec(text)?.[1] ?? '';
const port = url ? new URL(url).port : 0;
console.log(`E2E_URL http://127.0.0.1:${port}/?token=E2ETOKEN`);
console.log(text.split('\n').filter((l) => l.includes('手机端缓存') || l.includes('缓存计数')).join('\n'));

const tick = setInterval(() => {
  http.get(`http://127.0.0.1:${port}/__remote_access__/cache?token=E2ETOKEN`, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      let stats = {};
      try { stats = JSON.parse(d).stats ?? {}; } catch { /* 忽略 */ }
      console.log(
        `E2E_TICK upstreamHits=${upstreamHits} immutable=${stats.immutable ?? 0} ttl=${stats.ttl ?? 0} ` +
          `notModified=${stats.notModified ?? 0} probe=${stats.probe ?? 0} inline=${stats.inline ?? 0}`,
      );
    });
  }).on('error', () => {});
}, 10000);
tick.unref?.();
