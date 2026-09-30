/**
 * dsh-remote-access —— 把本机 DSH 的网页界面开放给指定网段（例如 Tailscale），
 * 供手机 / 另一台电脑通过一条「带票的网址」访问。
 *
 * 设计要点：
 *  1. 只监听「允许网段」里属于本机的地址（listen=auto），别的一律不绑，绝不含 0.0.0.0；
 *  2. 每个连进来的对端也必须落在允许网段内、且不在黑名单里，否则 403；
 *  3. 访问仍需 DSH 自己的令牌/cookie（没票就是 401），本插件不提供任何绕过；
 *  4. 默认把 Host/Origin 改写成上游回环 authority，因此不必去改 client-connection 的配置；
 *  5. 无论成功失败都会写一份「自诊断文件」，把生效配置、上游探测、监听结果写清楚。
 *
 * 参数全部走 Config（插件页里可直接改），零第三方依赖。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 可选加载 cordis 的 Schema：在 DSH 里能解析到（随安装提供）；
// 在纯 node 环境（例如 tools/test-remote-access.mjs）拿不到就降级成「无 schema」，插件照常工作。
const cordis = await import('@deepseek-ai/cordis').catch(() => null);
const Schema = cordis?.Schema;
const withDesc = (s, text) => (s && typeof s.description === 'function' ? s.description(text) : s);

/** 插件页里这一行的配置表单（Schema 缺失时导出 undefined） */
export const Config = Schema
  ? Schema.object({
      enabled: withDesc(Schema.boolean().default(true), '总开关：关掉即停止监听，不需要卸载插件'),
      allowCidrs: withDesc(
        Schema.array(Schema.string()).default(['100.64.0.0/10']),
        '允许来访的网段（唯一的安全边界）；listen 为 auto 时也用它挑选本机要监听的地址',
      ),
      denyCidrs: withDesc(Schema.array(Schema.string()).default([]), '白名单内的例外黑名单，例如排除某台机器'),
      listen: withDesc(
        Schema.array(Schema.string()).default(['auto']),
        "要监听的本机地址；['auto'] = 只监听 allowCidrs 里属于本机的地址",
      ),
      port: withDesc(Schema.natural().max(65535).default(0), '监听端口；0 = 系统随机（想存书签就固定，如 19388）'),
      maxConnections: withDesc(Schema.natural().default(64), '并发连接上限；0 = 不限制'),
      allowWebSocket: withDesc(Schema.boolean().default(true), '是否透传 WebSocket —— 界面靠它实时推送，一般别关'),
      upstream: withDesc(
        Schema.string().default('auto'),
        "DSH 界面地址；'auto' = 自动探测，也可显式写 http://127.0.0.1:19387",
      ),
      rewriteHost: withDesc(Schema.boolean().default(true), '把 Host/Origin 改写成上游回环地址（省去改 client-connection）'),
      forwardClientHeaders: withDesc(Schema.boolean().default(true), '转发 x-forwarded-for / x-forwarded-proto'),
      timeoutMs: withDesc(Schema.natural().default(0), '上游请求超时（毫秒）；0 = 不超时'),
      urlFile: withDesc(
        Schema.string().default(''),
        '带票网址写到哪；留空 = <DSH_HOME>/remote-access-url.txt，填 off = 不写',
      ),
      printUrl: withDesc(Schema.boolean().default(true), '把监听结果与网址同时打到 DSH 日志'),
      logLevel: withDesc(Schema.string().default('info'), '日志详细程度：silent / info / debug（默认 info）'),
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
  logLevel: 'info',
};

// ---------------------------------------------------------------- 配置

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
  c.logLevel = ['silent', 'info', 'debug'].includes(String(c.logLevel)) ? String(c.logLevel) : 'info';
  return c;
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

function startProxy(addr, cfg, up, note, onListening) {
  let active = 0;

  const server = http.createServer((req, res) => {
    const peer = bareIp(req.socket.remoteAddress);
    if (!peerAllowed(peer, cfg)) {
      note('debug', `拒绝 ${peer} → 403（不在允许网段或命中黑名单）`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 forbidden: peer not allowed\n');
      return;
    }
    const options = {
      host: up.host,
      port: up.port,
      method: req.method,
      path: req.url,
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

  // WebSocket / 事件流透传（DSH 界面靠它推送）
  server.on('upgrade', (req, socket, head) => {
    const peer = bareIp(socket.remoteAddress);
    if (!peerAllowed(peer, cfg)) {
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

function mintUrl(ctx, up, extAddr, port, note) {
  const hostPart = String(extAddr).includes(':') ? `[${extAddr}]` : String(extAddr);
  const external = `http://${hostPart}:${port}/`;
  const conn = connectionOf(ctx);
  const fn = conn?.authenticatedUrl;
  if (typeof fn !== 'function') {
    note('warn', '拿不到 connection.authenticatedUrl（铸不出带票网址）');
    return external;
  }
  try {
    const tokenized = fn.call(conn, `http://${up.host}:${up.port}`);
    if (typeof tokenized === 'string') {
      const q = tokenized.includes('?') ? tokenized.slice(tokenized.indexOf('?')) : '';
      if (q) return external + q;
      note('warn', 'authenticatedUrl 未带 token 参数');
    }
  } catch (err) {
    note('warn', `authenticatedUrl 调用失败: ${err?.message}`);
  }
  return external;
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
  const cfg = normalizeConfig(config);
  const notes = [];
  const urls = [];
  const statusPath = cfg.urlFile && cfg.urlFile !== '' && cfg.urlFile !== 'off' ? cfg.urlFile : defaultStatusFile();

  function render() {
    return [
      '# dsh-remote-access 状态（本文件含访问令牌，等于本机操作权限，别外传）',
      `# 更新时间: ${new Date().toISOString()}`,
      '',
      urls.length ? `远程访问网址: ${urls.join('  ')}` : '远程访问网址: （尚未生成）',
      '',
      '--- 生效配置 ---',
      JSON.stringify(cfg, null, 2),
      '',
      '--- 诊断 ---',
      ...notes.map((n) => `${n.at}  [${n.level}] ${n.msg}`),
      '',
    ].join('\n');
  }

  function flush() {
    if (cfg.urlFile === 'off') return;
    try {
      fs.writeFileSync(statusPath, render(), { mode: 0o600 });
    } catch (err) {
      try { ctx?.logger?.warn?.(`[remote-access] 写状态文件失败: ${err?.message}`); } catch { /* 忽略 */ }
    }
  }

  const note = (level, msg) => {
    notes.push({ at: new Date().toISOString(), level, msg });
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

  if (!cfg.enabled) {
    note('info', 'enabled=false，不启动');
    return () => {};
  }

  const up = resolveUpstream(ctx, cfg, note);
  if (!up) {
    note('error', '找不到 DSH 界面端口：请在插件页把 upstream 显式设成 http://127.0.0.1:<端口>');
    flush();
    return () => {};
  }
  note('info', `上游确定为 ${up.host}:${up.port}`);
  void verifyUpstream(up, note);

  const addrs = cfg.listen === 'auto' ? localAddrsIn(cfg.allowCidrs) : cfg.listen;
  note('info', `本机候选地址(${JSON.stringify(cfg.allowCidrs)}) = ${JSON.stringify(addrs)}`);
  if (addrs.length === 0) {
    note('error', '没有可监听的本机地址：请把 allowCidrs 改成实际网段，或显式设置 listen');
    flush();
    return () => {};
  }

  const servers = [];
  let closed = false;
  for (const addr of addrs) {
    try {
      servers.push(
        startProxy(addr, cfg, up, note, (boundAddr, port) => {
          const url = mintUrl(ctx, up, boundAddr, port, note);
          urls.push(url);
          if (cfg.printUrl) note('info', `远程访问网址: ${url}`);
          flush();
        }),
      );
    } catch (err) {
      note('error', `启动 ${addr} 失败: ${err?.message}`);
    }
  }
  flush();

  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const s of servers) {
      try { s.close(); } catch { /* 已关闭 */ }
    }
    note('info', '已停止监听');
  };
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose);
  } catch { /* 靠返回值清理 */ }
  return dispose;
}
