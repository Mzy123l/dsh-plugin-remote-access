# dsh-remote-access — 项目约定与现状

给 **DSH（DeepSeek Harness）桌面版**用的「限网段远程访问入口」插件：让手机 / 另一台设备在指定网段
（默认 Tailscale `100.64.0.0/10`）打开本机 DSH 的网页界面 —— 要么用带令牌的网址，要么（设了
`accessCode` 时）开裸地址输一次 6 位密码。

## 硬约定

- 中文注释、中文提交信息；变量名 / 函数名保持英文。
- **不要把地址写死**：网段、监听地址、端口、上游端口一律走 `Config`（`cordis.patch.yml` 的 `config`）。
- 零依赖：只用 `node:` 内置模块（装进 profile 不拉任何第三方包）。
- **安全边界不许放松**（要动先说清理由）：只监听 `allowCidrs` 内的本机地址（永不 `0.0.0.0`）；
  对端也必须在 `allowCidrs` 内；**没设 `accessCode` 时**不绕过 DSH 自己的令牌 / cookie。
  **例外是用户 2026-10-01 明确选定的**：设了 `accessCode` 就走「网段 + 6 位密码」——解锁后由 Host 半区
  在服务端补票（浏览器始终看不到 token），一次输错即把该地址拉黑。这条路径上 token 不再是第二道门，
  不要以为它还挡着；也不要在这条路上再放松别的东西（比如给密码加"记住上次输入"之类的旁路）。
- **密码 / 令牌不进仓库**：`accessCode` 的**默认值不要写死**在代码里（写死等于提交密码）；它只在 profile 的
  `cordis.patch.yml` 或设置页里改。手写 YAML 时必须加引号（`accessCode: "126710"`），否则会被解析成数字、
  schema 校验失败。状态文件里打码成 `***`。
- **失败必须可见**：任何提前退出都要写状态文件（`<DSH_HOME>/remote-access-url.txt`），不许"哑巴失败"。

## 常用命令

```bash
node --check index.js                 # 语法检查
node tools/test-remote-access.mjs     # Host 功能测试（起假上游，无需 DSH）
node tools/test-client.mjs            # 客户端冒烟测试（极简 React/宿主桩子，不需要浏览器）
node tools/check-config-schema.mjs    # 用安装包里的真 Schemastery 校验 Config（找不到安装包则 SKIP）
```

## 安装与生效

- 装：DSH 插件页 → 添加插件 → 填本目录绝对路径；或 `dsh plugin --profile desktop add <路径>`
  （DSH 正在运行时 profile 写锁会占住 CLI，那就走 GUI）。
- **改过 `index.js` 后必须重启 DSH**：热重载只重组合配置，不换代码的模块代。
- 看效果：`<DSH_HOME>\remote-access-url.txt` —— 含带票网址、生效配置、上游探测与自检诊断。

## 现状（2026-10-01）

**Host 半区已完成** ✅：只监听允许网段内的本机地址、网段外对端 403、HTTP/WS 透传、Host+Origin 改写、
带 token 网址写入状态文件、上游自检重试 8×2 秒、失败必写状态文件、`ctx.effect` 关监听；
**热重载**：设置页保存后 DSH 发 `app-boot/config-reload`，插件原地关旧监听、按新参数重开（不重启 DSH）；
**解锁模式**：设 `accessCode` 时网段内开裸地址 → 解锁页 → 输一次密码 → 服务端补票进 DSH，
**错一次即拉黑该 IP**（名单在 `banFile`，删行即解封）；
**远程改配置**：手机那一页直接调 `ctx.remote.settings.describe() / mutate()`（configForms 在非回环页面被
客户端策略禁掉，但 Remote 通道是通的），写盘由 Host 网关跑，落盘位置与设置页相同。
**别再自建 HTTP 端点去调 `configEditor.edit()`** —— 它会撞 HMR 事务（`HMR transactions cannot be nested`），
而且「先回执再落盘」会把旧值当成功回报（用户看到的就是「显示已保存、实则回退」）。放行 cookie 的密钥独立存在
`remote-access-secret`（与 `accessCode` 解耦，**改密码/重启都不踢人**，删文件才强制重新输）。
**手机端选目录（新建工作区）**：`directory-picker-auto` 判定「回环绑定 + 有显示会话」会挑 native 后端 ——
那是在**宿主屏幕上**弹系统对话框，手机点下去只会一直等。bundle patch 因此关掉 auto、改挂
`dsh-host-directory-picker-browse` + `dsh-client-ui-directory-picker-browse`（应用内浏览）。
独立测试 **28/28** 通过（含解锁/拉黑/热重载/改密码不踢人），客户端冒烟 **22/22**，Config 校验 **12/12**。
手机侧已实测：带票网址 → 303 → cookie → 200；无票 401；网段外 403。

**Client 半区（`client.js`）已完成** ✅：注册进 `settings.section`，7 项（启用 / 允许的网段 / 排除的网段 /
端口 / 并发上限 / 日志级别下拉 / 访问密码）+ 保存；界面上不写英文键名、不放说明文字，空值靠灰色占位符
（`换行分割` / `0=随机` / `0=不限制` / `6位数字`），数字 0 显示成空好让占位符露出来。
读写有**两条通道**：回环页面走官方 `ctx.configForms.get('remote-access')`
（`getSnapshot` 读、`mutate([{op:'set',path:[key],value}], revision)` 原子写）；
非回环页面（手机）改走 Remote 通道 `ctx.remote.settings.describe() / mutate()`。页面上只说人话，
内部状态只写开发者控制台。

**设置页保存已修好** ✅（两道门的根因见下）。**换 JS 仍需重启一次 DSH**；那之后改参数就是热重载了。

**根因一（写不进去）**：Host 的设置文档只服务「`Config` 是原生 Schemastery schema、且含
`.volatile()` 字段」的条目（`@deepseek-ai/dsh-settings` 的 `volatileForm` / `isVolatilePath`）。
`@deepseek-ai/dsh-app-boot` 的 `isNativeConfigSchema` 认的是 `Symbol.for('schemastery')`，而真包名是
**`@deepseek-ai/schemastery`**（不是 `cordis`）。原来 `import('@deepseek-ai/cordis')` 取 `Schema`
得到 undefined → `Config` 没导出 → `Config.listConfigs` 里这一行 `status: "absent"` → 命名空间从不出现
→ `configForms.set` 静默返回 false。

**根因二（第一轮修完仍然 absent）**：DSH 把 profile 里以 `link:` 装的插件当作 **linked 层**，
`ResolutionRouter.routeLinked()` 只对「某个祖先目录的 `package.json` 在 `peerDependencies` 里列过」的
裸名放行，否则退回原生解析——安装目录（`app.asar\dsh\node_modules`）里的包永远找不到。
所以 `package.json` **必须**声明 `"peerDependencies": { "@deepseek-ai/schemastery": "^3.18.1" }`：
peer 不会被 pnpm 装进 profile（仍是零依赖，`dshmarket` 也是这么声明 cordis/schemastery 的），
但它是 DSH 肯把安装目录里的包借给你的**唯一凭据**。
`node tools/check-config-schema.mjs` 现在把这两道门都验了（12 项），**改完先验再重启**。

**关键教训**：
- 客户端 `inject` 必须写点号全名（`'remote.pluginManager'`、`'remote.settings'`），只写 `'remote'` 会报 `without inject`；
- 这两个 `remote` 面孔现在用不着了：读写都走 `configForms`（它内部持有 `remote.settings`）；
  **但手机端例外** —— 非回环页面 `configForms` 恒为 unavailable，必须直接用 `ctx.remote.settings`；
- **别在插件里自己建 HTTP 端点去调 `configEditor.edit()`**：请求回调跑在我们监听创建出来的异步链里，
  而 `hmr.runExclusive` 用 AsyncLocalStorage 判嵌套，会报 `HMR transactions cannot be nested`；
  真要在 Host 侧写盘，就走 Remote 通道让网关去跑（见 HANDOFF.md 第 4 节）；
- **`ctx.remote.*` 返回的是 RemoteResult 信封**（`{ ok:true, value }` / `{ ok:false, error }`），不是裸数据，
  必须拆开：官方镜像写的就是 `response.ok ? response.value : response.error.message`。当裸数据用会
  「找不到命名空间 → 页面全空/全 0」；忘了查 `ok` 则「写入被拒也当成功」。这条有客户端冒烟测试兜着；
- **补丁行里的 `name` 是守卫不是赋值**：`applyEntryPatches` 里 `if (name && name !== target.name) { warn(); continue }`
  —— 写错名字整条补丁被**静默跳过**（日志里只有一条 warn）。要换掉一行插件（比如把 `directory-picker-auto`
  换成 browse），只能：`disabled: true` 关掉旧行 + `insert` 新行，不能靠改 `name`；
  而且关旧行与插新行**必须成对**，否则重复注册服务（`ctx.directoryPicker`）会直接启动报错；
- 改 JS 后**必须重启 DSH**；改 `Config` 默认值也算改 JS；
- 提参数前先看 `Config.listConfigs` 里这一行的 `status`：不是 `schema` 就说明 Host 还不服务它；
- 手动改 `cordis.patch.yml` **不触发**热重载（实测：改 `maxConnections` 3→7 盯 16 秒无反应），
  要么在设置页点一次保存（这会发 `app-boot/config-reload`，顺带把手工改动带进来），要么重启 DSH。

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | 插件本体（Host 半区，零依赖） |
| `client.js` | 浏览器半区（module-loader 形态）：设置页里的参数表单 |
| `HANDOFF.md` | 交接文档：现状、原卡点的根因判断链、已查明的 DSH 内部事实 |
| `cordis.patch.yml` | bundle 的 patch：插入 `remote-access` 一行 + 默认配置；并关掉 `directory-picker-auto`、改挂 browse 选目录器（手机端要用） |
| `package.json` | 清单（`dsh.bundle.patch` / `exports` / `icon` / `meta`） |
| `tools/` | `test-remote-access.mjs` Host 功能测试；`test-client.mjs` 客户端冒烟（React/宿主桩子）；`check-config-schema.mjs` Config 校验；`asar-extract.mjs` 从 `app.asar` 取文件 |
| `docs/` | DSH 官方插件开发文档（本地参考，**已 gitignore，勿提交**） |
