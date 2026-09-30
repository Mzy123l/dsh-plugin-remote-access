/**
 * dsh-remote-access —— 把本机 DSH 的网页界面开放给指定网段（例如 Tailscale），
 * 供手机 / 另一台电脑通过一条「带票的网址」访问。
 *
 * 设计要点：
 *  1. listen=auto 时只监听「允许网段」里属于本机的地址，别的一律不绑（绝不含 0.0.0.0）；
 *  2. 每个连进来的对端也必须落在允许网段内，否则 403；
 *  3. 访问仍需 DSH 自己的令牌/cookie（没票就是 401），本插件不提供任何绕过；
 *  4. 默认把 Host/Origin 改写成上游回环 authority，因此不必去改 client-connection 的配置；
 *  5. 无论成功失败都会写一份「自诊断文件」，把生效配置、上游探测过程、监听结果写清楚，
 *     这样在看不到 DSH 日志时也能定位问题。
 *
 * 零依赖：只用 node: 内置模块。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  enabled: true,
  allowCidrs: ['100.64.0.0/10'],
  listen: 'auto',
  port: 0,
  upstream: 'auto',
  rewriteHost: true,
  urlFile: '',
  printUrl: true,
};

// ---------------------------------------------------------------- 配置

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeConfig(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.allowCidrs = asArray(c.allowCidrs).map((s) => String(s).trim()).filter(Boolean);
  c.listen = c.listen === 'auto' ? 'auto' : asArray(c.listen).map((s) => String(s).trim()).filter(Boolean);
  c.port = Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535 ? c.port : 0;
  c.enabled = c.enabled !== false;
  c.rewriteHost = c.rewriteHost !== false;
  c.printUrl = c.printUrl !== false;
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

/** 从多个候选里找出 DSH 界面所在端口，并把探测过程记录进诊断 */
function resolveUpstream(ctx, cfg, note) {
  // 诊断：把 ctx 上与「网页/连接」相关的键列出来，便于定位该读哪个服务
  try {
    const related = Object.keys(ctx ?? {})
      .filter((k) => /web|http|server|connect|browser|profile/i.test(k))
      .slice(0, 24);
    note(`ctx 上与 web/连接相关的键: ${related.length ? related.join(',') : '(无)'}`);
  } catch (err) {
    note(`枚举 ctx 键失败: ${err?.message}`);
  }

  if (cfg.upstream && cfg.upstream !== 'auto') {
    const parsed = parseUpstream(cfg.upstream);
    if (parsed) {
      note(`upstream: 使用显式配置 ${parsed.host}:${parsed.port}`);
      return parsed;
    }
    note(`upstream: 配置无法解析 (${cfg.upstream})，回退到自动探测`);
  }

  for (const name of ['webStartup', 'webServer', 'webRuntime', 'webApp', 'web']) {
    let svc;
    try { svc = ctx?.[name]; } catch { /* 访问器抛错就跳过 */ }
    if (svc === undefined || svc === null) {
      try { svc = typeof ctx?.get === 'function' ? ctx.get(name) : undefined; } catch { /* 忽略 */ }
    }
    if (svc === undefined || svc === null) {
      note(`探测 ctx.${name}: 不存在`);
      continue;
    }
    const keys = (() => { try { return Object.keys(svc).slice(0, 12).join(','); } catch { return '(无法枚举)'; } })();
    const port = Number(svc?.port ?? svc?.address?.port ?? NaN);
    note(`探测 ctx.${name}: 存在，keys=[${keys}]，port=${Number.isFinite(port) ? port : '无'}`);
    if (Number.isInteger(port) && port > 0) return { host: '127.0.0.1', port };
  }

  for (const key of ['DSH_WEB_PORT', 'DSH_PORT']) {
    const v = Number(process.env[key] ?? NaN);
    note(`探测 $${key}: ${process.env[key] ?? '(未设置)'}`);
    if (Number.isInteger(v) && v > 0) return { host: '127.0.0.1', port: v };
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (!/^DSH_.*URL$/i.test(k) || typeof v !== 'string') continue;
    const parsed = parseUpstream(v);
    note(`探测 $${k}=${v}`);
    if (parsed) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------- 反向代理

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
      note(`上游自检通过: ${up.host}:${up.port}（第 ${i} 次尝试；401 是正常的"没票"）`);
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  note(`上游自检一直失败: ${up.host}:${up.port} 连不上——请把 upstream 改成 DSH 界面实际端口，或设为 auto`);
  return false;
}

function upstreamHeaders(headers, up, rewrite, peer) {
  const h = { ...headers };
  if (rewrite) {
    h.host = `${up.host}:${up.port}`;
    if (h.origin !== undefined) h.origin = `http://${up.host}:${up.port}`;
  }
  h['x-forwarded-proto'] = 'http';
  h['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer;
  return h;
}

function startProxy(addr, cfg, up, note, onListening) {
  const server = http.createServer((req, res) => {
    const peer = bareIp(req.socket.remoteAddress);
    if (!matchAny(peer, cfg.allowCidrs)) {
      note(`拒绝 ${peer} → 403（不在允许网段）`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 forbidden: peer not in allowCidrs\n');
      return;
    }
    const upReq = http.request(
      {
        host: up.host,
        port: up.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, up, cfg.rewriteHost, peer),
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upReq.on('error', (err) => {
      note(`上游请求失败: ${err?.message}`);
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('502 bad gateway: upstream unreachable\n');
      } catch { /* 已发出 */ }
    });
    req.pipe(upReq);
  });

  // WebSocket / 事件流透传（DSH 界面靠它推送）
  server.on('upgrade', (req, socket, head) => {
    const peer = bareIp(socket.remoteAddress);
    if (!matchAny(peer, cfg.allowCidrs)) {
      note(`拒绝 ${peer} 的 WebSocket（不在允许网段）`);
      socket.destroy();
      return;
    }
    const upstream = net.connect(up.port, up.host, () => {
      const headers = upstreamHeaders(req.headers, up, cfg.rewriteHost, peer);
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
      note(`WebSocket 上游失败: ${err?.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  });

  server.on('error', (err) => note(`监听 ${addr} 失败: ${err?.message}`));
  server.listen({ host: addr, port: cfg.port }, () => {
    const actual = server.address();
    const port = actual && typeof actual === 'object' ? actual.port : cfg.port;
    note(`已在 ${addr}:${port} 监听`);
    onListening(addr, port);
  });
  return server;
}

// ---------------------------------------------------------------- 网址

function mintUrl(ctx, up, extAddr, port, note) {
  const hostPart = String(extAddr).includes(':') ? `[${extAddr}]` : String(extAddr);
  const external = `http://${hostPart}:${port}/`;
  let tokenized;
  try {
    let conn;
    try { conn = ctx?.connection; } catch { /* 需要 inject 才能做属性访问 */ }
    if (!conn && typeof ctx?.get === 'function') {
      try { conn = ctx.get('connection'); } catch { /* 忽略 */ }
    }
    const fn = conn?.authenticatedUrl;
    if (typeof fn !== 'function') {
      note('拿不到 connection.authenticatedUrl（铸不出带票网址）');
      return external;
    }
    tokenized = fn.call(conn, `http://${up.host}:${up.port}`);
  } catch (err) {
    note(`authenticatedUrl 调用失败: ${err?.message}`);
  }
  if (typeof tokenized === 'string') {
    const q = tokenized.includes('?') ? tokenized.slice(tokenized.indexOf('?')) : '';
    if (q) return external + q;
    note('authenticatedUrl 未带 token 参数');
  }
  return external;
}

function defaultStatusFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'remote-access-url.txt');
}

// ---------------------------------------------------------------- 入口

/** 访问 Connection 服务（authenticatedUrl 来自它）。不声明 inject 时会抛
 *  "cannot get property ... without inject"，那样就铸不出带票网址。 */
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
      ...notes,
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

  const note = (msg) => {
    notes.push(`${new Date().toISOString()}  ${msg}`);
    try { ctx?.logger?.info?.(`[remote-access] ${msg}`); } catch { /* 忽略 */ }
    flush();
  };

  note(`apply 开始；DSH_HOME=${process.env.DSH_HOME ?? '(未设置)'} DSH_PROFILE=${process.env.DSH_PROFILE ?? '(未设置)'}`);

  if (!cfg.enabled) {
    note('enabled=false，不启动');
    return () => {};
  }

  const up = resolveUpstream(ctx, cfg, note);
  if (!up) {
    note('找不到 DSH 界面端口：请在本插件 config 里显式设置 upstream（例如 http://127.0.0.1:19387）');
    flush();
    return () => {};
  }
  note(`上游确定为 ${up.host}:${up.port}`);
  void verifyUpstream(up, note);

  const addrs = cfg.listen === 'auto' ? localAddrsIn(cfg.allowCidrs) : cfg.listen;
  note(`本机候选地址(${JSON.stringify(cfg.allowCidrs)}) = ${JSON.stringify(addrs)}`);
  if (addrs.length === 0) {
    note('没有可监听的本机地址：请把 allowCidrs 改成实际网段，或显式设置 listen');
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
          if (cfg.printUrl) note(`远程访问网址: ${url}`);
          flush();
        }),
      );
    } catch (err) {
      note(`启动 ${addr} 失败: ${err?.message}`);
    }
  }
  flush();

  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const s of servers) {
      try { s.close(); } catch { /* 已关闭 */ }
    }
    note('已停止监听');
  };
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose);
  } catch { /* 靠返回值清理 */ }
  return dispose;
}
