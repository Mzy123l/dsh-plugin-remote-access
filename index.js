/**
 * dsh-plugin-remote-access —— 把本机 DSH 的网页界面开放给指定网段（例如 Tailscale），
 * 供手机 / 另一台电脑通过一条「带票的网址」访问。
 *
 * 设计要点：
 *  1. 只监听「允许网段」里属于本机的地址（listen=auto），别的一律不绑，绝不含 0.0.0.0；
 *  2. 每个连进来的对端也必须落在允许网段内、且不在黑名单 / 拉黑名单里，否则 403；
 *  3. 默认仍走 DSH 自己的令牌/cookie（没票就是 401）；可选用 accessCode 开一个「网段内输一次 6 位密码」
 *     的解锁页，解锁后由本插件在服务端补票，浏览器始终看不到 token —— 一次输错就把该地址写进
 *     「排除的网段」(denyCidrs)，在设置页里删掉该项即可解封；写盘失败时它仍立刻被拦，
 *     只是先暂存在拉黑文件里，随后自动补写；
 *  4. 默认把 Host/Origin 改写成上游回环 authority，因此不必去改 client-connection 的配置；
 *  5. 无论成功失败都会写一份「自诊断文件」，把生效配置、上游探测、监听结果写清楚；
 *  6. 设置页保存后靠 `app-boot/config-reload` 原地重挂监听（热重载），不必重启 DSH。
 *
 * 参数全部走 Config（在「设置 → 远程访问」里改，其余只在 cordis.patch.yml 里配），零第三方依赖。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { pipeline } from 'node:stream';

/**
 * Host 侧写配置（`configEditor.edit`）本身跑在 HMR 事务里，而 HMR 用 AsyncLocalStorage 判嵌套：
 * 从「我们监听的请求回调」这条异步链里直接调它，必报 “HMR transactions cannot be nested”。
 * 下面这个异步资源在**模块加载时**创建（那时没有 HMR 事务），把写盘放进它的作用域即可绕开。
 * 导出它是为了让独立测试能验证「确实逃出了那个 store」。
 */
const configWriteScope = new AsyncResource('dsh-plugin-remote-access/config-write');

export function runOutsideHmr(fn) {
  return configWriteScope.runInAsyncScope(fn);
}

/** 拉黑的对端地址 → CIDR 文本（IPv4 用 /32，IPv6 用 /128） */
export function banCidrOf(peer) {
  const ip = String(peer ?? '').trim();
  return ip.includes(':') ? `${ip}/128` : `${ip}/32`;
}

/** 从 denyCidrs 里挑出「单主机」项（x/32、x/128，或无掩码的裸 IP）——用于展示与快速判断 */
export function bannedHostsOf(denyCidrs = []) {
  const hosts = new Set();
  for (const raw of Array.isArray(denyCidrs) ? denyCidrs : []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const single = /^([^/\s]+)\/(?:32|128)$/.exec(text);
    if (single) {
      hosts.add(single[1]);
      continue;
    }
    if (!text.includes('/') && /^[0-9a-f:.]+$/i.test(text)) hosts.add(text);
  }
  return hosts;
}

/**
 * 把某个地址合并进「排除的网段」：优先在现有 patch 值上追加，没有就基于继承值，
 * 去重后返回**整份新配置**（`configEditor.edit` 要的就是整份，不是补丁）。
 */
export function mergeDenyCidrs(current, inherited, cidr) {
  const pick = (value) =>
    Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
  const base = pick(current?.denyCidrs);
  const merged = [...new Set([...(base.length ? base : pick(inherited?.denyCidrs)), cidr])];
  return { ...current, denyCidrs: merged };
}

/**
 * 真正把拉黑写进配置：按 id 找到 loader 行 → 交给 `configEditor.edit`（在 runOutsideHmr 里跑）。
 * @returns 写进去的 CIDR 文本；抛错表示这次没写成（调用方会退回暂存文件并稍后重试）。
 */
export async function persistBanToDenyCidrs(editor, peer) {
  if (!editor) throw new Error('拿不到 configEditor 服务');
  const entry = editor.entries().find((row) => row?.options?.id === ROW_ID);
  if (!entry) throw new Error(`找不到配置行 ${ROW_ID}`);
  const cidr = banCidrOf(peer);
  await runOutsideHmr(() =>
    editor.edit(entry, (current, inherited) => mergeDenyCidrs(current, inherited, cidr)),
  );
  return cidr;
}

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
 * 本插件的字段都是运行期参数，所以全部标 volatile。
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
      denyCidrs: field(
        Schema.array(Schema.string()).default([]),
        '白名单内的例外黑名单；输错访问密码的地址会自动加到这里（形如 100.x.y.z/32），删掉该项即解封',
      ),
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
      // 密码是凭据，但设置页也收（手机端改完就能用）；非法值不会静默生效，见 normalizeConfig 与 apply 的告警
      accessCode: field(
        Schema.string().default(''),
        '网段内的解锁密码（4–12 位数字或字母）；留空 = 关闭解锁页，必须用带票网址访问。设了它，手机直接打开裸地址输一次密码即可；输错一次就把该地址写进「排除的网段」',
      ),
      remoteLayout: field(
        Schema.string().default('auto'),
        '远程页面的界面布局：auto = 按视口自动判断，phone = 强制手机布局（横竖屏自适应），desktop = 与桌面一致。只作用于远程页面，本机界面不受影响',
      ),
      phoneEnterNewline: field(
        Schema.boolean().default(true),
        '手机端按回车 = 换行，不发送：只有点「发送」按钮才真正发送（Ctrl/Cmd+Enter 仍是发送）。只作用于远程页面，本机界面不受影响',
      ),
      // 安卓外壳的状态栏通知（外壳自己在后台轮询 /__remote_access__/notify）
      notifyOnChoice: field(
        Schema.boolean().default(true),
        '模型提问（ask_user_question）且没人回答时，让安卓 App 弹状态栏通知。关掉只是不再上报待答状态，App 那边也就不会再提醒',
      ),
      notifyOnlyWhenWindowHidden: field(
        Schema.boolean().default(true),
        '只在「电脑上的 DSH 窗口不可见」（收进托盘 / 最小化 / 页面已关）时才通知手机；关掉则只要 App 不在前台就通知',
      ),
      notifyOnFinish: field(
        Schema.boolean().default(true),
        '一轮结束时通知手机（正常跑完与异常结束都算，异常会带上分类：模型输出格式错 / 余额额度不足 / 网络连不上 / 被限流…）。与「提问时通知手机」是同一个触发条件、互不影响',
      ),

      // 「UI 设置」一组：只作用于远程页面的官方界面偏好。官方在非回环页面上把设置通道降级成内存态
      // （ui-settings: persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'），手机端改了刷新就还原；
      // 所以这几项由本插件的配置负责持久化，远程页面每次打开时重新套用。'default' 一律表示「出厂值」。
      remoteTheme: field(
        Schema.string().default('default'),
        '远程页面的外观：default = 出厂值（跟随系统），dark = 深色，light = 浅色，system = 跟随系统。只作用于远程页面',
      ),
      remoteFontSize: field(
        Schema.number().default(0),
        '远程页面的正文字号（10–22，单位 px）：0 = 出厂值（14）。只作用于远程页面',
      ),
      remoteTranscriptView: field(
        Schema.string().default('default'),
        '远程页面的工作步骤展示：default = 出厂值，compact = 简洁，standard = 标准，detailed = 详细，verbose = 完全展开。只作用于远程页面',
      ),
      remoteDeveloperTools: field(
        Schema.string().default('default'),
        '远程页面的「显示代码工作视图」：default = 出厂值（开启），on = 开启，off = 关闭。只作用于远程页面',
      ),
      remotePerformanceUsage: field(
        Schema.string().default('default'),
        '远程页面的「性能与用量」：default = 出厂值（详细），compact = 简洁，detailed = 详细。只作用于远程页面',
      ),
      // 手机端缓存：缓存本体在手机的 WebView 里，宿主只负责把响应头喂对（见「手机端缓存策略」那一节）。
      // 宿主不落任何大文件，所以没有 cacheDir / 容量上限这类字段。
      cacheEnabled: field(
        Schema.boolean().default(true),
        '手机端资源缓存：给上游没给缓存头的静态资源（图片 / 视频 / 字体 / 打包产物…）补上新鲜期与弱校验器，手机重复打开不再重传。API、HTML、no-store 一律不碰',
      ),
      cacheTtlMinutes: field(
        Schema.natural().default(10),
        '上面那类资源的手机端新鲜期（分钟，1–1440）：期内手机一次请求都不发；过期后先出旧的、后台只做一次头部级核对（零字节）',
      ),
      cacheProbe: field(
        Schema.boolean().default(true),
        '过期核对时额外取首/尾各 64 KB 做指纹（治「换了图但字节数一模一样」）：不整份哈希、不落盘；关掉就只按长度+类型核对',
      ),
      cacheOverrideNoStore: field(
        Schema.boolean().default(false),
        '连上游标了 no-store 的大静态媒体（图片 / 音频 / 视频，≥64 KB）也缓存：壁纸那类实时抓帧一取就是几 MB，默认每次进页面都要重传。开着最多会看到 TTL 这么久之前的旧帧/旧音轨',
      ),
      cacheFullRange: field(
        Schema.boolean().default(false),
        '把「从 0 取到结尾」的整段 Range 请求当成整份来缓存：媒体元素取大文件时会发 Range，而浏览器永远不缓存 206 —— 于是每次进页面都要重下整段（实测壁纸音轨 3.8 MB × 2）。默认关：个别播放器可能因此失去拖动定位',
      ),
      banFile: field(
        Schema.string().default(''),
        '拉黑暂存文件；只有「写进排除的网段」失败时才用得上（留空 = 与状态文件同目录的 remote-access-bans.txt）。平时不用碰它',
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
  remoteLayout: 'auto',
  phoneEnterNewline: true,

  notifyOnChoice: true,
  notifyOnlyWhenWindowHidden: true,
  notifyOnFinish: true,

  remoteTheme: 'default',
  remoteFontSize: 0,
  remoteTranscriptView: 'default',
  remoteDeveloperTools: 'default',
  remotePerformanceUsage: 'default',
  cacheEnabled: true,
  cacheTtlMinutes: 10,
  cacheProbe: true,
  cacheOverrideNoStore: false,
  cacheFullRange: false,
  banFile: '',
  logLevel: 'info',
};

// ---------------------------------------------------------------- 配置

/**
 * Loader 行 id = 设置命名空间 = cordis.patch.yml 里那一行的 id（热重载按它找配置）。
 *
 * 0.2.1 起 DSH 自己也有一个 loader 行 id 叫 `remote-access`
 * （`@deepseek-ai/dsh-api-remote-access`）。行 id 必须全局唯一；重名会让官方的
 * `remoteAccess` 服务不挂载，桌面壳启动时 `settings/describe` 直接失败。
 * 所以插件行改成旧包名式的 `remote-access-cidr`，与官方行彻底分开。
 */
const ROW_ID = 'remote-access-cidr';

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

/**
 * 解锁密码的规范化：只认 4–12 位字母或数字。
 * 为什么要「拒绝」而不是原样收下：这个值一旦生效就是网段内的唯一凭据，
 * 打错一个符号（比如带空格、或写成 `12-34`）如果静默变成「没设密码」，
 * 用户会以为设好了、然后在手机上撞见 DSH 自己那句英文 401 —— 那是最难查的一种失效。
 * 所以这里返回空串，由 apply() 用一条 warn 把「你写的值没生效」说清楚。
 */
export function normalizeAccessCode(raw) {
  const text = String(raw ?? '').trim();
  return /^[A-Za-z0-9]{4,12}$/.test(text) ? text : '';
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
  // 解锁密码收 4–12 位字母或数字（大小写敏感）。带空格、符号或长度不对一律视为没设，
  // 避免「随手打了一串，以为设上了」——这类被丢掉的值会在 apply 里明确告警。
  c.accessCode = normalizeAccessCode(unwrap(c.accessCode));
  c.remoteLayout = ['auto', 'phone', 'desktop'].includes(String(unwrap(c.remoteLayout)))
    ? String(unwrap(c.remoteLayout))
    : 'auto';
  // 手机端「回车=换行」：与其它布尔开关同一口径，非 false 即开
  c.phoneEnterNewline = c.phoneEnterNewline !== false;
  // 手机端缓存：开关非 false 即开；新鲜期卡在 1–1440 分钟（写错值退回默认，不悄悄变成「永久」）
  c.cacheEnabled = c.cacheEnabled !== false;
  const cacheTtl = Number(unwrap(c.cacheTtlMinutes));
  c.cacheTtlMinutes = Number.isInteger(cacheTtl) && cacheTtl >= 1 && cacheTtl <= 1440
    ? cacheTtl
    : DEFAULTS.cacheTtlMinutes;
  c.cacheProbe = c.cacheProbe !== false;
  // 「连 no-store 的大静态媒体也缓存」是**显式**开关：默认关，因为它是逆着上游意愿来的
  c.cacheOverrideNoStore = c.cacheOverrideNoStore === true;
  // 「整段 Range 当整份缓存」同理：默认关（会改变媒体分段的语义）
  c.cacheFullRange = c.cacheFullRange === true;
  // 通知这一组是布尔开关，非 false 即开（与其它布尔项同一口径，写错值不会悄悄改变行为）
  c.notifyOnChoice = c.notifyOnChoice !== false;
  c.notifyOnlyWhenWindowHidden = c.notifyOnlyWhenWindowHidden !== false;
  c.notifyOnFinish = c.notifyOnFinish !== false;
  // 「UI 设置」一组：取值一律「出厂值优先」——不认识的值退回 'default'（= 不干预官方默认），
  // 而不是随便挑一个看起来合理的档位，免得配置里写错一个字就悄悄改了手机上的外观。
  const pickUiOne = (raw, allowed) => (allowed.includes(String(unwrap(raw))) ? String(unwrap(raw)) : 'default');
  c.remoteTheme = pickUiOne(c.remoteTheme, ['default', 'dark', 'light', 'system']);
  const uiFontSize = Number(unwrap(c.remoteFontSize));
  c.remoteFontSize = Number.isInteger(uiFontSize) && uiFontSize >= 10 && uiFontSize <= 22 ? uiFontSize : 0;
  c.remoteTranscriptView = pickUiOne(c.remoteTranscriptView, ['default', 'compact', 'standard', 'detailed', 'verbose']);
  c.remoteDeveloperTools = pickUiOne(c.remoteDeveloperTools, ['default', 'on', 'off']);
  c.remotePerformanceUsage = pickUiOne(c.remotePerformanceUsage, ['default', 'compact', 'detailed']);
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

/**
 * 解析上游地址。0.2.1 起 Web 可以自己开 HTTPS（`--tls-cert/--tls-key`），
 * 所以这里必须把协议一起带出来 —— 只记 host/port 会拿 http 去连 https 端口。
 * @returns {{ protocol: 'http:'|'https:', host: string, port: number } | null}
 */
export function parseUpstream(spec) {
  const s = String(spec).trim();
  let m = /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(s);
  if (m) {
    const secure = m[1] === 'https';
    return { protocol: secure ? 'https:' : 'http:', host: m[2], port: Number(m[3] || (secure ? 443 : 80)) };
  }
  m = /^([^:/]+):(\d+)$/.exec(s);
  if (m) return { protocol: 'http:', host: m[1], port: Number(m[2]) };
  return null;
}

/**
 * 探测本机 DSH 界面的地址。
 *
 * 0.2.1 的桌面端改成「系统分配端口」，不再固定 19387；因此 auto 优先读
 * `webServer.getOrigin()`（它同时给出协议和真实监听端口），读不到再退回
 * `port` / 环境变量。写死端口那套在这里已经不再可靠。
 */
export function resolveUpstream(ctx, cfg, note) {
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
      note('info', `upstream: 使用显式配置 ${parsed.protocol}//${parsed.host}:${parsed.port}`);
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
    // 0.2.1：webServer.getOrigin() 直接给出「协议 + 真实监听端口」。
    // 桌面端现在用系统分配端口，只有这里拿到的才是本进程真正在听的那个。
    try {
      const origin = typeof svc?.getOrigin === 'function' ? svc.getOrigin() : svc?.origin;
      const parsed = typeof origin === 'string' ? parseUpstream(origin) : null;
      if (parsed) {
        note('debug', `探测 ctx.${name}.getOrigin(): ${origin}`);
        return parsed;
      }
    } catch (err) {
      note('debug', `探测 ctx.${name}.getOrigin() 失败: ${err?.message}`);
    }
    const keys = (() => {
      try { return Object.keys(svc).slice(0, 12).join(','); } catch { return '(无法枚举)'; }
    })();
    const port = Number(svc?.port ?? svc?.address?.port ?? NaN);
    // webStartup 的 tls 是「配了证书」而不是监听结果；webServer 的 protocol 才是事实
    const secure =
      svc?.protocol === 'https:' ||
      (name === 'webStartup' && svc?.tls !== undefined && svc?.tls !== null);
    note('debug', `探测 ctx.${name}: 存在，keys=[${keys}]，port=${Number.isFinite(port) ? port : '无'}，protocol=${secure ? 'https:' : 'http:'}`);
    if (Number.isInteger(port) && port > 0) return { protocol: secure ? 'https:' : 'http:', host: '127.0.0.1', port };
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

/** 安卓外壳轮询「有没有选择在等我」的端点（由本插件的代理自己回答，不落到上游） */
const NOTIFY_PATH = '/__remote_access__/notify';
/** 本机 DSH 页面回报「窗口此刻可见吗」的端点（注册在上游 webServer 上，只有本机能直接打到） */
const PRESENCE_PATH = '/__remote_access__/presence';
/** 手机端缓存策略的自检端点（设置页「缓存」子菜单里读它） */
const CACHE_PATH = '/__remote_access__/cache';

/** 极简解锁页：只在手机上调一次，够用就好，不依赖任何外部资源 */
function unlockPageHtml(hint) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>DSH 远程访问</title><style>
:root{color-scheme:light dark;--bg:#f2f5fb;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--field:#f8fafc;
--accent:#2563eb;--accent-fg:#fff;--err:#dc2626;--shadow:0 18px 48px rgba(15,23,42,.14)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#141821;--fg:#e8eaed;--muted:#9aa4b2;--line:#242a36;
--field:#0f131a;--accent:#3b82f6;--err:#f87171;--shadow:0 18px 48px rgba(0,0,0,.45)}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 20px calc(24px + env(safe-area-inset-bottom));
background:radial-gradient(1100px 520px at 50% -12%,rgba(59,130,246,.20),transparent 62%),var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
main{width:min(100%,380px)}
.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin:0 0 16px}
.mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;
background:linear-gradient(140deg,#60a5fa,#1d4ed8);box-shadow:0 8px 20px rgba(37,99,235,.35)}
.brand b{font-size:15px;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow)}
h1{margin:0 0 4px;font-size:19px;font-weight:650;letter-spacing:.01em}
p.sub{margin:0 0 18px;font-size:13px;color:var(--muted)}
label{display:block;margin:0 0 6px;font-size:12px;color:var(--muted)}
input{width:100%;padding:13px 14px;font:inherit;font-size:20px;letter-spacing:.22em;text-align:center;color:inherit;
border:1px solid var(--line);border-radius:12px;background:var(--field);outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
button{margin:14px 0 0;width:100%;padding:13px;font:inherit;font-weight:600;color:var(--accent-fg);background:var(--accent);
border:0;border-radius:12px;cursor:pointer;transition:filter .15s,transform .05s}
button:hover{filter:brightness(1.06)}
button:active{transform:translateY(1px)}
button[disabled]{opacity:.7;cursor:default}
.err{margin:12px 0 0;min-height:1.2em;font-size:13px;color:var(--err)}
.foot{margin:14px 0 0;font-size:12px;line-height:1.6;color:var(--muted);text-align:center}
</style></head><body><main>
<div class="brand"><span class="mark">DSH</span><b>远程访问</b></div>
<div class="card">
<h1>输入访问密码</h1>
<p class="sub">这台设备需要解锁一次，之后 30 天内免密。</p>
<form method="post" action="${UNLOCK_PATH}" autocomplete="off">
<label for="code">访问密码</label>
<input id="code" name="code" type="password" inputmode="text" maxlength="12" autofocus required
 autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
<button type="submit" id="go">进入</button>
</form>
<div class="err">${hint}</div>
</div>
<div class="foot">密码在电脑上「设置 → 远程访问 → 访问密码」里；输错一次这台设备会被临时挡住</div>
<script>var f=document.querySelector('form');f.addEventListener('submit',function(){var b=document.getElementById('go');
b.disabled=true;b.textContent='验证中…';});document.getElementById('code').focus();</script>
</main></body></html>`;
}

/**
 * 「这次访问没有可用凭据」时的页面：替换 DSH 自己那句
 * `dsh web authentication required; reopen the URL printed by dsh web.`
 *
 * 为什么必须换掉：那句话对手机用户等于零信息 —— 它不会说「这张票是旧的」，
 * 也不会说「去哪儿拿当前那张」。而这里是**唯一**知道全部来龙去脉的地方：
 * 我们知道页面导航拿的是哪张票、知道本次实例当前有没有解锁密码。
 *
 * 两条不能违反的约束：
 *   1. 绝不把当前 token 写进这个页面 —— 它发给的是**尚未通过校验**的对端，
 *      写上去等于把本机操作权限送人。所以只说「去哪拿」。
 *   2. 不降低任何鉴权：这里只是把「没凭据」讲清楚，不代替 DSH 放行。
 */
function noCredentialPageHtml({ hadToken, hasAccessCode, statusPath }) {
  const reason = hadToken
    ? '这次带的 <code>?token=…</code> 已经作废了 —— 每次启动 DSH 都会换一张新票，旧网址、别的账户留下的网址都不能再用。'
    : '这次访问没有带凭据（没有 <code>?token=…</code>，浏览器里也没有 DSH 的登录 cookie）。';
  const how = hasAccessCode
    ? '本实例设了「访问密码」：稍后重试一次会看到输入密码的页面。'
    : '去本机 DSH 的「设置 → 远程访问」里复制**当前**那条「远程访问网址」（带票），或在那里设一个「访问密码」，之后就能直接打开裸地址输密码。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程访问 · 需要重新取票</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e8eaed;
font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(94vw,420px);padding:22px 22px 18px;border-radius:14px;background:#171a21;box-shadow:0 8px 32px #0006}
h1{margin:0 0 10px;font-size:17px;font-weight:600}
p{margin:0 0 12px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f1115;padding:1px 5px;border-radius:4px}
ol{margin:0;padding-left:1.25em}
li{margin:0 0 6px}
.hint{margin-top:14px;font-size:12.5px;opacity:.65;word-break:break-all}
a{color:#60a5fa}
</style></head><body><main>
<h1>这次没能通过校验</h1>
<p>${reason}</p>
<p>接下来这样做：</p>
<ol>
  <li>${how}</li>
  <li>旧标签页里的网址别再用；用刚复制的那条打开。</li>
</ol>
<p class="hint">状态文件（本机）：<code>${statusPath || '&lt;DSH_HOME&gt;/remote-access-url.txt'}</code><br>
本页由 dsh-plugin-remote-access 生成，只在这里解释原因，不放行任何请求。</p>
<p><a href="/">重试一次</a></p>
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
    const scheme = up.protocol === 'https:' ? 'https' : 'http';
    h.host = `${up.host}:${up.port}`;
    // Origin 带协议：DSH 0.2.1 的 Host/Origin 栅栏会比较它，写错协议与没改写一样会被拒
    if (h.origin !== undefined) h.origin = `${scheme}://${up.host}:${up.port}`;
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

// ---------------------------------------------------------------- 手机端缓存策略
//
// 缓存本体在**手机**的 WebView 里，宿主一个字节的大文件都不落盘。这里只做两件事：
//   1. 把响应头喂对：上游什么都不发的那些静态资源，由我们补上新鲜期与（弱）校验器；
//   2. 替手机判定条件请求：手机带我们自己发的校验器回来时，只做一次「响应头 + 首/尾片段」的核对，
//      对得上就回 304（零字节），对不上才把新的一份发过去。
//
// 为什么坚持不落盘、也不读宿主文件系统：资源可能在任何盘、任何路径上（非默认目录、多个 Windows
// 用户各自的空间、用软/硬链接搭出来的共用目录）。判定只看「URL（剔除 token）」与上游给的响应头，
// 上述这些形态对我们就是透明的，也不会出现「A 用户缓存被 B 用户读到」。缓存满了不归我们管：
// Chromium 的 HTTP 缓存自己 LRU 淘汰，被淘汰的代价只是重新下载一次。
//
// 三类资源的通用判据（不认任何插件名、不认路径前缀）：
//   · 内容寻址（URL 里真有内容哈希）→ immutable，一年不重取；
//   · 上游已给 ETag/Last-Modified  → 只补新鲜期，校验器仍由上游回答；
//   · 上游什么都没给（壁纸就是这类）→ 新鲜期内一次请求都不发；过期后由我们用首/尾片段指纹核对。

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
/** stale-while-revalidate：过期后先出旧的、后台再去核对，手机端不会看到等待 */
const CACHE_SWR_SECONDS = 12 * 3600;
/** 上游临时出错时，允许多久之内继续用手上这份 */
const CACHE_STALE_IF_ERROR_SECONDS = 86400;
/** 小于这个大小的响应直接缓冲整份算 sha256（精确校验器），不发探针 */
const CACHE_INLINE_MAX_BYTES = 256 * 1024;
/** 大资源只取首/尾各这么多字节做指纹 —— 不整份哈希 */
const CACHE_PROBE_BYTES = 64 * 1024;
/** application/octet-stream 这类「不知道是什么」的，小文件一律不缓存（多半是接口）*/
const CACHE_BINARY_MIN_BYTES = 64 * 1024;
/** 我们自己铸的校验器前缀：认得出它，才知道这个条件请求该由我们回答（而不是转给上游） */
const CACHE_ETAG_PREFIX = 'dshra-';

/** 短哈希：只用于指纹，不做安全用途 */
function shortHash(value, chars) {
  return createHash('sha256').update(value).digest('hex').slice(0, chars);
}

/**
 * URL 里的内容标识（没有就返回空串 = 不能按 immutable 处理）。
 *
 * 三种通用形态，都不认识具体插件：
 *   · `?rev=<hash>` —— DSH 插件包的产物修订号（由 size+mtime+ctime 推出，同一 URL ⇒ 同一份字节）；
 *   · `index-5SrrfWpU.js` 这类哈希文件名（Vite 产物）；
 *   · URL 里出现 64 位十六进制（内容寻址的附件 id 等）。
 * 判据刻意收紧：文件名段必须带哈希形态（同时含字母与数字、8–32 位），免得把 `client.js`、
 * `long-name.js` 这种普通名字当成内容哈希 —— 那会把可变的资源钉死一年。
 */
export function contentRevOf(rawUrl) {
  const url = String(rawUrl ?? '');
  if (!url) return '';
  const rev = /[?&]rev=([A-Za-z0-9._-]{8,})/.exec(url);
  if (rev) return `rev:${rev[1]}`;
  const sha = /(?:^|[^0-9a-f])([0-9a-f]{64})(?:[^0-9a-f]|$)/.exec(url);
  if (sha) return `sha:${sha[1]}`;
  const path = url.split(/[?#]/)[0];
  for (const segment of path.split('/')) {
    const named = /^.*?[-.]([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9]{1,6})$/.exec(segment);
    if (!named) continue;
    const hash = named[1];
    if (/[0-9]/.test(hash) && /[A-Za-z]/.test(hash)) return `name:${hash}`;
  }
  return '';
}

/** 静态资源类型：只有这些「可共享的静态产物」才值得我们补缓存头，HTML / 接口一律不碰 */
export function staticKindOf(contentType) {
  const ct = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (!ct) return '';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'media';
  if (ct.startsWith('font/') || ct.startsWith('application/font') || ct === 'application/vnd.ms-fontobject') return 'font';
  if (ct === 'text/css' || ct === 'text/javascript' || ct === 'application/javascript' || ct === 'application/wasm') return 'text';
  if (ct === 'application/octet-stream') return 'binary';
  if (ct === 'application/json' || ct === 'application/manifest+json') return 'json';
  return '';
}

/** If-None-Match 可能是列表；统一剥掉 W/ 与引号再比 */
export function etagTokensOf(value) {
  return String(value ?? '')
    .split(',')
    .map((piece) => piece.trim().replace(/^W\//i, ''))
    .filter(Boolean);
}

/** 这个条件请求用的是不是我们自己铸的校验器 */
export function isOwnEtag(value) {
  return etagTokensOf(value).some((token) => token.startsWith(`"${CACHE_ETAG_PREFIX}`));
}

/** 首/尾片段指纹：长度 + 类型 + 首片段 + 尾片段（不整份哈希） */
export function fingerprintEtagOf({ len, ct, head, tail }) {
  const parts = [Number.isFinite(len) ? String(len) : '-', shortHash(String(ct ?? ''), 8)];
  if (head) parts.push(shortHash(head, 16));
  if (tail) parts.push(shortHash(tail, 16));
  return `W/"${CACHE_ETAG_PREFIX}${parts.join('-')}"`;
}

/** 小资源：缓冲整份后算出的精确校验器（与指纹同一个前缀，比较时是同一个族） */
export function inlineEtagOf(len, ct, body) {
  return `W/"${CACHE_ETAG_PREFIX}${Number(len)}-${shortHash(String(ct ?? ''), 8)}-${shortHash(body, 16)}"`;
}

/** 给这类资源用的新鲜期头（T2/T3 共用；private：不许任何共享缓存留存 —— 多半是用户自己的东西） */
function ttlHeaderOf(plan) {
  const scope = plan.scope === 'public' ? 'public' : 'private';
  return `${scope}, max-age=${plan.ttlSeconds}, stale-while-revalidate=${CACHE_SWR_SECONDS}, stale-if-error=${CACHE_STALE_IF_ERROR_SECONDS}`;
}

/**
 * 「上游明说 no-store，但这是个大静态媒体」时由用户显式接管的方案（默认关，见 cacheOverrideNoStore）。
 * 只碰图片 / 音频 / 视频 / 字体 —— JSON、无类型二进制、文本一概不碰（那是接口与代码）。
 *
 * ⚠️ **刻意不要求 content-length**：壁纸那种抓帧是 `createReadStream` 直接 pipe 出去的（分块传输、
 * 没有长度头），上一版就是因为卡了长度而**一次都没生效**。大小改由探针读到的首段判定：
 * 探针拿到不足 64 KB 且总长确定 → 当作实时小端点，不缓存；超过 64 KB 或长度未知 → 按大媒体处理。
 */
export function cacheOverridePlan(url, headers, ttlSeconds) {
  const kind = staticKindOf(headers['content-type']);
  if (!['image', 'media', 'font'].includes(kind)) return null;
  const len = Number(headers['content-length']);
  const size = Number.isFinite(len) && len >= 0 ? len : NaN;
  const cc = String(headers['cache-control'] ?? '').toLowerCase();
  return { mode: 'override', kind, size, ttlSeconds, scope: cc.includes('public') ? 'public' : 'private' };
}

/**
 * 这个响应为什么没带缓存口径 —— 只给「大且没带」的那些写一句人话，进流量账。
 * 排查时最有用的就是这一列：看到「带 Range 的分段请求」就知道浏览器永远不会缓存它。
 */
export function cacheSkipReason({ url, status, method, headers, cfg, range }) {
  if (range !== undefined && range !== null) {
    return `带 Range 的分段请求（${String(range).slice(0, 24)}；浏览器不缓存 206）`;
  }
  if (!cfg || cfg.cacheEnabled === false) return '缓存总开关关着';
  if (String(method ?? 'GET').toUpperCase() !== 'GET') return `${String(method ?? '').toUpperCase()} 请求`;
  if (Number(status) !== 200) return `HTTP ${status}`;
  const h = headers ?? {};
  if (h['set-cookie'] !== undefined) return '带 Set-Cookie';
  const cc = String(h['cache-control'] ?? '').toLowerCase();
  if (cc.includes('no-store')) return '上游写了 no-store';
  if (cc.includes('no-cache')) return '上游写了 no-cache';
  if (cc.includes('max-age')) return '上游已有新鲜期（原样透传）';
  const rev = contentRevOf(url);
  const kind = staticKindOf(h['content-type']);
  const len = Number(h['content-length']);
  const size = Number.isFinite(len) && len >= 0 ? len : NaN;
  if (!kind && !rev) return `类型不在白名单（${String(h['content-type'] ?? '无 content-type').split(';')[0]}）`;
  if (kind === 'json' && !rev) return 'JSON 且非内容寻址';
  if (kind === 'binary' && !rev && !(size >= CACHE_BINARY_MIN_BYTES)) return '小块未知二进制';
  return '其它';
}

/**
 * 给一个「将要发给手机」的响应决定缓存口径。返回 null = 一个字都不改（不在白名单、或上游已有自己的口径）。
 * 纯粹的头部判断：不看盘、不看路径、不看插件名。
 */
export function cachePlanOf({ url, status, method, headers, cfg }) {
  if (!cfg || cfg.cacheEnabled === false) return null;
  if (String(method ?? 'GET').toUpperCase() !== 'GET') return null;
  if (Number(status) !== 200) return null;
  const h = headers ?? {};
  if (h['set-cookie'] !== undefined) return null;
  const cc = String(h['cache-control'] ?? '').toLowerCase();
  const ttlSeconds = Math.max(60, Math.round(Number(cfg.cacheTtlMinutes ?? 10) * 60));
  // 上游明确说「别存」「每次都得问」→ **默认尊重它**（壁纸插件对实时抓帧/预览族就是这么写的）。
  // 但「大静态媒体」允许由用户显式接管（默认关）：那种资源一取就是几 MB，而它其实很少变。
  if (cc.includes('no-store') || cc.includes('no-cache')) {
    return cfg.cacheOverrideNoStore === true ? cacheOverridePlan(url, h, ttlSeconds) : null;
  }
  const vary = String(h['vary'] ?? '').toLowerCase();
  if (/(^|[,\s])(\*|cookie|authorization)([,\s]|$)/.test(vary)) return null;
  // 上游自己给了新鲜期（immutable / max-age / must-revalidate）→ 那是它的口径，不插手
  if (cc.includes('max-age')) return null;
  const rev = contentRevOf(url);
  const kind = staticKindOf(h['content-type']);
  const rawLen = Number(h['content-length']);
  const size = Number.isFinite(rawLen) && rawLen >= 0 ? rawLen : NaN;
  if (!kind && !rev) return null;
  // 接口多半是 json / 未知二进制：只有内容寻址（静态产物）才敢碰
  if (kind === 'json' && !rev) return null;
  if (kind === 'binary' && !rev && !(size >= CACHE_BINARY_MIN_BYTES)) return null;
  const scope = cc.includes('public') ? 'public' : 'private';
  if (rev) return { mode: 'immutable', kind, size, ttlSeconds, scope, rev };
  if (h.etag !== undefined || h['last-modified'] !== undefined) {
    return { mode: 'validated', kind, size, ttlSeconds, scope };
  }
  return { mode: 'fingerprint', kind, size, ttlSeconds, scope };
}

/** 这次会话里的缓存计数：只用于状态文件与设置页那行自检，不落盘 */
export function createCacheStats() {
  return { immutable: 0, validated: 0, ttl: 0, notModified: 0, inline: 0, probe: 0, probeFail: 0, override: 0, recent: [] };
}

/** 记一笔决策（设置页与状态文件里能看到「这条 URL 被判成哪一类」）*/
export function noteCacheDecision(stats, url, kind) {
  if (!stats || !kind) return;
  stats.recent.push({ at: new Date().toISOString(), kind, url: String(url ?? '').slice(0, 200) });
  if (stats.recent.length > 8) stats.recent.splice(0, stats.recent.length - 8);
}

// ---------------------------------------------------------------- 流量账（只给人看，不落盘）
//
// 为什么必须有它：组合包（`/plugins/??…&rev=…`）那类响应是 **DSH 自己发的 immutable**，按「尊重上游」
// 的原则我们一个字都不改 —— 于是「我们加了什么头」的计数**看不见它们**，而它们正是十几 MB 的大头。
// 所以这里按 URL 记**字节数**，不管我们插没插手：谁在重传、重传了多少，一眼能看出来。
//
// 上限固定（最多 200 个键）、只聚合到路径（丢掉查询串）、只进内存 —— 这是排查用的账本，不是监控系统。

const TRAFFIC_KEYS_MAX = 200;

export function createTrafficStats() {
  return { since: Date.now(), totalIn: 0, totalOut: 0, wsIn: 0, wsOut: 0, uncachedOut: 0, rows: new Map() };
}

/**
 * 记一笔流量。
 * @param cached 这一份响应带没带缓存口径（我们补的、或上游本来就有的）——没带的就是「下次还会重传」的
 */
export function noteTraffic(stats, key, inBytes = 0, outBytes = 0, cached = true, reason = '') {
  if (!stats || !key) return;
  stats.totalIn += inBytes;
  stats.totalOut += outBytes;
  if (!cached) stats.uncachedOut += outBytes;
  let row = stats.rows.get(key);
  if (!row) {
    if (stats.rows.size >= TRAFFIC_KEYS_MAX) {
      // 满了就丢最小的一行（排查用，丢谁都不影响结论）
      let smallest = null;
      for (const [k, v] of stats.rows) {
        if (smallest === null || v.out < stats.rows.get(smallest).out) smallest = k;
      }
      if (smallest !== null) stats.rows.delete(smallest);
    }
    row = { hits: 0, in: 0, out: 0, cached: 0, reason: '' };
    stats.rows.set(key, row);
  }
  row.hits += 1;
  row.in += inBytes;
  row.out += outBytes;
  if (cached) row.cached += 1;
  // 只给「大且没带缓存口径」的留一句原因：这是排查时唯一能直接读懂的一列
  if (!cached && reason && outBytes >= 64 * 1024) row.reason = String(reason).slice(0, 80);
}

/** 给状态文件 / 设置页用的一份快照：按送出字节从多到少排，最多 top 条 */
export function trafficView(stats, top = 8) {
  const rows = [...(stats?.rows ?? new Map()).entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.out - a.out)
    .slice(0, top);
  return {
    since: stats?.since ?? 0,
    totalIn: stats?.totalIn ?? 0,
    totalOut: stats?.totalOut ?? 0,
    wsIn: stats?.wsIn ?? 0,
    wsOut: stats?.wsOut ?? 0,
    uncachedOut: stats?.uncachedOut ?? 0,
    top: rows,
  };
}

/** 清零（复现「退出重进」这类问题时先清一次，再看这一轮花了多少） */
export function resetTraffic(stats) {
  if (!stats) return;
  stats.since = Date.now();
  stats.totalIn = 0;
  stats.totalOut = 0;
  stats.wsIn = 0;
  stats.wsOut = 0;
  stats.uncachedOut = 0;
  stats.rows.clear();
}

/** 人看的字节数 */
export function humanBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------- 待答选择（安卓外壳的状态栏通知）

/** 桌面窗口可见性报告多久算过期：页面心跳 25s，而后台窗口的定时器会被系统节流，所以留足余量 */
const DESKTOP_FRESH_MS = 150000;
/** 一条通知里最多带几个选项标签（多了状态栏也显示不下） */
const MAX_OPTION_LABELS = 4;

/** 掐成一行短文本：通知里不需要换行，也不该把整篇计划塞进状态栏 */
function notifyText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * 把一轮结束时的错误翻成一句人话（通知里就靠这一句让人知道该干什么）。
 *
 * 依据是 **DSH 自己的错误码**（`dsh-llm` / `dsh-llm-deepseek` 里那些字面量），不是猜的：
 *   MALFORMED_RESPONSE（模型输出格式错，常伴随 JSON 解析失败）、QUOTA / ACCOUNT_QUOTA（余额 / 额度）、
 *   AUTH / INVALID_CREDENTIAL（凭据失效）、RATE_LIMIT（限流）、CONTEXT_WINDOW_EXCEEDED（上下文超长）、
 *   SERVER（上游 5xx）、EMPTY_RESPONSE（空回复）；网络那一族看 Node 的 errno。
 * 认不出来就退到错误本身那句话 —— 宁可原文，也不编一个假分类。
 */
export function describeAgentError(error) {
  const code = String(error?.code ?? error?.errno ?? '').toUpperCase();
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? error ?? '');
  const hay = `${code} ${name} ${message}`.toUpperCase();
  const has = (...needles) => needles.some((needle) => hay.includes(needle));
  if (has('MALFORMED_RESPONSE', 'INVALID_JSON', 'JSONDECODE', 'UNEXPECTED_TOKEN', 'PARSE')) {
    return { reason: '模型输出格式错', detail: notifyText(message || '模型返回的内容不是合法 JSON / 结构不符', 160) };
  }
  if (has('ACCOUNT_QUOTA', 'QUOTA', 'INSUFFICIENT', 'BALANCE', '402')) {
    return { reason: '余额 / 额度不足', detail: notifyText(message || '账号余额或额度不够了，去账户页充值或换成别的模型', 160) };
  }
  if (has('ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'FETCH FAILED', 'SOCKET HANG UP', 'UND_ERR', 'NETWORK')) {
    return { reason: '网络连不上', detail: notifyText(message || '连不上模型服务：检查网络 / 代理 / 本机网关', 160) };
  }
  if (has('RATE_LIMIT', 'TOO MANY REQUESTS', '429')) {
    return { reason: '被限流', detail: notifyText(message || '请求太频繁被限流，稍后会自动重试', 160) };
  }
  if (has('AUTH', 'INVALID_CREDENTIAL', 'UNAUTHORIZED', 'SESSION_EXPIRED', '401', '403')) {
    return { reason: '凭据失效', detail: notifyText(message || '登录凭据无效或已过期：重新登录 / 换 API Key', 160) };
  }
  if (has('CONTEXT_WINDOW_EXCEEDED', 'TOO MANY TOKENS', 'CONTEXT')) {
    return { reason: '上下文超长', detail: notifyText(message || '这轮上下文超出模型窗口：压缩会话或新开会话', 160) };
  }
  if (has('EMPTY_RESPONSE')) {
    return { reason: '模型返回空回复', detail: notifyText(message || '模型这次什么都没返回，重试一次通常就好', 160) };
  }
  if (has('SERVER', 'BAD GATEWAY', '502', '503', '504')) {
    return { reason: '模型服务端错误', detail: notifyText(message || '上层服务 5xx：稍后重试', 160) };
  }
  return { reason: '出错', detail: notifyText(message || '这一轮异常结束（细节见电脑上的 DSH 日志）', 160) };
}

/**
 * 「待答选择 + 一轮结束」中心：把宿主里正在等用户回答的提问、以及最近一次「跑完了 / 出错了」
 * 记成一份可轮询的状态。
 *
 * 四件事都在这里：
 *   1. track() —— 模型提问时（user-questions/request 瀑布）记一条，瀑布结束/被中止时清掉；
 *   2. reportFinish() —— 一轮结束（正常或异常）时记一条（只留最近一条，带自增 id 供外壳去重）；
 *   3. reportDesktop() —— 本机 DSH 页面回报「窗口可见吗」，用来判断电脑前有没有人看着；
 *   4. subscribe() —— 给长轮询用：状态一变就叫醒所有挂着的请求。
 *
 * rev 是给长轮询用的版本号：外壳带着上次的 rev 来问，一样就挂住等变化，不一样就立刻回。
 * 「结束」也要推 rev —— 不然外壳得等下一次轮询周期才知道跑完了（那就不是通知，是延迟）。
 */
export function createChoiceCenter(now = () => Date.now()) {
  /** id → 一条待答选择（id 用工具调用的 callId，同一批提问不会重复记） */
  const pending = new Map();
  const waiters = new Set();
  let rev = 0;
  let desktopVisible = null; // null = 还没收到过任何回报
  let desktopAt = 0;
  let seq = 0;
  /** 最近一次「一轮结束」（正常或出错）——只留一条；外壳按 id 去重 */
  let finish = null;
  let finishSeq = 0;
  /** 外壳最近一次自报的通知环境（App 版本 / 通知开没开 / 通道重要性），以及去重用的指纹 */
  let phoneSeen = null;
  let phoneLine = '';
  /** 本实例标记：见 view() 里那段「为什么光用 id 不行」 */
  const bootId = Math.random().toString(36).slice(2, 10);

  function wake() {
    if (waiters.size === 0) return;
    const list = [...waiters];
    waiters.clear();
    for (const fn of list) {
      try { fn(); } catch { /* 等待者自己的连接已经断了，随它去 */ }
    }
  }

  function bump() {
    rev += 1;
    wake();
  }

  /**
   * 记一条待答选择，返回清除函数（幂等）。
   * request 是 AskUserQuestionRequestEvent：questions 至少一条；wait.callId 有就用它当 id。
   */
  function track(request) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (questions.length === 0) return () => {};
    const callId = request?.wait?.callId;
    const id = callId === undefined || callId === null ? `q${++seq}` : String(callId);
    const first = questions[0] ?? {};
    pending.set(id, {
      id,
      at: now(),
      header: notifyText(first.header, 80),
      question: notifyText(first.question, 300),
      options: (Array.isArray(first.options) ? first.options : [])
        .map((option) => notifyText(option?.label, 60))
        .filter(Boolean)
        .slice(0, MAX_OPTION_LABELS),
      count: questions.length,
      timed: request?.wait?.timed === true,
    });
    bump();
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      if (pending.delete(id)) bump();
    };
    try { request?.signal?.addEventListener?.('abort', clear, { once: true }); } catch { /* 没有 signal 就靠瀑布结束 */ }
    return clear;
  }

  /**
   * 记一条「一轮结束」。
   *
   * 只留最近一条：这是**通知**，不是日志 —— 手机只该为最新那次响一声。
   * id 自增，外壳按它去重（同一条不重复弹；新的一条算新通知，横幅才会重新弹一次）。
   *
   * @param detail `{ ok, reason, message, ms }`：ok=false 表示异常结束，reason 是人话分类
   */
  function reportFinish(detail) {
    const info = detail && typeof detail === 'object' ? detail : {};
    finishSeq += 1;
    finish = {
      id: finishSeq,
      at: now(),
      ok: info.ok !== false,
      reason: notifyText(info.reason, 40),
      message: notifyText(info.message, 200),
      ms: Number.isFinite(info.ms) ? Number(info.ms) : 0,
    };
    bump();
    return finish;
  }

  /** 本机页面回报窗口可见性；报告过期（页面关了 / 电脑那边没在跑）时按「不可见」处理 */
  function reportDesktop(visible) {
    const next = visible === true;
    const changed = desktopVisible !== next;
    desktopVisible = next;
    desktopAt = now();
    if (changed) bump();
  }

  function desktopView() {
    const known = desktopAt > 0 && now() - desktopAt < DESKTOP_FRESH_MS;
    return { known, visible: known && desktopVisible === true, at: desktopAt };
  }

  /**
   * 外壳自报的「它那边的通知环境」：App 版本、通知开没开、「模型提问」通道的重要性。
   *
   * 为什么要让手机报上来：**「通知发出来了但不弹横幅」这种问题发生在手机那一端**，
   * 宿主和网页都看不见 —— 而设置页底部那行自检正是回答它的地方。报上来还顺带解决另一件事：
   * 一眼能看出手机上跑的 APK 到底是哪一版（「我装了新版」与「装上了」并不总是一回事）。
   * 注意**不要**因为这份报告去动 rev：外壳每次轮询都会报一次，动 rev 就成了自己叫醒自己的死循环。
   */
  function reportPhone(report) {
    if (!report || !report.app) return false;
    const line = `${report.app}|${report.notifications}|${report.importance}|${report.importanceFinish}`;
    const changed = line !== phoneLine;
    phoneLine = line;
    phoneSeen = { ...report, at: now() };
    return changed;
  }

  /** 给外壳的那份 JSON：外壳看 pending / finish / desktop.visible；phone 是它自己报上来的回显 */
  function view(cfg) {
    return {
      ok: true,
      rev,
      at: now(),
      // 本实例的标记（每次 apply 都换一个）：外壳用它 + finish.id 组成去重键 ——
      // 光用 id 不行：DSH 重启后 id 从 1 重新数，外壳会误以为「这条又变新了」而重复提醒。
      boot: bootId,
      enabled: cfg?.notifyOnChoice !== false,
      enabledFinish: cfg?.notifyOnFinish !== false,
      onlyWhenWindowHidden: cfg?.notifyOnlyWhenWindowHidden !== false,
      desktop: desktopView(),
      phone: phoneSeen,
      pending: [...pending.values()].sort((a, b) => a.at - b.at),
      finish,
    };
  }

  return {
    track,
    reportFinish,
    reportDesktop,
    reportPhone,
    phone: () => phoneSeen,
    finish: () => finish,
    view,
    desktopView,
    rev: () => rev,
    pendingCount: () => pending.size,
    subscribe(fn) {
      waiters.add(fn);
      return () => waiters.delete(fn);
    },
  };
}

/**
 * 起一个监听。
 * @param gate 访问门：`{ accessCode, cookieValue, banPath, authorize(req), banned(ip), ban(ip), withTicket(url, cookie), note }`
 *   —— 门只在 accessCode 非空时启用；为空时行为与以前完全一致（裸地址交给 DSH 自己 401）。
 * @param choice 待答选择中心（`createChoiceCenter()`）；给了就接管 `NOTIFY_PATH`，不给就照旧全转给上游。
 * @param cacheStats 手机端缓存的计数（`createCacheStats()`）；只用于状态文件与设置页自检。
 * @param trafficStats 流量账（`createTrafficStats()`）；按 URL 记字节，只进内存。
 */
function startProxy(addr, cfg, up, note, onListening, gate, choice, cacheStats, trafficStats) {
  let active = 0;

  const deny = (res, code, text) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
  };

  // ---------------------------------------------------------------- 手机端缓存：探针与自检
  //
  // 这里的所有动作都只谈「响应头 + 几 KB 片段」：不落盘、不读宿主文件系统、不按路径建键。
  // 也正因为如此，资源在哪个盘、哪个 Windows 用户的空间、是不是软/硬链接搭出来的共用目录，
  // 对这整套逻辑都是透明的。

  /** 只读上游这一份的开头若干字节（拿到头就够时立刻掐断连接），用于首/尾片段指纹 */
  function readTruncated(url, rangeValue, limit, clientHost) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      // Host 与主请求保持同一口径：rewriteHost=false 的用户是靠原样 Host 工作的，探针不能自作主张改写
      const hostHeader = cfg.rewriteHost ? `${up.host}:${up.port}` : String(clientHost || `${up.host}:${up.port}`);
      const headers = { host: hostHeader };
      if (rangeValue) headers.range = rangeValue;
      let req;
      try {
        req = upstreamClientOf(up).request(
          {
            host: up.host,
            port: up.port,
            method: 'GET',
            path: gate.withTicket(url, undefined),
            headers,
            timeout: cfg.timeoutMs > 0 ? cfg.timeoutMs : 0,
            ...tlsOptionsOf(up),
          },
          (res) => {
            const chunks = [];
            let got = 0;
            // complete = 上游自己把响应发完了（而不是我们读够 limit 就掐断）——
            // override 判定「这是不是个小响应」全靠它：分块传输没有长度头，读完了才知道它到底多大。
            const finish = (complete) =>
              done({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), complete: complete === true });
            res.on('data', (chunk) => {
              const room = limit - got;
              if (room <= 0) return;
              chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
              got += Math.min(chunk.length, room);
              if (got >= limit) {
                try { res.destroy(); } catch { /* 已经断了 */ }
                finish(false);
              }
            });
            res.on('end', () => finish(true));
            res.on('error', () => done(null));
          },
        );
      } catch {
        done(null);
        return;
      }
      req.on('timeout', () => req.destroy(new Error('probe timeout')));
      req.on('error', () => done(null));
      req.end();
    });
  }

  /**
   * 上游「当前这一份」的指纹：长度 + 类型 + 首片段（+ 尾片段）。
   * 只读首/尾各 64 KB —— 不整份哈希、不落盘，也不需要知道资源在宿主哪儿。
   */
  async function probeFingerprint(url, clientHost) {
    const head = await readTruncated(url, `bytes=0-${CACHE_PROBE_BYTES - 1}`, CACHE_PROBE_BYTES, clientHost);
    if (!head || (head.status !== 200 && head.status !== 206)) return { ok: false };
    const total = (() => {
      if (head.status === 206) {
        const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(head.headers['content-range'] ?? ''));
        if (m) return Number(m[1]);
      }
      const len = Number(head.headers['content-length']);
      return Number.isFinite(len) ? len : NaN;
    })();
    let tail = null;
    const wantTail = cfg.cacheProbe !== false && head.status === 206 && Number.isFinite(total) && total > CACHE_PROBE_BYTES * 2;
    if (wantTail) {
      const last = await readTruncated(url, `bytes=-${CACHE_PROBE_BYTES}`, CACHE_PROBE_BYTES, clientHost);
      if (last && last.status === 206) tail = last.body;
    }
    return {
      ok: true,
      len: total,
      ct: head.headers['content-type'],
      // 响应比 64 KB 还短时，这一段就是全部内容 —— 指纹因此是「整份」的（小文件本来就不贵）
      head: head.body,
      // 上游把这份发完了没有（override 判定「小响应」要用；分块传输没有长度头，只有这个能作数）
      complete: head.complete === true,
      tail,
    };
  }

  /**
   * 读满一份小响应（≤ limit），拿它算精确校验器。
   * 超过上限时**只是暂停**、不销毁：调用方会把已读到的前缀发出去、剩下的继续转发。
   */
  function readWhole(upRes, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let got = 0;
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        upRes.removeListener('data', onData);
        upRes.removeListener('end', onEnd);
        upRes.removeListener('error', onError);
        upRes.removeListener('close', onClose);
        resolve(value);
      };
      const onData = (chunk) => {
        got += chunk.length;
        if (got > limit) {
          try { upRes.pause(); } catch { /* 已经停了 */ }
          settle({ ok: false, part: Buffer.concat(chunks) });
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => settle({ ok: true, body: Buffer.concat(chunks) });
      const onError = () => settle({ ok: false, part: Buffer.concat(chunks) });
      // 半路被掐断时 end 与 error 都可能不来（只来 close），所以这条必须兜住 —— 否则这个 Promise 永远不落地
      const onClose = () => settle({ ok: false, part: Buffer.concat(chunks) });
      upRes.on('data', onData);
      upRes.on('end', onEnd);
      upRes.on('error', onError);
      upRes.on('close', onClose);
      upRes.resume();
    });
  }

  /** 回一个我们自己判定的 304（零字节）；上游那份响应由调用方掐掉 */
  function sendNotModified(res, plan, etag) {
    try {
      res.writeHead(304, {
        etag,
        'cache-control': plan.mode === 'immutable' ? CACHE_IMMUTABLE : ttlHeaderOf(plan),
      });
      res.end();
    } catch { try { res.destroy(); } catch { /* 已经断了 */ } }
  }

  /**
   * 设置页「缓存」子菜单读的自检：策略口径 + 本次会话的计数 + 最近几条判定 + 流量账。
   * 与通知端点同一套鉴权：没授权不给。带 `?reset=1` 时顺手把流量账清零（复现问题时先清一次）。
   */
  function handleCache(req, res) {
    if (req.method !== 'GET') {
      deny(res, 405, '405 method not allowed\n');
      return;
    }
    if (!gate.authorize(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const stats = cacheStats ?? createCacheStats();
    const url = new URL(String(req.url), 'http://127.0.0.1');
    if (url.searchParams.get('reset') === '1') resetTraffic(trafficStats);
    const traffic = trafficView(trafficStats, 10);
    const body = {
      ok: true,
      policy: {
        enabled: cfg.cacheEnabled !== false,
        ttlMinutes: cfg.cacheTtlMinutes,
        swrHours: CACHE_SWR_SECONDS / 3600,
        probe: cfg.cacheProbe !== false,
        immutable: true,
        honorsNoStore: cfg.cacheOverrideNoStore !== true,
        overrideNoStore: cfg.cacheOverrideNoStore === true,
        overrideRange: cfg.cacheFullRange === true,
        storesOnHost: false,
      },
      stats: {
        immutable: stats.immutable,
        validated: stats.validated,
        ttl: stats.ttl,
        notModified: stats.notModified,
        inline: stats.inline,
        probe: stats.probe,
        probeFail: stats.probeFail,
        override: stats.override ?? 0,
      },
      recent: stats.recent.slice(-5),
      traffic,
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /**
   * 安卓外壳的「待答选择」长轮询：走我们自己的鉴权，回答完就结束，不落到上游。
   *
   * 语义（对着外壳那一端写死的）：
   *   GET /__remote_access__/notify?rev=<上次的版本号>&wait=<秒>&av=<App版本>&n=<0|1>&ch=<通道重要性>
   *     * rev 与当前不同 → 立刻回当前状态；
   *     * rev 相同 → 挂住最多 wait 秒，状态一变就回（外壳因此不用空转轮询）；
   *     * av / n / ch 是外壳顺带自报的通知环境（App 版本、通知开没开、「模型提问」通道的重要性）：
   *       设置页底部那行自检要显示它，状态文件里也留一份 —— 「发了通知却不弹横幅」发生在手机那端，
   *       宿主本该看不见，这是让它看得见的唯一办法。
   * 没授权（没带票、也没带放行 cookie）一律 401：这里会带上「模型在问什么」，不能白给。
   */
  function handleNotify(req, res) {
    if (req.method !== 'GET') {
      deny(res, 405, '405 method not allowed\n');
      return;
    }
    if (!gate.authorize(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let answered = false;
    const send = () => {
      if (answered) return;
      answered = true;
      try {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(choice.view(cfg)));
      } catch { try { res.destroy(); } catch { /* 已经断了 */ } }
    };

    let wait = 0;
    let since = NaN;
    try {
      const url = new URL(String(req.url), 'http://127.0.0.1');
      wait = Math.min(30, Math.max(0, Math.floor(Number(url.searchParams.get('wait')) || 0)));
      since = Number(url.searchParams.get('rev'));
      // 只有外壳会带 av；设置页那次探测（浏览器里 fetch 的）不带，别用它把记录清空
      const app = url.searchParams.get('av') ?? '';
      if (app) {
        const changed = choice.reportPhone({
          app,
          notifications: url.searchParams.get('n') !== '0',
          importance: Number(url.searchParams.get('ch') ?? '0') || 0,
          // 「任务结束」是单独一条通道：它被调低时横幅同样弹不出来，所以分开自报（老 APK 不带这个参数）
          importanceFinish: Number(url.searchParams.get('fch') ?? '0') || 0,
        });
        if (changed) {
          const seen = choice.phone();
          const ok = seen.notifications && seen.importance >= 4;
          const okFinish = seen.notifications && (seen.importanceFinish ?? 0) >= 4;
          note(
            'info',
            `外壳自报：App ${seen.app}，通知${seen.notifications ? '已开' : '未开'}，` +
              `「模型提问」通道重要性=${seen.importance}${ok ? '' : '（这个状态下横幅弹不出来：见 README 的厂商那一节）'}` +
              `，「任务结束」通道重要性=${seen.importanceFinish ?? 0}${okFinish ? '' : '（同上）'}`,
          );
        }
      }
    } catch { /* URL 坏了就当普通请求，立刻回一份当前状态 */ }

    if (wait <= 0 || !Number.isFinite(since) || since !== choice.rev()) {
      send();
      return;
    }
    const timer = setTimeout(send, wait * 1000);
    timer.unref?.();
    const stop = choice.subscribe(() => {
      clearTimeout(timer);
      stop();
      send();
    });
    req.on('close', () => {
      clearTimeout(timer);
      stop();
      answered = true; // 对端走了，别再往这条连接里写
    });
  }

  const server = http.createServer((req, res) => {
    // 边界护栏：这个回调里的任何同步异常都会变成 uncaughtException 并**带走整个 DSH 宿主**
    // （线上真发生过一次：下游已销毁时 pipeline 同步抛 ERR_STREAM_UNABLE_TO_PIPE）。
    // 代理是网络边缘，输入全是不可信的，所以这里必须什么都不许漏出去。
    try {
      handleRequest(req, res);
    } catch (err) {
      note('error', `处理请求时抛出异常（已兜住，宿主不受影响）: ${err?.stack ?? err}`);
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('500 internal proxy error\n');
      } catch { /* 下游已经断了 */ }
    }
  });

  function handleRequest(req, res) {
    const peer = bareIp(req.socket.remoteAddress);
    if (!peerAllowed(peer, cfg) || gate.banned(peer)) {
      note('debug', `拒绝 ${peer} → 403（不在允许网段、命中黑名单，或在拉黑名单里）`);
      deny(res, 403, '403 forbidden: peer not allowed\n');
      return;
    }

    // 待答选择端点：由我们自己回答（带了鉴权），不问上游 —— 上游不知道这个协议
    if (choice && String(req.url).split('?')[0] === NOTIFY_PATH) {
      handleNotify(req, res);
      return;
    }

    // 手机端缓存策略的自检：设置页「缓存」子菜单展开时才来读它
    if (String(req.url).split('?')[0] === CACHE_PATH) {
      handleCache(req, res);
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
        const blocked = () => deny(res, 403, '403 forbidden: wrong code, this address is now blocked\n');
        // 拉黑会尝试写进「排除的网段」，所以等它落盘再回执（失败原因由 ban 自己写进状态文件）
        gate.ban(peer).then(blocked, blocked);
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
      // 这个属性必须**显式**写出来，哪怕是 0：
      // Node ≥19 的 http.globalAgent 自带 `{ keepAlive: true, timeout: 5000 }`，
      // 不传 options.timeout 就会继承那个 5 秒的 socket 空闲超时 —— 上游只要 5 秒没吐字节，
      // 正在传输的响应就被下面的 upReq.destroy() 掐断（大文件、视频、流式帧最先中招），
      // 而日志里打印的是 cfg.timeoutMs（0），看起来像是「没设超时却超时了」。
      timeout: cfg.timeoutMs > 0 ? cfg.timeoutMs : 0,
    };

    const failUpstream = (err) => {
      note('debug', `上游请求失败: ${err?.message}`);
      // 响应头已经发出去时 writeHead 会抛错（以前被吞掉），而 res 既不 end 也不 destroy，
      // 手机端就一直挂着等 —— 这里明确收尾：要么回 502，要么把这条残缺响应掐掉让浏览器自己重试。
      if (res.headersSent) {
        try { res.destroy(); } catch { /* 已经断了 */ }
        return;
      }
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('502 bad gateway: upstream unreachable\n');
      } catch { /* 已经断了 */ }
    };

    // 只有幂等方法才敢「带票重放」（重放时请求体已经流走了）
    const canRepair = authorized && /^(GET|HEAD)$/i.test(String(req.method));
    let repaired = false;

    // ---------------------------------------------------------------- 这一笔的流量账
    //
    // 键只到路径（丢掉查询串）：组合包的路径都是 `/plugins/`，正好把它们合成一笔 ——
    // 「十几 MB 到底花在哪儿」看的就是这一行。入向字节按请求体累加（上传/JSON RPC 也有量）。
    const trafficKey = `${String(req.method).toUpperCase()} ${String(req.url).split('?')[0]}`;
    let bytesIn = 0;
    let bytesOut = 0;
    let trafficDone = false;
    let skipReason = '';
    const countIn = (chunk) => { bytesIn += chunk?.length ?? 0; };
    const finishTraffic = (cached) => {
      if (trafficDone) return;
      trafficDone = true;
      noteTraffic(trafficStats, trafficKey, bytesIn, bytesOut, cached !== false, skipReason);
    };

    /**
     * 上游的响应到了。**故意写成 async**：手机端缓存要在这条路上「先核对、再决定发不发」，
     * 而核对要先读完上游的响应头，有时还要读几 KB 片段。
     * 所有异常都由外面那个 onUpstream 兜住 —— 这条路径绝不能把异常放出请求回调。
     */
    const handleUpstream = async (upRes) => {
      // 响应头到了：从现在起不再按「空闲」掐这条连接（timeoutMs 的语义就是「等响应头」）。
      // 否则显式设了 30s 超时的用户，照样会在下大文件 / 看长流的时候被中途掐断。
      try { upRes.socket?.setTimeout?.(0); } catch { /* 没有 socket 就算了 */ }

      /**
       * 下游已经不能写了（手机切后台、关标签、abort、切网）时就走到这里。
       *
       * 为什么必须专门判一次：`stream.pipeline` / `pipe` 在目标是**已销毁**的流时不是发 error，
       * 而是**同步抛** `ERR_STREAM_UNABLE_TO_PIPE`。这里是在 HTTP 请求回调里，同步抛出去就是
       * uncaughtException —— 线上实测直接把 DSH 的宿主进程带崩（外壳报 host exited with 1 并重启）。
       * 代理再怎么写错，也不该有能力崩掉宿主，所以这条路径只「把上游读干丢掉」。
       */
      const dropUpstream = (why, scope = 'downstream') => {
        // 两种来路要分得清：下游没了（手机切后台/关标签）是常态；缓存判定完成（回 304）是我们主动不要这份正文
        note('debug', `${scope === 'cache' ? '缓存判定完成' : '下游已断开'}，丢弃这次上游响应（${why}）`);
        try { upRes.destroy(); } catch { /* 已经断了 */ }
      };
      if (res.destroyed || res.writableEnded) {
        dropUpstream('res 已销毁');
        return;
      }

      // 上游说没票，可我们明明判过已授权 → 多半是浏览器那张 DSH cookie 失效了（每次重启 DSH 都换）。
      // 用本实例当前的票再试一次：DSH 会 303 + 发一张新 cookie，用户不用手动清 cookie、换网址。
      if (upRes.statusCode === 401 && canRepair && !repaired) {
        repaired = true;
        upRes.resume(); // 丢掉这次的 401 响应
        note('info', `${peer} 的 DSH cookie 已失效 → 带本实例当前的票自动重试一次`);
        const retry = upstreamClientOf(up).request(
          { ...options, path: gate.withTicket(req.url, req.headers.cookie, true), ...tlsOptionsOf(up) },
          onUpstream,
        );
        retry.on('error', failUpstream);
        retry.end();
        return;
      }

      // 补过票还是 401，而且这是个「地址栏导航」→ 说明这个人真的进不来。
      // 别把 DSH 那句英文（dsh web authentication required; …）甩给他：换我们自己的说明页。
      if (upRes.statusCode === 401 && req.method === 'GET' && isNavigation(req)) {
        upRes.resume();
        respondUnauthorizedNavigation(res, req, gate, peer, note);
        return;
      }

      /**
       * 「整段 Range」当整份：媒体元素取大文件时发 `Range: bytes=0-`，上游回 206 带上整份字节。
       * 206 **永远不会被浏览器缓存**，于是每次进页面都重下整段（实测壁纸音轨 3.8 MB × 2）。
       * 这里只在「请求就是从 0 取到结尾」且「上游回的确实覆盖 0..total-1」时才把状态改写成 200 ——
       * 字节与一份普通 200 完全相同，所以只是把「可缓存」这件事还回来。
       * 默认关（cacheFullRange）；个别播放器可能因此失去拖动定位。
       */
      let statusOverride = 0;
      let headers = upRes.headers;
      let rangedAsFull = false;
      if (cfg.cacheFullRange === true && upRes.statusCode === 206 && req.headers.range !== undefined) {
        const askedWhole = /^bytes=0-\s*$/i.test(String(req.headers.range).trim());
        const covered = /^bytes\s+0-(\d+)\/(\d+)\s*$/i.exec(String(upRes.headers['content-range'] ?? '').trim());
        if (askedWhole && covered && Number(covered[1]) + 1 === Number(covered[2])) {
          rangedAsFull = true;
          statusOverride = 200;
          headers = { ...upRes.headers };
          delete headers['content-range'];
          if (!headers['content-length']) headers['content-length'] = covered[2];
          note('debug', `整段 Range 当整份处理（${covered[2]} 字节）: ${String(req.url).slice(0, 100)}`);
        }
      }
      const statusOf = () => statusOverride || upRes.statusCode || 502;

      /** 写响应头 + 转发正文：所有分支的收尾都走这里，语义与以前逐字一致 */
      const passThrough = (extraHeaders, cached) => {
        try {
          res.writeHead(statusOf(), extraHeaders);
        } catch (err) {
          dropUpstream(`写响应头失败: ${err?.message}`);
          return;
        }
        // 用 pipeline 而不是 pipe：上游半路断掉时它会**同时收掉下游**。
        // 只 pipe 的话，上游 socket 被 destroy 只会让 upRes 发个 error，而 res 既不 end 也不 destroy，
        // 手机端就一直挂在那个残缺响应上等（这正是「壁纸卡着不动」的一种收尾形态）。
        // 它同样可能同步抛，所以外面再兜一层 try/catch —— 这条路径绝不能把异常放出请求回调。
        try {
          pipeline(upRes, res, (err) => {
            finishTraffic(cached);
            if (!err) return;
            note('debug', `转发中断（下游一起收掉，别让手机挂着）: ${err?.message}`);
          });
          // 记账监听挂在 pipe 之后：先挂 data 会让流提前进入 flowing 模式，首块有丢的风险
          upRes.on('data', (chunk) => { bytesOut += chunk?.length ?? 0; });
          upRes.on('end', () => finishTraffic(cached));
          upRes.on('close', () => finishTraffic(cached));
        } catch (err) {
          finishTraffic(cached);
          dropUpstream(`无法建立转发: ${err?.message}`);
        }
      };

      // ---------------------------------------------------------------- 手机端缓存
      //
      // 缓存头只在「上游没给任何缓存口径」时补；带 Range 的请求一般不碰
      // （那是 `<video>` 在拖进度，206 不该被当成一份完整副本留在缓存里）——
      // 唯一的例外是上面把「从 0 到结尾」改写成整份 200 的那一种，那时它确实就是一份完整的。
      const noRange = req.headers.range === undefined || rangedAsFull;
      let plan = null;
      try {
        if (noRange) {
          plan = cachePlanOf({ url: req.url, status: statusOf(), method: req.method, headers, cfg });
        }
      } catch { plan = null; }

      // override 模式下先卡大小：小于 64 KB 的（例如每秒来一次的实时小端点）不碰。
      // 长度已知时当场判；长度未知时留给探针判（见下面 fingerprint 分支）。
      if (plan && plan.mode === 'override' && Number.isFinite(plan.size) && plan.size < CACHE_BINARY_MIN_BYTES) {
        plan = null;
      }

      try {
        if (plan && (plan.mode === 'fingerprint' || plan.mode === 'override') && plan.size <= CACHE_INLINE_MAX_BYTES) {
          // 小资源：缓冲整份算精确校验器（顺手就能把条件请求答掉）
          const whole = await readWhole(upRes, CACHE_INLINE_MAX_BYTES);
          if (res.destroyed || res.writableEnded) {
            dropUpstream('res 已销毁（缓冲小资源时）');
            return;
          }
          if (whole.ok) {
            const etag = inlineEtagOf(whole.body.length, headers['content-type'], whole.body);
            if (cacheStats) {
              if (plan.mode === 'override') cacheStats.override += 1;
              else cacheStats.inline += 1;
            }
            noteCacheDecision(cacheStats, req.url, plan.mode === 'override' ? 'override' : 'inline');
            if (etagTokensOf(req.headers['if-none-match']).includes(etag.replace(/^W\//i, ''))) {
              if (cacheStats) cacheStats.notModified += 1;
              sendNotModified(res, plan, etag);
              return;
            }
            try {
              res.writeHead(statusOf(), { ...headers, etag, 'cache-control': ttlHeaderOf(plan) });
              res.end(whole.body);
              bytesOut += whole.body.length;
              finishTraffic(true);
            } catch (err) {
              note('debug', `回缓冲的小资源失败: ${err?.message}`);
              finishTraffic(true);
            }
            return;
          }
          // 上游比声明的还长 / 中途断了：已读到的那段照发，剩下的继续转发（不猜校验器）
          note('debug', '小资源超过缓冲上限，改回普通转发');
          try {
            res.writeHead(statusOf(), { ...headers, 'cache-control': ttlHeaderOf(plan) });
            if (whole.part.length) { res.write(whole.part); bytesOut += whole.part.length; }
          } catch (err) {
            dropUpstream(`写响应头失败: ${err?.message}`);
            finishTraffic(true);
            return;
          }
          try {
            pipeline(upRes, res, () => finishTraffic(true));
            upRes.on('data', (chunk) => { bytesOut += chunk?.length ?? 0; });
            upRes.on('end', () => finishTraffic(true));
            upRes.on('close', () => finishTraffic(true));
          } catch (err) {
            dropUpstream(`无法建立转发: ${err?.message}`);
            finishTraffic(true);
          }
          return;
        }

        if (plan && (plan.mode === 'fingerprint' || plan.mode === 'override')) {
          // 大资源：只取首/尾各 64 KB 做指纹 —— 不整份哈希、不落盘
          const probe = cfg.cacheProbe !== false ? await probeFingerprint(req.url, req.headers.host) : null;
          // override 模式下用探针把「小的实时端点」挡在外面：
          //   · 读完了才知道它小于 64 KB（分块传输没有长度头，这就是唯一可靠判据）；
          //   · 或者长度明确且不足 64 KB。
          const overrideTooSmall = plan.mode === 'override' && probe && probe.ok
            && probe.head.length < CACHE_PROBE_BYTES
            && (probe.complete === true || (Number.isFinite(probe.len) && probe.len < CACHE_BINARY_MIN_BYTES));
          if (overrideTooSmall) {
            note('debug', `no-store 的小响应不缓存（${probe.len} 字节）: ${String(req.url).slice(0, 90)}`);
          } else if (probe && probe.ok) {
            const etag = fingerprintEtagOf(probe);
            if (cacheStats) {
              if (plan.mode === 'override') cacheStats.override += 1;
              else cacheStats.probe += 1;
            }
            noteCacheDecision(cacheStats, req.url, plan.mode === 'override' ? 'override' : 'fingerprint');
            if (etagTokensOf(req.headers['if-none-match']).includes(etag.replace(/^W\//i, ''))) {
              if (cacheStats) cacheStats.notModified += 1;
              note('debug', `手机端缓存仍然有效 → 304（零字节）: ${String(req.url).slice(0, 120)}`);
              dropUpstream('已判定 304，这份正文不用了', 'cache');
              sendNotModified(res, plan, etag);
              finishTraffic(true);
              return;
            }
            headers = { ...headers, etag, 'cache-control': ttlHeaderOf(plan) };
          } else if (plan.mode === 'override') {
            // 探针没成功：override 是逆着上游意愿来的，没有大小证据就不动它（保持上游的 no-store）
            if (cacheStats) cacheStats.probeFail += 1;
          } else {
            // 普通路线：探针失败也至少把新鲜期补上，期内不再重传
            if (cacheStats) cacheStats.probeFail += 1;
            headers = { ...headers, 'cache-control': ttlHeaderOf(plan) };
          }
          if (cacheStats && !overrideTooSmall) cacheStats.ttl += 1;
        } else if (plan && plan.mode === 'immutable') {
          // 内容寻址：URL 里的哈希就是内容身份，一年不用再问
          if (cacheStats) cacheStats.immutable += 1;
          noteCacheDecision(cacheStats, req.url, 'immutable');
          headers = { ...headers, 'cache-control': CACHE_IMMUTABLE };
        } else if (plan && plan.mode === 'validated') {
          // 上游自己有校验器：只补新鲜期，条件请求仍由上游回答
          if (cacheStats) cacheStats.validated += 1;
          noteCacheDecision(cacheStats, req.url, 'validated');
          headers = { ...headers, 'cache-control': ttlHeaderOf(plan) };
        }
      } catch (err) {
        // 缓存这条路怎么错都不该影响转发：退回上游原样
        note('warn', `加缓存头失败（照常转发）: ${err?.message}`);
        headers = upRes.headers;
      }

      // 这一份到底带没带缓存口径：我们补了 / 上游本来就有 max-age → 手机下次可以不问；
      // 两样都没有 → 它下次还得整份重传（记账里那一列就是「还会重传的字节」，并附一句原因）
      const sentCacheControl = String(headers['cache-control'] ?? '');
      const cachedNow = sentCacheControl.includes('max-age') || sentCacheControl.includes('immutable');
      if (!cachedNow) {
        try {
          skipReason = cacheSkipReason({
            url: req.url,
            status: statusOf(),
            method: req.method,
            headers: upRes.headers,
            cfg,
            range: req.headers.range,
          });
        } catch { skipReason = ''; }
      }
      passThrough(headers, cachedNow);
    };

    const onUpstream = (upRes) => {
      handleUpstream(upRes).catch((err) => {
        note('error', `处理上游响应时抛出异常（已兜住）: ${err?.stack ?? err}`);
        finishTraffic(false);
        try { upRes.destroy(); } catch { /* 已经断了 */ }
        if (!res.headersSent) {
          try { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('502 bad gateway\n'); } catch { /* 已经断了 */ }
        } else {
          try { res.destroy(); } catch { /* 已经断了 */ }
        }
      });
    };

    const upReq = upstreamClientOf(up).request({ ...options, ...tlsOptionsOf(up) }, onUpstream);
    upReq.on('timeout', () => {
      // 打真实来源：options.timeout 是本次请求真正生效的那个值（以后不会再有「0ms 却超时」的鬼话）
      note('debug', `等上游响应头超时（${options.timeout || 'agent 默认'}ms）`);
      upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (err) => { finishTraffic(false); failUpstream(err); });
    req.pipe(upReq);
    // 入向字节（上传、JSON RPC 也有量）：监听挂在 pipe 之后，理由与上面一样。
    // ⚠️ **不要**在这里挂 `req.on('end'/'close')` 去结账：GET 的请求体是空的，会**立刻** end，
    // 于是账在正文还没发出去时就结掉了（字节数全是 0）。结账只由响应那一侧负责。
    req.on('data', countIn);
  }

  server.on('connection', (socket) => {
    if (cfg.maxConnections > 0 && active >= cfg.maxConnections) {
      note('debug', `连接数超过上限 ${cfg.maxConnections}，丢弃新连接`);
      socket.destroy();
      return;
    }
    active += 1;
    socket.on('close', () => { active -= 1; });
  });

  // WebSocket / 事件流透传（DSH 界面靠它推送）。升级请求走 DSH cookie，不补票（补票会被 303 打断）；
  // cookie 失效时先靠上面那次「401 → 带票重试」把 cookie 换新（页面导航会走到），WS 自己不做重试。
  server.on('upgrade', (req, socket, head) => {
    // 与 handleRequest 同样的护栏：这里的同步异常一样会变成 uncaughtException 带走宿主。
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      note('error', `处理 WebSocket 升级时抛出异常（已兜住）: ${err?.stack ?? err}`);
      try { socket.destroy(); } catch { /* 已经断了 */ }
    }
  });

  function handleUpgrade(req, socket, head) {
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
    // 0.2.1 起 Web 可能直接开 HTTPS；WebSocket 也必须跟着走 TLS，
    // 否则浏览器升级请求会被明文写进 TLS 端口，连 101 都拿不到。
    const connectUpstream = (cb) =>
      up.protocol === 'https:'
        ? tls.connect({ host: up.host, port: up.port, ...tlsOptionsOf(up) }, cb)
        : net.connect(up.port, up.host, cb);
    const upstream = connectUpstream(() => {
      // 这个回调在握手完成后才跑，已经不在 handleUpgrade 的 try/catch 里了；
      // 写一个已经断掉的 socket 在 Node 24 上是同步抛 —— 一抛就是 uncaughtException 带走宿主。
      try {
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
      } catch (err) {
        note('error', `WebSocket 上游握手时抛出异常（已兜住）: ${err?.stack ?? err}`);
        try { upstream.destroy(); } catch { /* 已经断了 */ }
        try { socket.destroy(); } catch { /* 已经断了 */ }
        return;
      }
      // WebSocket 也要记账，而且**按通道分开**：重进页面时会话状态与聊天图片是从这里推下来的，
      // HTTP 缓存一条都帮不上忙 —— 「退出重进还是大流量」的答案经常就在这几行。
      if (trafficStats) {
        const wsKey = `WS ${String(req.url).split('?')[0]}`;
        let wsIn = 0;
        let wsOut = 0;
        let wsFlushed = false;
        socket.on('data', (chunk) => { const n = chunk?.length ?? 0; wsIn += n; trafficStats.wsIn += n; });
        upstream.on('data', (chunk) => { const n = chunk?.length ?? 0; wsOut += n; trafficStats.wsOut += n; });
        const flushWs = () => {
          if (wsFlushed) return;
          wsFlushed = true;
          noteTraffic(trafficStats, wsKey, wsIn, wsOut, true);
        };
        socket.on('close', flushWs);
        upstream.on('close', flushWs);
      }
    });
    upstream.on('error', (err) => {
      note('debug', `WebSocket 上游失败: ${err?.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  }

  server.on('error', (err) => note('error', `监听 ${addr} 失败: ${err?.message}`));
  server.listen({ host: addr, port: cfg.port }, () => {
    const actual = server.address();
    const port = actual && typeof actual === 'object' ? actual.port : cfg.port;
    note('info', `已在 ${addr}:${port} 监听`);
    onListening(addr, port);
  });
  return server;
}

/**
 * 「页面导航被 DSH 拒了（401）」时的收尾。
 *
 * 分两种情况，都不降低鉴权：
 *   * 设了解锁密码 → 回解锁页（凭据过期就重新输一次；密码错一次仍然拉黑）；
 *   * 没设密码 → 回我们自己的中文说明页，讲清「票是旧的 / 根本没带票」和去哪儿拿当前那张。
 *
 * 只接管「地址栏导航」：子资源与 RPC 的 401 保持原样（前端按 JSON/文本自己处理），
 * 免得把机器可读的错误语义换成一张 HTML。
 */
function respondUnauthorizedNavigation(res, req, gate, peer, note) {
  const hadToken = /(?:[?&])token=/.test(String(req.url ?? ''));
  if (gate.accessCode) {
    note('info', `${peer} 的凭据已被 DSH 拒绝 → 回到解锁页重新输密码`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(unlockPageHtml('上次的登录凭据已失效，请重新输入访问密码'));
    return;
  }
  note(
    'info',
    `${peer} 没有可用凭据（${hadToken ? '带的是已作废的票' : '完全没带票'}）→ 回了中文说明页（不再暴露 DSH 那句英文）`,
  );
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    noCredentialPageHtml({ hadToken, hasAccessCode: false, statusPath: gate.statusPath }),
  );
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
    const tokenized = fn.call(conn, `${up.protocol ?? 'http:'}//${up.host}:${up.port}`);
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

/**
 * 上游是 https 时，只有**本机回环**才接受 DSH 的自签证书（没有中间人空间）。
 * 显式配成远端 https 的，仍按 Node 默认校验证书 —— 不能因为一个自签兜底就把远端 TLS 也关掉。
 */
function tlsOptionsOf(up) {
  if (up?.protocol !== 'https:') return {};
  const host = String(up.host ?? '').toLowerCase();
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  return loopback ? { rejectUnauthorized: false } : {};
}

/** 按上游协议选 http / https 客户端（0.2.1 起 Web 可以自己开 HTTPS） */
function upstreamClientOf(up) {
  return up?.protocol === 'https:' ? https : http;
}

/** 单次探测上游是否可达（任何 HTTP 状态码都算可达） */
function probeOnce(up) {
  return new Promise((resolve) => {
    const client = up.protocol === 'https:' ? https : http;
    const req = client.get(
      { host: up.host, port: up.port, path: '/', timeout: 2500, ...tlsOptionsOf(up) },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
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
  let bansCheckedAt = 0;
  /** 待答选择 + 电脑窗口可见性：安卓外壳靠它决定要不要弹状态栏通知 */
  const choice = createChoiceCenter();
  /** 手机端缓存的计数（只进状态文件与设置页自检；宿主不缓存任何正文） */
  const cacheStats = createCacheStats();
  /** 流量账：按 URL 记字节，用来回答「大流量到底花在哪儿」（只进内存，不落盘） */
  const trafficStats = createTrafficStats();

  function render() {
    return [
      '# dsh-plugin-remote-access 状态（本文件含访问令牌，等于本机操作权限，别外传）',
      `# 更新时间: ${new Date().toISOString()}`,
      '',
      urls.length ? `远程访问网址: ${urls.join('  ')}` : '远程访问网址: （尚未生成）',
      cfg.accessCode && urls.length ? `手机访问: ${urls[0].split('?')[0]} —— 直接打开，输一次访问密码即可` : '',
      `解锁密码: ${cfg.accessCode ? '已设置（网段内一次不过即拉黑）' : '未设置（必须用带票网址访问）'}`,
      `已拉黑: ${[...new Set([...bannedHostsOf(cfg.denyCidrs), ...readPendingBans()])].join(', ') || '(无)'}` +
        '（在「设置 → 远程访问 → 排除的网段」里删掉对应项即可解封）',
      `拉黑暂存: ${
        readPendingBans().length
          ? `${readPendingBans().join(', ')}（写盘失败才暂存，位置 ${banPathOf(cfg)}）`
          : '(无)'
      }`,
      `放行密钥: ${secretPathOf(cfg)}（改密码不会踢人；想让所有设备重新输密码就删掉它）`,
      `手机端缓存: ${(() => {
        if (cfg.cacheEnabled === false) return '已关闭（cacheEnabled=false）';
        return (
          `内容寻址 immutable · 无校验器 ${cfg.cacheTtlMinutes} 分钟（SWR ${CACHE_SWR_SECONDS / 3600} 小时）· ` +
          `指纹探针${cfg.cacheProbe === false ? '关' : '开'} · 正文一律不落宿主盘`
        );
      })()}`,
      `缓存计数: immutable ${cacheStats.immutable} · 有校验器 ${cacheStats.validated} · ` +
        `无校验器 ${cacheStats.ttl}（小资源缓冲 ${cacheStats.inline}，探针 ${cacheStats.probe}，探针失败 ${cacheStats.probeFail}）· ` +
        `回给手机的 304 ${cacheStats.notModified} 次`,
      // 流量账：排查「退出重进还是大流量」就看这几行 —— 谁在重传、重传了多少字节
      ...(() => {
        const t = trafficView(trafficStats, 5);
        const lines = [
          `流量账（自 ${new Date(t.since).toISOString()}）: 送出 ${humanBytes(t.totalOut)}` +
            `（其中没有缓存口径的 ${humanBytes(t.uncachedOut)}）· 收到 ${humanBytes(t.totalIn)}` +
            ` · WebSocket 送 ${humanBytes(t.wsOut)} / 收 ${humanBytes(t.wsIn)}`,
        ];
        for (const row of t.top) {
          lines.push(
            `  送出 ${humanBytes(row.out)}（${row.hits} 次${row.cached === row.hits ? '，都带缓存口径' : `，其中 ${row.hits - row.cached} 次没带`}）  ${row.key}` +
              `${row.reason ? ` —— ${row.reason}` : ''}`,
          );
        }
        if (t.top.length === 0) lines.push('  （还没有流量记录）');
        return lines;
      })(),
      `待答选择: ${
        cfg.notifyOnChoice
          ? `${choice.pendingCount()} 条（安卓 App 在后台时会收到状态栏通知）`
          : '通知已关闭（notifyOnChoice=false）'
      }`,
      `一轮结束: ${(() => {
        const last = choice.finish();
        const flag = cfg.notifyOnFinish ? '会通知手机' : '通知已关闭（notifyOnFinish=false）';
        if (!last) return `还没有结束过（${flag}）`;
        const when = new Date(last.at).toISOString();
        return last.ok
          ? `最近一次：正常跑完（${Math.max(1, Math.round((last.ms || 0) / 1000))} 秒，${when}）· ${flag}`
          : `最近一次：异常结束 —— ${last.reason}：${last.message}（${when}）· ${flag}`;
      })()}`,
      `电脑窗口: ${(() => {
        const d = choice.desktopView();
        if (!d.known) return '未知（本机页面没回报过 → 手机端一律按不可见处理）';
        return `${d.visible ? '可见' : '不可见'}（${new Date(d.at).toISOString()} 回报）`;
      })()}`,
      `手机端: ${(() => {
        const p = choice.phone();
        if (!p) return '还没自报过（外壳每次轮询都会带一份）';
        const banner = p.notifications && p.importance >= 4;
        return (
          `App ${p.app}，通知${p.notifications ? '已开' : '未开'}，横幅通道重要性=${p.importance}` +
          `${banner ? '' : '（横幅弹不出来）'}（${new Date(p.at).toISOString()} 自报）`
        );
      })()}`,
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
  // 写进配置的密码如果没通过校验，**必须**看得见：静默失效会让人以为「设过了」，
  // 然后在手机上撞见 DSH 那句英文 401（以前就是这么坑的）。这里只说长度/字符要求，不回显密码本身。
  {
    const rawCode = String(unwrap(config?.accessCode) ?? '').trim();
    if (rawCode && !cfg.accessCode) {
      note(
        'warn',
        '「访问密码」没生效：只接受 4–12 位数字或字母，当前写的值里有不接受的字符。' +
          '到「设置 → 远程访问 → 访问密码」改掉它，或清空并改用带票网址。',
      );
    }
  }
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

  // ---------------------------------------------------------------- 待答选择与窗口可见性
  // 这一对是给安卓 App 的状态栏通知用的，两个来源都在宿主：
  //   * 模型提问 —— user-questions/request 是 host 侧的瀑布事件，我们挂一个「只观察不抢答」的监听：
  //     永远把 next() 交下去（真正回答的是官方那条 Web 回答者或回环上的客户端），只在它左右记一笔；
  //   * 电脑窗口可见吗 —— 本机页面的 client.js 往 PRESENCE_PATH POST 自己的 document.visibilityState。
  //     为什么必须由页面自己报：窗口收进托盘 / 最小化只有渲染进程知道，宿主看不到 Electron 的窗口状态。

  try {
    if (typeof ctx?.on === 'function') {
      // prepend 是必须的，不是「顺手」：这是条瀑布事件，官方那条转发监听（dsh-api-remotes）会把请求
      // 交给浏览器端持有 —— 有客户端接住时它**不会**调 next()，排在它后面的监听根本轮不到执行。
      // 而「手机在后台看着、没人回答」恰恰是我们要通知的场景，所以必须挂在最外层：
      // 每次都先经我们记一笔，再把 next() 原样交下去（我们不抢答、不改结果）。
      ctx.on('user-questions/request', (request, next) => {
        let clear = () => {};
        try {
          clear = choice.track(request);
          const waiting = choice.pendingCount();
          if (cfg.notifyOnChoice && waiting > 0) {
            note(
              'info',
              `模型发出选择（${waiting} 条待答）：${notifyText(request?.questions?.[0]?.question, 80)}`,
            );
          }
        } catch { clear = () => {}; }
        let done;
        try {
          done = Promise.resolve(typeof next === 'function' ? next() : undefined);
        } catch (err) {
          clear();
          throw err;
        }
        // 不管回答、超时还是被取消，都要把这条待答撤下来 —— 否则手机会一直响着一条已经没人等的问题
        done.then(clear, clear);
        return done;
      }, { prepend: true });
      note('debug', '已挂上 user-questions/request（最外层）：模型提问时记一条待答选择');
    } else {
      note('debug', '这个上下文没有 ctx.on，模型提问不会记成待答选择（手机端也就收不到通知）');
    }
  } catch (err) {
    note('warn', `挂「待答选择」监听失败: ${err?.message}`);
  }

  // ---------------------------------------------------------------- 一轮结束的通知（正常 / 异常）
  //
  // 事件来自 DSH 自己，不是我们猜的：
  //   · `agent/status`  payload `{ agent, status }` —— running ↔ idle；running→idle 就是「这一轮跑完了」。
  //     主 agent 与子 agent 都会发，用 `agent.id === agent.session.id` 只认主 agent（子 agent 结束不打扰你）。
  //   · `agent/error`   payload `{ agent, turn, step, error }` —— 异常结束，一次拿到错误对象，
  //     按 DSH 自己的错误码分类（见 describeAgentError）。
  //
  // 为什么要防抖：循环里 `running → maintenance` 也会被映射成 idle（maintenance 期间的 status 也是 idle），
  // 所以不能一收到 idle 就报「跑完了」。真结束会一直是 idle；中间抖一下的，紧接着的 running 会把它取消。
  const FINISH_DEBOUNCE_MS = 2000;
  let finishTimer = null;
  let runStartedAt = 0;
  let runError = null;
  /**
   * 这一轮有没有真的 `running` 过。
   *
   * 为什么必须有它：`agent/status` 不保证「running → idle」只出现一次 —— 中间态（维护 / 压缩、
   * 以及紧接着又跑一轮）都可能再发一次 idle；只防计时器的话，**一次消息会报两次「结束」**，
   * 手机上就是「一条消息弹两回」。现在的规矩很硬：**一次 running 只兑现一次结束**，
   * 没有 running 过的 idle 一律忽略。
   */
  let runActive = false;

  /** 只认主 agent：子 agent 有自己的 id，不拿 session.id 当 id */
  function isMainAgent(agent) {
    try {
      return Boolean(agent && agent.session && agent.id === agent.session.id);
    } catch {
      return false;
    }
  }

  function publishFinish() {
    const ms = runStartedAt > 0 ? Date.now() - runStartedAt : 0;
    const error = runError;
    runStartedAt = 0;
    runError = null;
    runActive = false;
    const record = error
      ? choice.reportFinish({ ok: false, reason: error.reason, message: error.detail, ms })
      : choice.reportFinish({ ok: true, ms });
    if (cfg.notifyOnFinish) {
      note(
        'info',
        error
          ? `一轮异常结束（${error.reason}）：${error.detail} → 已让手机端提醒`
          : `一轮正常结束（用时 ${Math.max(1, Math.round(ms / 1000))} 秒）→ 已让手机端提醒`,
      );
    }
    return record;
  }

  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('agent/status', (payload) => {
        try {
          const agent = payload?.agent;
          if (!isMainAgent(agent)) return;
          const status = String(payload?.status ?? '');
          if (status === 'running') {
            // 新的一轮开始：清掉上一轮的残留，并取消还没落地的「结束」
            runStartedAt = Date.now();
            runActive = true;
            runError = null;
            if (finishTimer) {
              clearTimeout(finishTimer);
              finishTimer = null;
            }
            return;
          }
          if (status !== 'idle') return;
          if (!runActive) return; // 没有 running 过的 idle：中间态，不是「跑完了」
          if (finishTimer) clearTimeout(finishTimer);
          finishTimer = setTimeout(() => {
            finishTimer = null;
            if (!runActive) return; // 这两秒里又跑起来了 → 这一条不算结束
            try { publishFinish(); } catch (err) { note('warn', `报「一轮结束」失败: ${err?.message}`); }
          }, FINISH_DEBOUNCE_MS);
          finishTimer.unref?.();
        } catch (err) {
          note('warn', `处理 agent/status 失败（不影响运行）: ${err?.message}`);
        }
      });
      // 只记第一个错误：后面的多半是它的连锁反应（重试、收尾），报一串只会更糊涂
      ctx.on('agent/error', (payload) => {
        try {
          const agent = payload?.agent;
          if (!isMainAgent(agent)) return;
          if (!runError) runError = describeAgentError(payload?.error);
        } catch (err) {
          note('warn', `处理 agent/error 失败（不影响运行）: ${err?.message}`);
        }
      });
      note('debug', '已挂上 agent/status 与 agent/error：一轮结束（正常 / 异常）时通知手机');
    } else {
      note('debug', '这个上下文没有 ctx.on，一轮结束不会通知手机');
    }
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        if (finishTimer) {
          clearTimeout(finishTimer);
          finishTimer = null;
        }
      });
    }
  } catch (err) {
    note('warn', `挂「一轮结束」监听失败: ${err?.message}`);
  }

  /**
   * 本机页面回报窗口可见性的路由。
   *
   * 为什么走上游 webServer 而不是本插件自己的代理：只有本机那一页能直接打到 webServer（回环），
   * 而它是唯一知道窗口可见性的页面；手机那一端要的数据则在下一条路上（NOTIFY_PATH）。
   * 为什么要求 application/json：跨站表单只能发 text/plain 之类，发不出 JSON；
   * 要求 JSON 就等于要求一次 CORS 预检 —— 而我们不答预检，网页里的一次跨站 POST 因此打不进来。
   */
  function handlePresence(req, res) {
    const done = (code, text) => {
      try {
        res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text ?? '');
      } catch { try { res.destroy(); } catch { /* 已经断了 */ } }
    };
    if (req.method !== 'POST') {
      done(405, '405 method not allowed\n');
      return;
    }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      done(415, '415 unsupported media type: send application/json\n');
      return;
    }
    readSmallBody(req, 1024).then((body) => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        done(400, '400 bad request: body is not JSON\n');
        return;
      }
      if (!parsed || typeof parsed.visible !== 'boolean') {
        done(400, '400 bad request: expected {"visible": true|false}\n');
        return;
      }
      choice.reportDesktop(parsed.visible);
      note('debug', `本机页面回报窗口可见性: ${parsed.visible ? '可见' : '不可见'}`);
      done(204, '');
    }).catch(() => done(400, '400 bad request\n'));
  }

  try {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: PRESENCE_PATH,
        handler: (req, res) => {
          // 与代理同一条纪律：这里的同步异常一样会变成 uncaughtException 带走宿主
          try {
            handlePresence(req, res);
          } catch (err) {
            note('error', `处理窗口可见性回报时抛出异常（已兜住）: ${err?.message}`);
            try { res.destroy(); } catch { /* 已经断了 */ }
          }
        },
      }), 'remote-access: 窗口可见性回报');
      note('debug', `已注册 ${PRESENCE_PATH}：本机页面用它回报窗口可见性`);
    } else {
      note(
        'debug',
        '拿不到 webServer，本机页面没法回报窗口可见性 —— 手机端一律按「窗口不可见」处理（照常通知）',
      );
    }
  } catch (err) {
    note('warn', `注册窗口可见性路由失败: ${err?.message}`);
  }

  // ---------------------------------------------------------------- 拉黑
  // 一次密码输错就把该地址写进「排除的网段」(denyCidrs) —— 于是在设置页里能直接看到、删掉即解封。
  // 写盘必须走 configEditor.edit（Host 网关那条路），而它跑在 HMR 事务里：从监听的请求回调里直接调
  // 会撞 "HMR transactions cannot be nested"，所以统一放进 runOutsideHmr 的异步作用域。
  // 万一写不进去：地址**立刻**就被拦（内存里），并暂存到 banFile，随后定时/重载/重启时继续补写。

  let pendingRetryTimer = null;

  function readPendingBans() {
    try {
      return fs
        .readFileSync(banPathOf(cfg), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    } catch {
      return [];
    }
  }

  /** 暂存文件只记「还没写进配置」的地址；空了就删掉，免得留下误导 */
  function writePendingBans(list) {
    const file = banPathOf(cfg);
    const unique = [...new Set(list)];
    try {
      if (unique.length === 0) {
        fs.rmSync(file, { force: true });
      } else {
        const head =
          '# dsh-plugin-remote-access 拉黑暂存：这些地址还没写进「排除的网段」，会自动补写；\n' +
          '# 正常情况下不用碰这个文件 —— 拉黑请在「设置 → 远程访问 → 排除的网段」里管理。\n';
        fs.writeFileSync(file, `${head}${unique.join('\n')}\n`, { mode: 0o600 });
      }
      bansCheckedAt = 0;
    } catch { /* 写不进去也不影响内存里的拉黑 */ }
  }

  /**
   * 拉黑来源两处：配置里的单主机 denyCidrs（权威）+ 暂存文件（还没写进配置的）。
   * force=true 才按配置**重建**（设置页删掉某项 → 热重载 → 到这儿生效）；
   * 平时只做增量补齐 —— 否则「配置已写成功但重载还没到」的这一瞬间会把刚拉黑的地址放回去。
   */
  function refreshBans(force) {
    const now = Date.now();
    if (!force && now - bansCheckedAt < 1000) return; // 别每个请求都读盘
    bansCheckedAt = now;
    if (force) bans = new Set();
    for (const host of bannedHostsOf(cfg.denyCidrs)) bans.add(host);
    for (const peer of readPendingBans()) bans.add(peer);
  }

  async function ban(peer) {
    refreshBans(false);
    bans.add(peer); // 先拦下来，再谈落盘
    bansCheckedAt = 0;
    const pending = readPendingBans();
    if (!pending.includes(peer)) writePendingBans([...pending, peer]);
    try {
      const cidr = await persistBanToDenyCidrs(ctx.get('configEditor'), peer);
      note('warn', `${peer} 密码错误，已拉黑：写进「排除的网段」(${cidr})，在设置页删掉该项即可解封`);
      writePendingBans(readPendingBans().filter((one) => one !== peer)); // 配置才是权威，暂存里撤掉
    } catch (err) {
      note(
        'error',
        `${peer} 密码错误，已拉黑（暂时只在内存 + ${banPathOf(cfg)}）：写进「排除的网段」失败 —— ${err?.message}`,
      );
      schedulePendingRetry();
    }
  }

  /** 写配置失败时的兜底重试：只碰暂存文件与配置，不阻塞任何请求 */
  function schedulePendingRetry() {
    if (pendingRetryTimer) return;
    pendingRetryTimer = setTimeout(async () => {
      pendingRetryTimer = null;
      if (closed) return;
      let left = readPendingBans();
      for (const peer of left) {
        try {
          await persistBanToDenyCidrs(ctx.get('configEditor'), peer);
          left = left.filter((one) => one !== peer);
        } catch { /* 留到下次 */ }
      }
      writePendingBans(left);
      if (left.length) {
        note('warn', `还有 ${left.length} 个拉黑地址没写进「排除的网段」，稍后继续重试：${left.join(', ')}`);
        schedulePendingRetry();
      }
    }, 5000);
    pendingRetryTimer.unref?.(); // 别拖住进程退出
  }

  // ---------------------------------------------------------------- 访问门
  // accessCode 为空时整扇门是「透明的」：行为与以前完全一致（裸地址交给 DSH 自己 401）。

  const gate = {
    get accessCode() { return cfg.accessCode; },
    get banPath() { return banPathOf(cfg); },
    get statusPath() { return statusPathOf(cfg); },
    get cookieValue() { return cookieValue; },
    banned(peer) {
      refreshBans(false);
      return bans.has(peer);
    },
    ban,
    /**
     * 已授权：带票（**必须是本实例当前那张**）、DSH 自己的 cookie，或我们发过的放行 cookie。
     * 为什么票要校验：每次启动/换实例都会换一张 token，从旧网址或别的实例抄来的票在 DSH 那里
     * 只会换来 401（那句英文提示）。这里判成「没授权」，于是能落到解锁页、或者走 DSH 自己的 401。
     */
    authorize(req) {
      const found = /(?:[?&])token=([^&]*)/.exec(String(req.url ?? ''));
      if (found) {
        try {
          if (decodeURIComponent(found[1]) === ticket) return true;
        } catch { /* 票的编码坏了，就当没票 */ }
      }
      const cookie = String(req.headers.cookie ?? '');
      if (/dsh-auth-/i.test(cookie)) return true;
      return Boolean(cfg.accessCode) && cookie.includes(`${UNLOCK_COOKIE}=${cookieValue}`);
    },
    /** 给已授权但还没有 DSH cookie 的请求补票；force=true 时连「已有 DSH cookie」也照样补
     *  （只在自动修复那条路上用：cookie 失效时得靠票把 DSH 重新认下来） */
    withTicket(url, cookie, force = false) {
      if (!force && /dsh-auth-/i.test(String(cookie ?? ''))) return url;
      if (!ticket) return url;
      const stripped = String(url)
        .replace(/([?&])token=[^&]*&?/i, (_, sep) => (sep === '?' ? '?' : ''))
        .replace(/[?&]$/, '');
      return `${stripped}${stripped.includes('?') ? '&' : '?'}token=${encodeURIComponent(ticket)}`;
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
      note('info', '解锁密码已启用：网段内直接打开裸地址、输一次密码即可（输错一次即写进「排除的网段」）');
    }
    if (bans.size) note('warn', `当前拉黑 ${bans.size} 个地址: ${[...bans].join(', ')}`);
    if (readPendingBans().length) schedulePendingRetry(); // 上次没写进配置的，接着补写

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
          }, gate, choice, cacheStats, trafficStats),
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
    if (pendingRetryTimer) {
      clearTimeout(pendingRetryTimer);
      pendingRetryTimer = null;
    }
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
  // 注意：这里**不再**重复打一遍「apply 开始」与 schema 结论 —— 那两句在上面已经写过一次，
  // 每次加载都在状态文件里留两份只会让人以为插件被加载了两次。

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
