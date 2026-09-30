# 交接文档 —— 给「创造模式」会话

> 先读 `AGENTS.md`（硬约定），再读本文（现状与已查明的 DSH 事实）。
> 第 2 节是**已解决的**老卡点（含根因与判断链），第 3 节是那份查询清单的**答案**，第 4 节是可直接复用的 DSH 内部事实。
> **先查再改，不要猜 API。**

---

## 1. 目标与当前状态

**目标**：让手机 / 其他设备通过 Tailscale（`100.64.0.0/10`）用一条带令牌的网址打开本机 DSH 的网页界面；
参数（网段、监听地址、端口、上游等）必须可配置，且**安全边界不许放松**（只监听允许网段内的本机地址，对端也必须在允许网段内，访问仍需 DSH 令牌）。

**已经能用（Host 半区，`index.js`）** ✅

- 只在 `allowCidrs` 命中的**本机地址**上监听（永不 `0.0.0.0`）；网段外对端 `403`；
- HTTP 与 WebSocket 透传；默认把 `Host`/`Origin` 改写成上游回环地址；
- 用 `ctx.connection.authenticatedUrl()` 铸出**带 token 的网址**，写进状态文件；
- 上游自检重试 8 次 × 2 秒（DSH 界面常比插件晚起）；
- 无论成功失败都写状态文件（自诊断），`ctx.effect` 负责关监听；
- 独立测试 **10/10 通过**：`node tools/test-remote-access.mjs`。

**已经能用（Client 半区，`client.js`）** ✅

- 注册进 **`settings.section`** → 设置左侧导航多一页「远程访问」，页面**能渲染出来**（用户已确认看到）。
- 参数读写走官方通道 `ctx.configForms.get('remote-access')`：`getSnapshot()` 读，
  `mutate([{ op:'set', path:[key], value }], revision)` 一次原子写。

**原卡点已解决** ✅ → 见第 2 节（**待重启 DSH 后实测一次**：换 JS 必须重启）。

---

## 2. 原卡点已解决：设置页保存写不进配置

### 根因（一句话）

Host 的设置文档**只服务「`Config` 是原生 Schemastery schema、且含 `.volatile()` 字段」的条目**；
而本插件原来 `import('@deepseek-ai/cordis')` 取 `Schema`，真包名是 **`@deepseek-ai/schemastery`**
（`cordis` 上并没有这个导出）→ `Schema` 是 undefined → `Config` 导出 undefined
→ `Config.listConfigs` 里这一行 `status: "absent"` → **命名空间从不出现**
→ `configForms.set` 找不到命名空间，**静默返回 false**（第 2 节原来那三条报错都是这个根因的表象）。

### 第二道门：link: 装的插件必须声明 peerDependencies（第一轮修完仍然 absent）

改成 `import('@deepseek-ai/schemastery')` 后重启，`Config.listConfigs` **仍然是 absent**。原因是 DSH 的
模块解析拦截（`installRuntimeInterception`）对「哪些裸名可以借安装目录里的包」有额外条件：

- `linkedProfileRoots()` 把 profile 里 `link:` 的目标目录登记为 **linked root**（本项目就是
  `@local/dsh-remote-access → C:\ProgramData\dsh-plugins\dsh-remote-access`）；
- `findInterceptionLayer()` 因此会命中（`hasInterceptionLayerForUrl` 返回 true，但这**只是必要条件**）；
- 真正决定放行的是 `ResolutionRouter.routeLinked()`：它沿插件的祖先目录找 `node_modules`，
  只有**某个祖先目录的 `package.json` 把该包列在 `peerDependencies` 里**（`readPeerNames`）时，
  才把裸名路由到安装里的那个包；否则退回 `{ kind: 'native' }` —— 原生解析看不到 `app.asar` 里的
  `dsh/node_modules`，于是 `import` 抛 `ERR_MODULE_NOT_FOUND`。

所以 `package.json` 必须写：

```json
"peerDependencies": { "@deepseek-ai/schemastery": "^3.18.1" }
```

peer **不会**被 pnpm 装进 profile（`app.asar` 供包，profile 里仍然没有 `@deepseek-ai` 目录，零依赖不变；
`dshmarket` 也正是这样声明 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 的）。

**实测凭据**（用 DSH 自带运行时跑真解析器，A/B 只差 package.json 里那一条 peer）：

```
A 有 peer（插件真实目录）→ E:\...\app.asar\dsh\node_modules\@deepseek-ai\schemastery
B 无 peer（同一份 index.js）→ (解析不到 → 裸名 import 会失败)
linkedRoots: @local/dsh-remote-access → C:\ProgramData\dsh-plugins\dsh-remote-access
```

复现方式（不需要重启 GUI；`cli.js` 那条路对 desktop profile 会被拒绝，得自己 mount `PluginPackages`）：

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
& "E:\Applications\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals <探针.mjs>
# 探针里：createRuntimeResolution({installAnchor, profile, home}) → new PluginPackages(ctx, {resolution})
#          → pluginPackages.packageOf('@deepseek-ai/schemastery', <插件的 index.js 的 file URL>)
```

### 判断链（都在安装包 `app.asar` 里查到的原文）

| 位置 | 事实 |
|---|---|
| `@deepseek-ai/dsh-app-boot` `isNativeConfigSchema` | 认 `Reflect.get(value, Symbol.for('schemastery')) === true` + `type` 是字符串 + `meta` 是对象；**注意 schema 实例是函数**，判据是「既不是 object 也不是 function 才算不合格」 |
| `@deepseek-ai/dsh-tool-cordis` 的 `liveConfig` | `fiber.runtime.Config` 为 undefined → `status: 'absent'`；不是原生 schema → `'unsupported'`；原生 → `'schema'` |
| `@deepseek-ai/dsh-settings` 的 `describe()` | 条目要同时满足：有原生 schema、`entry.fiber.state === 2`（已激活）、`volatileForm(schema)` 有结果；`ns = entry.options.id` |
| `volatileForm` / `isVolatilePath` | 只收 `meta.volatile === true` 的字段（含最近的 volatile 祖先）；**一个 volatile 字段都没有 → 整条命名空间不出现** |
| `@deepseek-ai/dsh-api-settings-controller` | `settings/mutate` 的 `ops` 元素是 `{ op:'set', path:[字段], value }`（`path` 是**数组**，这就是当初 `gateway/input-invalid: ops` 的原因） |
| `ConfigFormController`（`ctx.configForms.get(ns)`） | `getSnapshot()` → `{ status, value, base, user, revision, writable, mode }`；`subscribe(fn)`；`set(field,value)` = 一条 `{op:'set',path:[field],value}`；`mutate(ops, revision)` → `remote.settings.mutate(ns, ops, revision)` → `Promise<boolean>` |
| DSH 的模块解析 | `installRuntimeInterception` 直接改写 Node 内部的 ESM/CJS 解析器：**安装作用域**的包由它供给 profile 插件。命中拦截只是必要条件——`link:` 装的插件还要在 `package.json` 的 `peerDependencies` 里声明该包（`routeLinked` + `readPeerNames`），否则裸名退回原生解析必然失败 |
| 写入落盘 | `configEditor.edit` 把值写进 profile 的 patch 文档（`cordis.patch.yml` 所在层），再按 Loader 正常路径重挂载 |
| 配置变化是否重挂载 | Cordis `Fiber.update()` 最后是 `this.restart()` —— **一律重新 apply**，所以「保存即生效」；`.volatile()` 只决定「哪些字段进表单」，不是「免重启」的暗示 |

### 修法

- `package.json`：把 `@deepseek-ai/schemastery` 声明为 **peerDependency**（见上，这是能从安装目录借到包的凭据）。
- `index.js`：`import('@deepseek-ai/schemastery')`，`Config` 的字段全部 `.volatile()`
  （它们是纯运行期参数）；纯 node 环境解析不到时仍降级为「无 schema」，插件照常工作——
  并且**把解析结果（成功来源 / 报错原文）写进状态文件的诊断区**，不许再哑巴失败。
- `index.js` 热重载：把「起监听」抽成 `start()`（先 `stopServers()` 再按当前 `cfg` 重开），
  挂 `ctx.on('app-boot/config-reload', reapply)`；`reapply()` 用
  `ctx.get('settings').describe()` 的 `{...base, ...user}` 算出生效配置，有差异才重挂。
- `index.js` 解锁门：`accessCode` 非空时，网段内的页面导航请求先给一张极简解锁页；
  POST 密码正确 → 发一枚随机的 `dsh-ra-ok` cookie（30 天）+ 303 回 `/`；
  **错误一次** → 把该 IP 追加进 `banFile` 并 403。已授权（带票 / DSH cookie / 我们的 cookie）的请求，
  在没有 DSH cookie 时由代理在**服务端**补 `?token=`，所以浏览器地址栏里不出现 token。
  密码为空时整扇门透明，行为与以前一致（裸地址交给 DSH 自己 401）。
- `client.js`：`inject: ['slots', 'configForms']`，只留 6 项（日志级别是下拉框）；
  保存 = 只把**改动过的**字段编成一条原子 `mutate(ops, revision)`。
  页面上只说人话（内部状态、诊断、YAML 兜底都已收掉，细节改往开发者控制台写）；
  保存成功的提示是「已按新参数重挂监听」。
- 回归：`node tools/check-config-schema.mjs` 验**两道门**——peer 声明（含版本范围）+ 用安装包里的真
  Schemastery 验「原生 schema + 全字段 volatile + 表单字段/仅 patch 字段/类型对表」，**不需要重启 DSH**；
  `node tools/test-remote-access.mjs` **25 项**（含解锁页、错一次拉黑、解封、服务端补票、热重载换端口）。

### 为什么不走「Host 半区自己写盘 / host.call」

查证后否掉了：`host.call` 只属于**动态半区**（cordis-client-runner 那种拿到固定 `React`/`console`/`styles`/`host`
符号面的插件），module-loader 形态（`window.__ModuleLoader__.load({id, factory(require)})`）的模块表里没有 `host`
（模块表只有 `react` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` / `ui-slots` / `ui-primitives` / `ui-dockkit`）。
而官方写入通道本来就有：`configForms` → 设置控制器 → `configEditor`，落盘到 profile patch，
比自己维护一个覆盖文件更正确，也不用碰 YAML。

---

## 3. 原查询清单的答案（已查明，不必重查）

1. **Client `ctx.configForms`**：`get(entryId)` 返回共享的 `ConfigFormController`（`entryId` = **Loader 条目的
   `options.id`**，即 patch 里的行 id）；方法 `getSnapshot()` / `subscribe(fn)` / `set(field,value)` /
   `unset(field)` / `mutate(ops, expectedRevision)`；`set`/`unset` 只是 `mutate` 的单条包装。
   `describe()` 返回共享镜像（`getSnapshot` / `subscribe` / `ensure` / `load` / `acceptView`），
   `whileServed(namespaces, register)` 用于「编辑别人拥有的命名空间」——编辑自己的命名空间不必用。
2. **Client `ctx.remote.settings`**：`mutate(ns, ops, expectedRevision)` / `update(ns, patch, expectedRevision)` /
   `replace(ns, section, expectedRevision)` / `describe()`；`ops` 元素 `{ op:'set'|'unset', path:[…], value? }`。
   一般**不要直接调**：走 `configForms` 才有 revision 栅栏与镜像折叠。
3. **槽位 props**：`settings.section` 的 owner props **只有 `close`**（没有 `form`）——所以设置页从来不会自动
   拿到表单，得自己用 `configForms`。
4. **Host `Config.listConfigs`**：`PackageDir` / `status` 已可查；**`status` 必须是 `schema`**，否则设置页写不进去。
5. **Host⇄Client 通道**：module-loader 半区拿不到 `host.call`；本项目不需要它（见第 2 节末）。

---

## 4. 已确认的 DSH 事实（省得重查）

| 事实 | 说明 |
|---|---|
| 槽位注册形状 | 列表槽位：`ctx.slots.register({ name, id, order, label }, Component)`；键控槽位：`{ name, key }`。注册前用 `ctx.slots.inject('<slot>', () => …)` 等槽位出现 |
| `plugins.item` | **官方插件卡片账本**（被官方设置页占用），第三方包注册了也不显示 ❌ |
| `plugins.bundle.config` | key = **npm 包名**，渲染在组合包详情页 |
| `plugins.row.config` | key = **`<包名>#<行id>`**，会给那一行一个**「配置」控件**；页面宿主会传入 `form.state` / `form.mutate(...)` ✅ |
| `settings.section` | 设置左侧导航的一页；`settings.plugins.tab` 是「设置 → 插件」里的一个标签页 |
| `inject` 规则 | **访问任何服务都要先在 `inject` 里声明**，否则属性访问抛 `cannot get property "..." without inject`。远程命名空间要写**点号全名**：`'remote.pluginManager'`、`'remote.settings'` |
| Host 侧同样适用 | 本插件 Host 半区必须 `inject = ['connection']`，否则 `ctx.connection` 抛错 |
| `Config` 声明 | `export const Config = Schema.object({…})`，`Schema` 是 **`@deepseek-ai/schemastery` 的默认导出**（不是 cordis 上的 `Schema`！）。裸名能解析的前提是 `package.json` 把该包声明为 **peerDependency**（见第 2 节第二道门）；纯 node 环境解析不到，用动态 import + 兜底 |
| `Config` 的两个硬前提 | ① 原生 schema（`Symbol.for('schemastery')`，实例是**函数**）；② 至少要有一个 **`.volatile()`** 字段，否则 Host 设置文档根本不列这条命名空间（`volatileForm`） |
| 设置命名空间 id | = **Loader 条目的 `options.id`**（patch 里的行 id，本插件是 `remote-access`），不是包名 |
| `.volatile()` 的含义 | 只决定「哪些字段进设置表单」，**不是「免重启」**：Cordis `Fiber.update()` 最后一律 `restart()`，插件会重新 apply |
| 设置写入落盘在哪 | profile 的 patch 文档（`cordis.patch.yml` 那一层），由 `configEditor.edit()` 写入后按 Loader 正常路径重挂载 |
| `host.call` 的适用范围 | 只属于**动态半区**（cordis-client-runner，符号面固定为 `React`/`console`/`styles`/`host`）。module-loader 半区的模块表里**没有** `host` |
| config 入参形态 | 声明 `Config` 后，`apply` 拿到的 config 可能是 **Schema 字段引用**，读值要用 `.get()` 兜底（本插件已做） |
| 改代码的生效条件 | **换 JS 必须重启 DSH**（热重载只重组配置，不换模块代）；`cordis.patch.yml` / home patch 的改动**不会自己**触发重组（实测：手工改 `maxConnections` 3→7，盯 16 秒无反应） |
| 配置热重载的钩子 | `configEditor.edit()` 写盘后会 `reconcileProfilePatches()`，它在**根上下文**发 **`app-boot/config-reload`**（settings provider 自己就挂这个事件失效缓存：`ctx.on("app-boot/config-reload", …)`）。Cordis 事件是**父→子**派发，所以在自己 context 上 `ctx.on` 就能收到根上发的事件；反过来（听兄弟服务在自己 context 上 emit 的 `settings/document-updated`）**收不到** |
| 读「生效配置」的正确姿势 | 服务名是 **`settings`**（`SettingsForms`，`super(ownerContext, "settings")`，`static inject = ["configEditor","profileContext"]`）。`ctx.get('settings').describe({redactSecrets:true})` 返回描述符数组，每项有 `ns / value / base / user / revision`。**`value` 是运行中 fiber 的旧值**（不可靠），`user` 是刚写进 patch 的那层、`base` 是它下面继承的层 —— 热重载要读 `{...base, ...user}` |
| 重启的副作用 | 每次重启换 **token**（带票网址失效）与**随机端口**（除非 `port` 固定）；DSH 的 cookie **绑定 hostname:port** → 改端口后手机上要重新做一次解锁/带票访问 |
| 创造模式 | preset id 是 **`cordis`**，显示名「创造模式」；它额外提供 `cordis_inspect_*` 与 `plugin_manager`。标准模式（`standard`）没有这两样 |
| 模式是会话级 | 会话创建时钉住 preset；新会话解析 `selectedDefault`。**子智能体没有 preset 参数**，只能继承所处会话（实测：标准模式会话起的 subagent 也是标准模式） |

---

## 5. 文件与路径

| 路径 | 说明 |
|---|---|
| `C:\ProgramData\dsh-plugins\dsh-remote-access\` | **插件的真实文件**（ACL：15861 可写、Assistant 可读） |
| `C:\Users\15861\projects\dsh-remote-access\` | **同上的 junction**（git 工作路径，在本目录提交/推送） |
| `C:\Users\Assistant\.dsh\profiles\desktop\` | **两个用户共享的 profile**（本用户经 junction 指向它）——改动会影响 Assistant，注意 |
| `C:\Users\15861\.dsh\cordis.patch.yml` | 本用户的 home patch（现只剩 `llm-deepseek`；`agent-preset-registry` 那条已删，因为它压住了 `selectedDefault` 让模式切不动；备份 `cordis.patch.yml.bak-20260930-151254`） |
| `C:\Users\15861\.dsh\remote-access-url.txt` | 状态文件：带票网址 + 生效配置 + 诊断（模式 0600，含令牌，别外传） |
| `E:\Applications\DeepSeek Harness\resources\app.asar` | DSH 安装包（`read` 工具读不了，`grep` 能看内容行；`tools/asar-extract.mjs` 可整文件提取） |
| `docs/` | 本地提取的 DSH 官方插件开发文档（**已 gitignore，勿提交**） |
| `tools/test-remote-access.mjs` | 独立功能测试（起假上游，无需 DSH） |
| `tools/check-config-schema.mjs` | 用安装包里的真 Schemastery 校验 `Config`（原生 + 全字段 volatile + 与 `client.js` 表单对表），无需重启 DSH |

**git**：`git@github.com:Mzy123l/dsh-remote-access.git`，分支 `main`。
`git ls-remote` 若报 `Permission denied (publickey)`，是 Git 自带 ssh 与系统 OpenSSH 不一致，执行一次：
`git config core.sshCommand 'C:/Windows/System32/OpenSSH/ssh.exe'`。

---

## 6. 环境操作纪律

- **改 `index.js` / `client.js` 后必须重启 DSH**；重启前先确认状态文件的生效配置，用来对照。
- **权限方向不能反**：只能给 Assistant 读 15861 的东西，绝不给 15861 反向开 Assistant 的目录；任何 ACL 改动先跟用户说。
- 不要动 `listener.exe`（另一条线：C++ 本地代理，见 `C:\Users\15861\projects\ListenRequest\`）。
- **不把密钥 / token 写进代码或提交**（状态文件里的 token 属于运行时产物）。
- 提交信息用中文、小而聚焦；推送前先跑语法检查与独立测试。
- 用户看不到你的中间步骤，**说明要写给他看**：结论 + 需要他做什么 + 会有什么副作用。

---

## 7. 待办清单

1. **[待用户]** 重启一次 DSH 装上这一代 JS（首启之后，改参数就是热重载，不必再重启）。
   重启后状态文件应出现 `手机访问: http://…` 与 `解锁密码: 已设置`；若出现 `Config schema 没拿到（…）`，
   照第 2 节两道门查。
2. **[安全]** 现在设了 `accessCode`（用户选定「网段 + 6 位密码」）：网段内开裸地址输一次即进，
   解锁后由插件在服务端补票，**token 在这条路上不再是第二道门**；**错一次即把该 IP 拉黑**
   （`%USERPROFILE%\.dsh\remote-access-bans.txt`，删掉那一行 1 秒内解封）。
   想回到严格模式：把 `cordis.patch.yml` 里的 `accessCode` 清空。
3. 建议顺手把 `maxConnections` 从 3 调回 64：浏览器对同一 origin 会开好几条 keep-alive 连接，
   上限 3 会让手机端加载时好时坏（设置页里就能改，保存即热重载）。
4. 可选：把第 2 节那段「用 DSH 自带运行时跑真解析器 A/B」的探针做成 `tools/check-resolution.mjs`，
   这样连 peer 是否真的生效都能在重启前验掉（本轮是手写临时探针跑的）。
5. 可选：命令行工具（`E:\Applications\dsh-remote-access`）——按参数启动 DSH、已在跑则改参数（用户提过，但 GUI 优先）。
6. 可选：客户端页面显示**当前生效的访问地址**（现在只能读状态文件）。需要 Host⇄Client 数据通道——
   注意 module-loader 半区拿不到 `host.call`，可行路线是让 Host 半区把地址写进状态文件后由页面读文件、
   或按官方做法定义一个 `@Remote` 端点（要带 typert 生成的 codec）。
