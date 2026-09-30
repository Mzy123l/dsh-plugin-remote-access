/**
 * dsh-remote-access —— 把本机 DSH 的网页界面开放给指定网段（例如 Tailscale），
 * 供手机 / 另一台电脑通过一条「带票的网址」访问。
 *
 * 设计要点：
 *  1. 只监听「允许网段」里属于本机的地址（listen=auto），别的一律不绑，绝不含 0.0.0.0；
 *  2. 每个连进来的对端也必须落在允许网段内、且不在黑名单 / 拉黑名单里，否则 403；
 *  3. 默认仍走 DSH 自己的令牌/cookie（没票就是 401）；可选用 accessCode 开一个「网段内输一次 6 位密码」
 *     的解锁页，解锁后由本插件在服务端补票，浏览器始终看不到 token —— 一次输错就把该地址拉黑；
 *  4. 默认把 Host/Origin 改写成上游回环 authority，因此不必去改 client-connection 的配置；
 *  5. 无论成功失败都会写一份「自诊断文件」，把生效配置、上游探测、监听结果写清楚；
 *  6. 设置页保存后靠 `app-boot/config-reload` 原地重挂监听（热重载），不必重启 DSH。
 *
 * 参数全部走 Config（在「设置 → 远程访问」里改，其余只在 cordis.patch.yml 里配），零第三方依赖。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// DSH 的 Config 协议就是 Schemastery（用 Symbol.for('schemastery') 认领原生 schema）。
// 该包由 DSH 安装目录随运行时提供，但**借它要声明**：DSH 把 profile 里以 link: 安装的插件
// 当作 "linked" 层，其 routeLinked() 只对「某个祖先目录的 package.json 在 peerDependencies
// 里列过」的裸名放行（否则退回原生解析，必然找不到）。所以 package.json 里那一条 peer 是必需的。
// 在纯 node 环境（tools/ 下的独立测试）解析不到，就降级成「无 schema」，插件照常工作，
// 只是「设置 → 远程访问」写不进去——所以解析结果会写进状态文件，失败必须看得见。
let schemaSource = '未尝试';
let Schema = null;
try {
  const schemastery = await import('@deepseek-ai/schemastery');
  Schema = schemastery?.default ?? schemastery?.Schema ?? null;
  schemaSource = Schema ? '@deepseek-ai/schemastery（裸名 import，DSH 从安装目录供给）' : '模块已加载，但没有默认导出';
} catch (err) {
  schemaSource = `${err?.code ?? 'IMPORT_FAILED'}: ${err?.message ?? err}`;
}

/**
 * 字段必须标 volatile，Host 才会把它放进「设置」的表单里：
 * Host 的设置文档由 volatileForm / isVolatilePath 过滤，只服务「含 volatile 字段」的条目，
 * 没有 volatile 字段的条目根本不出现在设置文档里（configForms.set 会静默返回 false）。
 * 这不是「免重启」：Cordis 收到配置变化一律走 fiber.restart()，本插件会重新挂载。
 * 本插件 14 个字段都是运行期参数，所以全部标 volatile。
 */
const hot = (s) => (s && typeof s.volatile === 'function' ? s.volatile() : s);
const withDesc = (s, text) => (s && typeof s.description === 'function' ? s.description(text) : s);
/** volatile + 说明文案，一步到位 */
const field = (s, text) => withDesc(hot(s), text);

/** 这一行的配置表单（Schema 缺失时导出 undefined） */
export const Config = Schema
  ? Schema.object({
      enabled: field(Schema.boolean().default(true), '总开关：关掉即停止监听，不需要卸载插件'),
      allowCidrs: field(
        Schema.array(Schema.string()).default(['100.64.0.0/10']),
        '允许来访的网段（唯一的安全边界）；listen 为 auto 时也用它挑选本机要监听的地址',
      ),
      denyCidrs: field(Schema.array(Schema.string()).default([]), '白名单内的例外黑名单，例如排除某台机器'),
      listen: field(
        Schema.array(Schema.string()).default(['auto']),
        "要监听的本机地址；['auto'] = 只监听 allowCidrs 里属于本机的地址",
      ),
      port: field(Schema.natural().max(65535).default(0), '监听端口；0 = 系统随机（想存书签就固定，如 19388）'),
      maxConnections: field(Schema.natural().default(64), '并发连接上限；0 = 不限制'),
      allowWebSocket: field(Schema.boolean().default(true), '是否透传 WebSocket —— 界面靠它实时推送，一般别关'),
      upstream: field(
        Schema.string().default('auto'),
        "DSH 界面地址；'auto' = 自动探测，也可显式写 http://127.0.0.1:19387",
      ),
      rewriteHost: field(Schema.boolean().default(true), '把 Host/Origin 改写成上游回环地址（省去改 client-connection）'),
      forwardClientHeaders: field(Schema.boolean().default(true), '转发 x-forwarded-for / x-forwarded-proto'),
      timeoutMs: field(Schema.natural().default(0), '上游请求超时（毫秒）；0 = 不超时'),
      urlFile: field(
        Schema.string().default(''),
        '带票网址写到哪；留空 = <DSH_HOME>/remote-access-url.txt，填 off = 不写',
      ),
      printUrl: field(Schema.boolean().default(true), '把监听结果与网址同时打到 DSH 日志'),
      // 只在 patch（cordis.patch.yml）里配，不进设置页：6 位数字密码是凭据，不该躺在表单里被随手看见
      accessCode: field(
        Schema.string().default(''),
        '网段内的解锁密码（6 位数字）；留空 = 关闭解锁页，必须用带票网址访问。设了它，手机直接打开裸地址输一次密码即可',
      ),
      banFile: field(
        Schema.string().default(''),
        '拉黑名单写到哪；留空 = 与状态文件同目录的 remote-access-bans.txt。删掉里面那行即可解封',
      ),
      logLevel: field(Schema.string().default('info'), '日志详细程度：silent / info / debug（默认 info）'),
    })
  : undefined;

const DEFAULTS = {
  enabled: true,
  allowCidrs: ['100.64.0.0/10'],
  denyCidrs: [],
  listen: ['auto'],
  port: 0,
  maxConnections: 64,
  allowWebSocket: true,
  upstream: 'auto',
  rewriteHost: true,
  forwardClientHeaders: true,
  timeoutMs: 0,
  urlFile: '',
  printUrl: true,
  accessCode: '',
  banFile: '',
  logLevel: 'info',
};

// ---------------------------------------------------------------- 配置

/** Loader 行 id = 设置命名空间 = cordis.patch.yml 里那一行的 id（热重载按它找配置） */
const ROW_ID = 'remote-access';

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 兼容两种形态的 config：普通值，或 Schema 字段引用（后者要 .get()） */
function unwrap(v) {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try {
      const inner = v.get();
      if (inner !== v) return inner;
    } catch { /* 退回原值 */ }
  }
  return v;
}

function pickConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULTS)) {
    const value = unwrap(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeConfig(rawIn) {
  const c = { ...DEFAULTS, ...pickConfig(rawIn) };
  c.allowCidrs = asArray(unwrap(c.allowCidrs)).map((s) => String(s).trim()).filter(Boolean);
  c.denyCidrs = asArray(unwrap(c.denyCidrs)).map((s) => String(s).trim()).filter(Boolean);
  const listen = asArray(unwrap(c.listen)).map((s) => String(s).trim()).filter(Boolean);
  c.listen = listen.length === 0 || (listen.length === 1 && listen[0] === 'auto') ? 'auto' : listen;
  c.port = Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535 ? c.port : 0;
  c.maxConnections =
    Number.isInteger(c.maxConnections) && c.maxConnections >= 0 ? c.maxConnections : DEFAULTS.maxConnections;
  c.timeoutMs = Number.isInteger(c.timeoutMs) && c.timeoutMs >= 0 ? c.timeoutMs : 0;
  c.enabled = c.enabled !== false;
  c.rewriteHost = c.rewriteHost !== false;
  c.forwardClientHeaders = c.forwardClientHeaders !== false;
  c.allowWebSocket = c.allowWebSocket !== false;
  c.printUrl = c.printUrl !== false;
  // 解锁密码只收「纯数字」，长度不限（用 6 位）；带空格或别的字符一律视为没设，避免误开
  c.accessCode = /^\d{4,12}$/.test(String(unwrap(c.accessCode) ?? '')) ? String(c.accessCode) : '';
  c.banFile = String(unwrap(c.banFile) ?? '').trim();
  c.logLevel = ['silent', 'info', 'debug'].includes(String(c.logLevel)) ? String(c.logLevel) : 'info';
  return c;
}

/** 状态文件路径（urlFile 为空 → <DSH_HOME>/remote-access-url.txt；'off' → 不写） */
function statusPathOf(cfg) {
  if (cfg.urlFile === 'off') return '';
  return cfg.urlFile && cfg.urlFile !== '' ? cfg.urlFile : defaultStatusFile();
}

/** 拉黑名单文件路径 */
function banPathOf(cfg) {
  if (cfg.banFile) return cfg.banFile;
  const statusPath = statusPathOf(cfg);
  const dir = statusPath ? path.dirname(statusPath) : path.dirname(defaultStatusFile());
  return path.join(dir, 'remote-access-bans.txt');
}

/**
 * 放行 cookie 的密钥：落盘持久化，**故意**与 accessCode 解耦 ——
 * 改密码（甚至重启 DSH）都不会把已经进来的手机踢出去。想强制所有人重新输密码，删掉这个文件。
 */
function secretPathOf(cfg) {
  const statusPath = statusPathOf(cfg);
  const dir = statusPath ? path.dirname(statusPath) : path.dirname(defaultStatusFile());
  return path.join(dir, 'remote-access-secret');
}

function loadSecret(cfg) {
  const file = secretPathOf(cfg);
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(saved)) return saved;
  } catch { /* 还没有就建一个 */ }
  const created = randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(file, `${created}\n`, { mode: 0o600 });
  } catch { /* 写不进去就只在本次进程内有效 */ }
  return created;
}

// ---------------------------------------------------------------- IP / 网段

function ip4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const s of parts) {
    const v = Number(s);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n >>> 0;
}

function inCidr4(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = bitsRaw === undefined || bitsRaw === '' ? 32 : Number(bitsRaw);
  const a = ip4ToInt(ip);
  const b = ip4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function bareIp(ip) {
  const s = String(ip || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function matchAny(ip, cidrs) {
  const v4 = !String(ip).includes(':');
  for (const entry of cidrs) {
    if (String(entry).includes(':')) {
      const [prefix] = String(entry).split('/');
      if (!v4 && String(ip).toLowerCase().startsWith(prefix.toLowerCase())) return true;
    } else if (v4 && inCidr4(ip, entry)) {
      return true;
    }
  }
  return false;
}

/** 白名单命中且不在黑名单里 */
function peerAllowed(ip, cfg) {
  if (!matchAny(ip, cfg.allowCidrs)) return false;
  if (cfg.denyCidrs.length && matchAny(ip, cfg.denyCidrs)) return false;
  return true;
}

function localAddrsIn(cidrs) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni || ni.internal) continue;
      const ip = ni.address;
      if (String(ip).includes(':')) continue;
      if (matchAny(ip, cidrs)) out.push(ip);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- 上游探测

function parseUpstream(spec) {
  const s = String(spec).trim();
  let m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(s);
  if (m) return { host: m[1], port: Number(m[2] || (s.startsWith('https') ? 443 : 80)) };
  m = /^([^:/]+):(\d+)$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]) };
  return null;
}

function resolveUpstream(ctx, cfg, note) {
  try {
    const related = Object.keys(ctx ?? {})
      .filter((k) => /web|http|server|connect|browser|profile/i.test(k))
      .slice(0, 24);
    note('debug', `ctx 上与 web/连接相关的键: ${related.length ? related.join(',') : '(无)'}`);
  } catch (err) {
    note('debug', `枚举 ctx 键失败: ${err?.message}`);
  }

  if (cfg.upstream && cfg.upstream !== 'auto') {
    const parsed = parseUpstream(cfg.upstream);
    if (parsed) {
      note('info', `upstream: 使用显式配置 ${parsed.host}:${parsed.port}`);
      return parsed;
    }
    note('warn', `upstream: 配置无法解析 (${cfg.upstream})，回退到自动探测`);
  }

  for (const name of ['webStartup', 'webServer', 'webRuntime', 'webApp', 'web']) {
    let svc;
    try { svc = ctx?.[name]; } catch { /* 需要 inject 才能属性访问 */ }
    if (svc === undefined || svc === null) {
      try { svc = typeof ctx?.get === 'function' ? ctx.get(name) : undefined; } catch { /* 忽略 */ }
    }
    if (svc === undefined || svc === null) {
      note('debug', `探测 ctx.${name}: 不存在`);
      continue;
    }
    const keys = (() => {
      try { return Object.keys(svc).slice(0, 12).join(','); } catch { return '(无法枚举)'; }
    })();
    const port = Number(svc?.port ?? svc?.address?.port ?? NaN);
    note('debug', `探测 ctx.${name}: 存在，keys=[${keys}]，port=${Number.isFinite(port) ? port : '无'}`);
    if (Number.isInteger(port) && port > 0) return { host: '127.0.0.1', port };
  }

  for (const key of ['DSH_WEB_PORT', 'DSH_PORT']) {
    const v = Number(process.env[key] ?? NaN);
    note('debug', `探测 $${key}: ${process.env[key] ?? '(未设置)'}`);
    if (Number.isInteger(v) && v > 0) return { host: '127.0.0.1', port: v };
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (!/^DSH_.*URL$/i.test(k) || typeof v !== 'string') continue;
    const parsed = parseUpstream(v);
    note('debug', `探测 $${k}=${v}`);
    if (parsed) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------- 反向代理

/** 解锁页路径与我们的放行 cookie 名（cookie 密钥落盘持久化，改密码不会把人踢下线） */
const UNLOCK_PATH = '/__remote_access__/unlock';
const UNLOCK_COOKIE = 'dsh-ra-ok';

/** 极简解锁页：只在手机上调一次，够用就好，不依赖任何外部资源 */
function unlockPageHtml(hint) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程访问</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e8eaed;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(92vw,320px);padding:24px;border-radius:14px;background:#171a21;box-shadow:0 8px 32px #0006;text-align:center}
h1{margin:0 0 6px;font-size:18px;font-weight:600}
p{margin:0 0 16px;font-size:13px;opacity:.7}
input{width:100%;box-sizing:border-box;padding:12px;font:inherit;font-size:22px;letter-spacing:.3em;text-align:center;
border-radius:10px;border:1px solid #2c313c;background:#0f1115;color:inherit}
button{margin-top:12px;width:100%;padding:12px;font:inherit;font-weight:600;border:0;border-radius:10px;background:#3b82f6;color:#fff}
.err{margin-top:12px;font-size:13px;color:#f87171;min-height:1.2em}
</style></head><body><main>
<h1>远程访问</h1><p>请输入访问密码</p>
<form method="post" action="${UNLOCK_PATH}" autocomplete="off">
<input name="code" type="password" inputmode="numeric" maxlength="12" autofocus required>
<button type="submit">进入</button></form>
<div class="err">${hint}</div>
</main></body></html>`;
}

/** 读一个小请求体（解锁表单，限 2KB） */
function readSmallBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function upstreamHeaders(headers, up, cfg, peer) {
  const h = { ...headers };
  if (cfg.rewriteHost) {
    h.host = `${up.host}:${up.port}`;
    if (h.origin !== undefined) h.origin = `http://${up.host}:${up.port}`;
  }
  if (cfg.forwardClientHeaders) {
    h['x-forwarded-proto'] = 'http';
    h['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer;
  } else {
    delete h['x-forwarded-for'];
    delete h['x-forwarded-proto'];
  }
  return h;
}

/**
 * 起一个监听。
 * @param gate 访问门：`{ accessCode, cookieValue, banPath, authorize(req), banned(ip), ban(ip), withTicket(url, cookie), note }`
 *   —— 门只在 accessCode 非空时启用；为空时行为与以前完全一致（裸地址交给 DSH 自己 401）。
 */
function startProxy(addr, cfg, up, note, onListening, gate) {
  let active = 0;

  const deny = (res, code, text) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const peer = bareIp(req.socket.remoteAddress);
    if (!peerAllowed(peer, cfg) || gate.banned(peer)) {
      note('debug', `拒绝 ${peer} → 403（不在允许网段、命中黑名单，或在拉黑名单里）`);
      deny(res, 403, '403 forbidden: peer not allowed\n');
      return;
    }

    // 解锁提交：一次不过就拉黑
    if (req.method === 'POST' && String(req.url).startsWith(UNLOCK_PATH) && gate.accessCode) {
      readSmallBody(req).then((body) => {
        const code = new URLSearchParams(body).get('code') ?? '';
        if (code === '') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(unlockPageHtml('密码不能为空'));
          return;
        }
        if (code === gate.accessCode) {
          note('info', `${peer} 解锁成功`);
          res.writeHead(303, {
            location: '/',
            'set-cookie': `${UNLOCK_COOKIE}=${gate.cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
          });
          res.end();
          return;
        }
        gate.ban(peer);
        note('warn', `${peer} 密码错误，已加入拉黑名单（删掉 ${gate.banPath} 里那一行即可解封）`);
        deny(res, 403, '403 forbidden: wrong code, this address is now blocked\n');
      }).catch(() => deny(res, 400, '400 bad request\n'));
      return;
    }

    // 远程页面改配置不走这里：DSH 的 Remote 通道（ctx.remote.settings.mutate）本来就是通的，
    // 客户端只是按「非回环页面」策略不去调它。曾经在这里自建过一个 /config 端点，
    // 结果是写盘撞上 HMR 事务（"HMR transactions cannot be nested"）——别再走那条路。

    const authorized = gate.authorize(req);
    // 没授权 + 是个页面导航 → 给解锁页；其余一律交给 DSH 自己答（保持原来的 401 行为）
    if (!authorized && gate.accessCode && isNavigation(req)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(unlockPageHtml(''));
      return;
    }

    const options = {
      host: up.host,
      port: up.port,
      method: req.method,
      path: authorized ? gate.withTicket(req.url, req.headers.cookie) : req.url,
      headers: upstreamHeaders(req.headers, up, cfg, peer),
    };
    if (cfg.timeoutMs > 0) options.timeout = cfg.timeoutMs;
    const upReq = http.request(options, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upReq.on('timeout', () => {
      note('debug', `上游响应超时（${cfg.timeoutMs}ms）`);
      upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (err) => {
      note('debug', `上游请求失败: ${err?.message}`);
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('502 bad gateway: upstream unreachable\n');
      } catch { /* 已发出 */ }
    });
    req.pipe(upReq);
  });

  server.on('connection', (socket) => {
    if (cfg.maxConnections > 0 && active >= cfg.maxConnections) {
      note('debug', `连接数超过上限 ${cfg.maxConnections}，丢弃新连接`);
      socket.destroy();
      return;
    }
    active += 1;
    socket.on('close', () => { active -= 1; });
  });

  // WebSocket / 事件流透传（DSH 界面靠它推送）。升级请求走 DSH cookie，不补票（补票会被 303 打断）。
  server.on('upgrade', (req, socket, head) => {
    const peer = bareIp(socket.remoteAddress);
    if (!peerAllowed(peer, cfg) || gate.banned(peer)) {
      note('debug', `拒绝 ${peer} 的 WebSocket`);
      socket.destroy();
      return;
    }
    if (!cfg.allowWebSocket) {
      note('debug', 'allowWebSocket=false，拒绝 WebSocket 升级');
      socket.destroy();
      return;
    }
    const upstream = net.connect(up.port, up.host, () => {
      const headers = upstreamHeaders(req.headers, up, cfg, peer);
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        raw += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
      }
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', (err) => {
      note('debug', `WebSocket 上游失败: ${err?.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  });

  server.on('error', (err) => note('error', `监听 ${addr} 失败: ${err?.message}`));
  server.listen({ host: addr, port: cfg.port }, () => {
    const actual = server.address();
    const port = actual && typeof actual === 'object' ? actual.port : cfg.port;
    note('info', `已在 ${addr}:${port} 监听`);
    onListening(addr, port);
  });
  return server;
}

/** 是不是「浏览器地址栏打开的页面」——只有这种请求才值得回解锁页 */
function isNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = String(req.url ?? '/');
  if (url === '/' || url.startsWith('/?') || url.startsWith('/#')) return true;
  return String(req.headers.accept ?? '').includes('text/html');
}

// ---------------------------------------------------------------- 带票网址

function connectionOf(ctx) {
  try {
    const direct = ctx?.connection;
    if (direct) return direct;
  } catch { /* 需要 inject 才能做属性访问 */ }
  try {
    return typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  } catch {
    return undefined;
  }
}

/** 从 connection 服务铸一张票，返回 token 本身（补票要用；拿不到就返回 null） */
function mintTicket(ctx, up, note) {
  const conn = connectionOf(ctx);
  const fn = conn?.authenticatedUrl;
  if (typeof fn !== 'function') {
    note('warn', '拿不到 connection.authenticatedUrl（铸不出带票网址，也没法给解锁后的请求补票）');
    return null;
  }
  try {
    const tokenized = fn.call(conn, `http://${up.host}:${up.port}`);
    if (typeof tokenized === 'string') {
      const m = /[?&]token=([^&\s]+)/.exec(tokenized);
      if (m) return decodeURIComponent(m[1]);
      note('warn', 'authenticatedUrl 未带 token 参数');
    }
  } catch (err) {
    note('warn', `authenticatedUrl 调用失败: ${err?.message}`);
  }
  return null;
}

function mintUrl(ticket, extAddr, port) {
  const hostPart = String(extAddr).includes(':') ? `[${extAddr}]` : String(extAddr);
  const external = `http://${hostPart}:${port}/`;
  return ticket ? `${external}?token=${encodeURIComponent(ticket)}` : external;
}

function defaultStatusFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'remote-access-url.txt');
}

/** 单次探测上游是否可达（任何 HTTP 状态码都算可达） */
function probeOnce(up) {
  return new Promise((resolve) => {
    const req = http.get({ host: up.host, port: up.port, path: '/', timeout: 2500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** DSH 界面可能比插件晚起来，所以重试若干次再下结论 */
async function verifyUpstream(up, note, attempts = 8, intervalMs = 2000) {
  for (let i = 1; i <= attempts; i += 1) {
    if (await probeOnce(up)) {
      note('info', `上游自检通过: ${up.host}:${up.port}（第 ${i} 次尝试；401 是正常的"没票"）`);
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  note('error', `上游自检一直失败: ${up.host}:${up.port} 连不上——请把 upstream 改成 DSH 界面实际端口，或设为 auto`);
  return false;
}

// ---------------------------------------------------------------- 入口

/** Connection 服务（authenticatedUrl 来自它）；不声明 inject 会抛 without inject */
export const inject = ['connection'];

export function apply(ctx, config) {
  let cfg = normalizeConfig(config);
  const notes = [];
  let urls = [];
  let servers = [];
  let ticket = null; // 当前进程的 DSH token：给「已解锁但还没有 DSH cookie」的请求补票
  let closed = false;
  let cookieValue = ''; // start() 里从持久化密钥读出来
  let bans = new Set();
  let bansMtime = 0;
  let bansCheckedAt = 0;

  function render() {
    return [
      '# dsh-remote-access 状态（本文件含访问令牌，等于本机操作权限，别外传）',
      `# 更新时间: ${new Date().toISOString()}`,
      '',
      urls.length ? `远程访问网址: ${urls.join('  ')}` : '远程访问网址: （尚未生成）',
      cfg.accessCode && urls.length ? `手机访问: ${urls[0].split('?')[0]} —— 直接打开，输一次访问密码即可` : '',
      `解锁密码: ${cfg.accessCode ? '已设置（网段内一次不过即拉黑）' : '未设置（必须用带票网址访问）'}`,
      `拉黑名单: ${banPathOf(cfg)}（删掉里面那行即可解封，最长 1 秒生效）`,
      `放行密钥: ${secretPathOf(cfg)}（改密码不会踢人；想让所有设备重新输密码就删掉它）`,
      '',
      '--- 生效配置 ---',
      JSON.stringify({ ...cfg, accessCode: cfg.accessCode ? '***' : '' }, null, 2),
      '',
      '--- 诊断 ---',
      ...notes.map((n) => `${n.at}  [${n.level}] ${n.msg}`),
      '',
    ].join('\n');
  }

  function flush() {
    if (cfg.urlFile === 'off') return;
    try {
      fs.writeFileSync(statusPathOf(cfg), render(), { mode: 0o600 });
    } catch (err) {
      try { ctx?.logger?.warn?.(`[remote-access] 写状态文件失败: ${err?.message}`); } catch { /* 忽略 */ }
    }
  }

  const note = (level, msg) => {
    notes.push({ at: new Date().toISOString(), level, msg });
    if (notes.length > 200) notes.splice(0, notes.length - 200); // 热重载会反复跑，别把状态文件撑爆
    const toLogger = cfg.logLevel === 'debug' || (cfg.logLevel === 'info' && level !== 'debug');
    if (toLogger) {
      try {
        if (level === 'error') ctx?.logger?.error?.(`[remote-access] ${msg}`);
        else if (level === 'warn') ctx?.logger?.warn?.(`[remote-access] ${msg}`);
        else ctx?.logger?.info?.(`[remote-access] ${msg}`);
      } catch { /* 日志不可用就算了 */ }
    }
    flush();
  };

  note('info', `apply 开始；DSH_HOME=${process.env.DSH_HOME ?? '(未设置)'} DSH_PROFILE=${process.env.DSH_PROFILE ?? '(未设置)'}`);
  if (Schema) {
    note('debug', `Config schema 已就绪（${schemaSource}）→「设置 → 远程访问」可写`);
  } else {
    note(
      'error',
      `Config schema 没拿到（${schemaSource}）→「设置 → 远程访问」点保存会失败。` +
        'profile 里以 link: 安装的插件，必须在自己的 package.json 的 peerDependencies 里' +
        '列出要从 DSH 安装目录借用的包（DSH 的 routeLinked 只对声明过的裸名放行）；改完需重启 DSH。',
    );
  }

  // ---------------------------------------------------------------- 拉黑名单
  // 一次密码输错就拉黑；名单落在文件里，删掉那一行即可解封（最多 1 秒后自动重读）

  function refreshBans(force) {
    const now = Date.now();
    if (!force && now - bansCheckedAt < 1000) return;
    bansCheckedAt = now;
    let stat;
    try {
      stat = fs.statSync(banPathOf(cfg));
    } catch {
      if (force) {
        bans = new Set();
        bansMtime = 0;
      }
      return;
    }
    if (!force && stat.mtimeMs === bansMtime) return;
    bansMtime = stat.mtimeMs;
    try {
      bans = new Set(
        fs
          .readFileSync(banPathOf(cfg), 'utf8')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#')),
      );
    } catch { /* 读不到就维持现状 */ }
  }

  function ban(peer) {
    refreshBans(false);
    if (bans.has(peer)) return;
    bans.add(peer);
    try {
      const file = banPathOf(cfg);
      const head = fs.existsSync(file) ? '' : '# dsh-remote-access 拉黑名单：一行一个 IP；删掉那一行即可解封\n';
      fs.appendFileSync(file, `${head}${peer}\n`, { mode: 0o600 });
      bansMtime = 0; // 下次检查重新读一遍文件
    } catch { /* 写不进去也不影响内存里的拉黑 */ }
  }

  // ---------------------------------------------------------------- 访问门
  // accessCode 为空时整扇门是「透明的」：行为与以前完全一致（裸地址交给 DSH 自己 401）。

  const gate = {
    get accessCode() { return cfg.accessCode; },
    get banPath() { return banPathOf(cfg); },
    get cookieValue() { return cookieValue; },
    banned(peer) {
      refreshBans(false);
      return bans.has(peer);
    },
    ban,
    /** 已授权：带票、DSH 自己的 cookie，或我们发过的放行 cookie */
    authorize(req) {
      if (/(?:[?&])token=/.test(String(req.url ?? ''))) return true;
      const cookie = String(req.headers.cookie ?? '');
      if (/dsh-auth-/i.test(cookie)) return true;
      return Boolean(cfg.accessCode) && cookie.includes(`${UNLOCK_COOKIE}=${cookieValue}`);
    },
    /** 给已授权但还没有 DSH cookie 的请求补票（浏览器始终看不到 token） */
    withTicket(url, cookie) {
      if (!ticket) return url;
      if (/dsh-auth-/i.test(String(cookie ?? ''))) return url;
      if (/(?:[?&])token=/.test(url)) return url;
      return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(ticket)}`;
    },
  };

  // 远程页面改配置**不需要** Host 半区做什么：手机上那一页直接调 ctx.remote.settings.mutate，
  // 由 Host 网关去跑 settings 控制器 → configEditor.edit，跑在网关自己的上下文里。
  // （曾在这里自建过一个 POST /config 端点：它撞 HMR 事务必失败，而且回执早于写盘、会把旧值
  //   当成功回报 —— 用户看到的就是「显示已保存、实则回退」。已删除，别再走那条路。）

  // ---------------------------------------------------------------- 起停

  function stopServers() {
    for (const server of servers) {
      try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
      try { server.close(); } catch { /* 已关闭 */ }
    }
    servers = [];
    urls = [];
  }

  function start() {
    stopServers();
    if (!cfg.enabled) {
      note('info', 'enabled=false，不启动');
      return;
    }

    const up = resolveUpstream(ctx, cfg, note);
    if (!up) {
      note('error', '找不到 DSH 界面端口：把 cordis.patch.yml 里那一行的 upstream 设成 http://127.0.0.1:<端口>');
      return;
    }
    note('info', `上游确定为 ${up.host}:${up.port}`);
    void verifyUpstream(up, note);

    ticket = mintTicket(ctx, up, note);
    cookieValue = loadSecret(cfg);
    refreshBans(true);
    if (cfg.accessCode) {
      note('info', `解锁密码已启用：网段内直接打开裸地址、输一次密码即可（输错一次即拉黑）`);
    }
    if (bans.size) note('warn', `当前拉黑 ${bans.size} 个地址: ${[...bans].join(', ')}`);

    const addrs = cfg.listen === 'auto' ? localAddrsIn(cfg.allowCidrs) : cfg.listen;
    note('info', `本机候选地址(${JSON.stringify(cfg.allowCidrs)}) = ${JSON.stringify(addrs)}`);
    if (addrs.length === 0) {
      note('error', '没有可监听的本机地址：请把 allowCidrs 改成实际网段，或显式设置 listen');
      return;
    }

    for (const addr of addrs) {
      try {
        servers.push(
          startProxy(addr, cfg, up, note, (boundAddr, port) => {
            urls.push(mintUrl(ticket, boundAddr, port));
            if (cfg.printUrl) note('info', `远程访问网址: ${urls[urls.length - 1]}`);
            flush();
          }, gate),
        );
      } catch (err) {
        note('error', `启动 ${addr} 失败: ${err?.message}`);
      }
    }
    flush();
  }

  function dispose() {
    if (closed) return;
    closed = true;
    stopServers();
    note('info', '已停止监听');
  }

  // ---------------------------------------------------------------- 热重载
  // 设置页保存 → configEditor 写 patch 并重组 → 根上下文发 app-boot/config-reload
  // （settings provider 自己也听这个事件）。我们跟着重读生效配置、原地重挂监听，不必重启 DSH。

  /** 从 settings 服务读这一行的生效配置：user 是刚写进 patch 的那层，base 是它下面继承的层 */
  function configFromSettings() {
    let settings;
    try {
      settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
    } catch {
      return undefined;
    }
    if (!settings || typeof settings.describe !== 'function') return undefined;
    try {
      const view = settings.describe({ redactSecrets: true }).find((row) => row?.ns === ROW_ID);
      if (!view) return undefined;
      return normalizeConfig({ ...(view.base ?? {}), ...(view.user ?? {}) });
    } catch (err) {
      note('warn', `热重载读配置失败: ${err?.message}`);
      return undefined;
    }
  }

  function reapply() {
    if (closed) return;
    const next = configFromSettings();
    if (!next) return;
    if (JSON.stringify(next) === JSON.stringify(cfg)) return;
    const changed = Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(cfg[key]));
    cfg = next;
    note('info', `配置热重载（${changed.join(', ') || '无字段差异'}），按新参数重挂监听`);
    start();
  }

  // ---------------------------------------------------------------- 首次启动 + 收尾

  note('info', `apply 开始；DSH_HOME=${process.env.DSH_HOME ?? '(未设置)'} DSH_PROFILE=${process.env.DSH_PROFILE ?? '(未设置)'}`);
  if (Schema) {
    note('debug', `Config schema 已就绪（${schemaSource}）→「设置 → 远程访问」可写`);
  } else {
    note(
      'error',
      `Config schema 没拿到（${schemaSource}）→「设置 → 远程访问」点保存会失败。` +
        'profile 里以 link: 安装的插件，必须在自己的 package.json 的 peerDependencies 里' +
        '列出要从 DSH 安装目录借用的包（DSH 的 routeLinked 只对声明过的裸名放行）；改完需重启 DSH。',
    );
  }

  start();

  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose);
  } catch { /* 靠返回值清理 */ }
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('app-boot/config-reload', reapply);
      note('debug', '已挂上 app-boot/config-reload：设置页保存后热重载');
    } else {
      note('debug', '这个上下文没有 ctx.on，热重载没挂上（保存后需重启 DSH）');
    }
  } catch (err) {
    note('warn', `热重载没挂上: ${err?.message}`);
  }
  return dispose;
}
