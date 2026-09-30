# dsh-remote-access

给 **DeepSeek Harness（DSH）桌面版**用的一个小插件：把本机 DSH 的网页界面**只开放给你指定的网段**
（默认 Tailscale 的 `100.64.0.0/10`），让你可以用手机 / 另一台电脑通过一条「带票的网址」访问它。

- 不写死任何地址：网段、监听地址、端口、上游、落地文件全是配置项。
- 只监听「允许网段」里属于本机的地址，**绝不会绑 `0.0.0.0`**；网段外的对端一律 `403`。
- 访问仍需 DSH 自己的令牌 / cookie（没票就是 `401`），插件不提供任何绕过。
- 默认把 `Host` / `Origin` 改写成上游回环地址，因此**不用去改 `client-connection` 的配置**。
- 无论成功失败都会写一份自诊断文件，方便在看不到 DSH 日志时定位问题。

## 安装

插件是 DSH 的 bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入一行插件。

**推荐用插件页装**（GUI 会把依赖和"启用"一起写好）：

```
设置 → 插件 → 添加插件 → 填本目录的绝对路径 → 安装
```

也可以用 CLI（注意：**DSH 正在运行时 profile 写锁会占住**，CLI 可能一直等；两种方式二选一即可）：

```powershell
dsh plugin --profile desktop add C:\ProgramData\dsh-plugins\dsh-remote-access
```

装完**重启一次 DSH**（新增 bundle 能热载；但改过 JS 代码后必须重启才会加载新的模块代）。

## 配置

**首选：设置 → 远程访问**（设置左侧导航里那一页），只有 7 项：启用、允许的网段、排除的网段、端口、
并发上限、日志级别、访问密码。保存写进 profile 的 `cordis.patch.yml`，插件随后**热重载**（原地关掉旧监听、
按新参数重开），不用重启 DSH —— 端口会变，新网址以状态文件为准。手机上的那一页同样能改（见下）。

其余参数只在 `cordis.patch.yml` 里配（也不建议常用）：

| 键 | 默认 | 说明 | 在设置页里 |
|---|---|---|---|
| `enabled` | `true` | 关掉它只需设 false，不必卸载 | ✅ |
| `allowCidrs` | `['100.64.0.0/10']` | 允许来访的网段；也是 `listen: auto` 挑选本机监听地址的依据 | ✅ |
| `denyCidrs` | `[]` | 白名单内的例外黑名单 | ✅ |
| `port` | `0` | 监听端口，`0` = 系统随机 | ✅ |
| `maxConnections` | `64` | 并发连接上限（浏览器会开好几条 keep-alive，别设太小） | ✅ |
| `logLevel` | `'info'` | `silent` / `info` / `debug` | ✅ |
| `listen` | `'auto'` | `auto` = 只监听上面网段里的本机地址；也可写 `['100.x.y.z']` | — |
| `upstream` | `'auto'` | DSH 界面地址；`auto` 会读 `ctx.webServer.port`（拿不到再试 `webRuntime` / `$DSH_WEB_PORT`） | — |
| `rewriteHost` | `true` | 改写 `Host`/`Origin` 为上游 authority | — |
| `forwardClientHeaders` | `true` | 转发 `x-forwarded-for` / `x-forwarded-proto` | — |
| `timeoutMs` | `0` | 上游请求超时（毫秒）；`0` = 不超时 | — |
| `allowWebSocket` | `true` | 透传 WebSocket（界面实时推送靠它） | — |
| `urlFile` | `''` → `<DSH_HOME>/remote-access-url.txt` | 带票网址写哪；`off` = 不写 | — |
| `printUrl` | `true` | 同时打到 DSH 日志 | — |
| `accessCode` | `''` | 网段内的访问密码（4–12 位数字）。设了就**不用复制 token**：手机直接开裸地址，输一次即可；**输错一次就把该地址拉黑** | ✅ |
| `banFile` | `''` → 与状态文件同目录的 `remote-access-bans.txt` | 拉黑名单；删掉里面那一行即可解封（最多 1 秒生效） | — |

> 手机（远程页面）也能改配置：DSH 的**客户端**策略让 `configForms` 在非回环页面恒为不可写
> （ui-settings 里 `persistence = isLoopback ? 'host' : 'memory'`），但 Remote 通道本身是通的，
> 所以那一页直接调 `ctx.remote.settings.describe()` / `mutate()` —— 写盘跑在 Host 网关自己的上下文里，
> 落盘位置与设置页**完全相同**（profile 的 `cordis.patch.yml`），而且等写盘完成才回执。
> 别自己开 HTTP 端点去调 `configEditor.edit()`：那条路会撞 HMR 事务（教训见 `HANDOFF.md`）。

**改密码不会把已经进来的设备踢下线**：放行 cookie 的密钥与 `accessCode` 无关，单独存在
`<DSH_HOME>\remote-access-secret`（`0600`），DSH 重启后也照样有效。想让所有设备重新输一次密码，
删掉那个文件即可。

**那个状态文件里有访问令牌，等于本机操作权限**，按 `0600` 写入，别外传（`accessCode` 会在里面打码）。

> 设置页能写盘的前提有两道门，缺一条保存就会失败：
> 1. 这一行的 `Config` 是**原生 Schemastery schema**（`@deepseek-ai/schemastery`）且每个字段都标了
>    `.volatile()` —— Host 的设置文档由 `volatileForm` / `isVolatilePath` 过滤，只服务「含 volatile 字段」的条目；
> 2. `package.json` 把 `@deepseek-ai/schemastery` 声明为 **peerDependency** —— 本插件是用 `link:` 装进
>    profile 的，DSH 的解析器只对「声明过的 peer」放行安装目录（`app.asar\dsh\node_modules`）里的包；
>    peer 不会被 pnpm 装进 profile，所以依然是零依赖。
>
> `node tools/check-config-schema.mjs` 会把两道门都验掉（不需要重启 DSH）。

## 使用

**设了 `accessCode`（推荐，手机不用复制长串）：**

1. 手机上直接打开 `http://<地址>:<端口>/`（地址见状态文件里那行 `手机访问:`）。
2. 输一次访问密码 → 进入。之后 30 天免密（cookie）。
3. 密码**输错一次**，该 IP 立刻进拉黑名单并一律 403；解封 = 删掉
   `<DSH_HOME>\remote-access-bans.txt` 里那一行（最多 1 秒生效）。

**没设 `accessCode`：** 打开状态文件里那条 `远程访问网址: http://…/?token=…` 一次，
把 token 换成 DSH 的签名 cookie（默认 30 天），之后直接访问 `http://<地址>:<端口>/`。

> 换端口 / 重启 DSH 之后，旧 cookie 不通用（DSH 的 cookie 绑 `hostname:port`，且每次重启换 token），
> 用第 1 步重来一次即可。

## 手机上的「新建工作区」选目录

DSH 默认用 `directory-picker-auto` 选目录器：它判定「回环绑定 + 非 SSH + 有显示会话」就会挑
**原生**后端，而原生后端是在**宿主屏幕上**弹系统对话框 —— 手机那边点下去只会一直等（「打不开文件管理器」
就是这个）。

本插件的 bundle patch 因此把选目录器固定成**应用内浏览**：关掉 auto，改挂
`dsh-host-directory-picker-browse`（列目录 / 建目录的后端）+ `dsh-client-ui-directory-picker-browse`
（「选择工作区目录」对话框）。手机上点新建工作区就会弹出这个应用内对话框，桌面上也一样。

- 桌面端代价：系统原生对话框换成应用内对话框（功能等价）。
- 安全说明：已授权的远程端因此可以**列目录、建目录**。它本来就能通过 DSH 跑命令，所以这不是新的权限等级，
  但如果你不想让远程端看到文件系统，就把 `cordis.patch.yml` 里 `disabled` 那段和两行 `-browse` 删掉
  （代价：手机端不再有选目录能力）。

## 安全边界

- 只监听 `allowCidrs` 里的本机地址；**永远不会绑 `0.0.0.0`**。
- 每个连进来的对端地址也必须在 `allowCidrs` 内，否则 `403`；在拉黑名单里的一律 `403`。
- **设了 `accessCode` 就不要再把它当"双因子"**：那时网段 + 6 位密码就是全部凭据。解锁成功后由本插件
  在**服务端**替请求补上 DSH 的 token（浏览器始终看不到 token），所以 token 在这条路径上不再是第二道门。
  想回到"必须带票"的严格模式，把 `accessCode` 清空即可（行为与以前完全一致：没票由 DSH 自己 401）。
- 没设 `accessCode` 时：DSH 自身的令牌 / cookie 仍然生效（没票 `401`），本插件不降低 DSH 的任何鉴权。
- 一次密码错误立即拉黑该地址（写进 `banFile`），这是**故意的**：可暴力猜的 6 位数字需要一道硬刹车。
- 建议再在 Tailscale ACL 里限定设备；`tailscale funnel`（公网）不要开。
- 本插件把来自网段的请求改写 `Host`/`Origin` 后转给回环上的 DSH，因此**它就是这个边界的守门人**：`allowCidrs` 写宽了，等于把本机命令执行权限放开。

## 开发

```bash
node --check index.js                       # 语法
node tools/test-remote-access.mjs           # Host 功能测试（无需 DSH，起一个假上游）
node tools/test-client.mjs                  # 客户端冒烟测试（无需浏览器：极简 React/宿主桩子真跑一遍设置页）
node tools/check-config-schema.mjs          # 用安装包里的真 Schemastery 校验 Config（找不到安装包则 SKIP）
```

`tools/test-remote-access.mjs` 覆盖：转发、`Host`/`Origin` 改写、`x-forwarded-for`、WebSocket `101` 透传、
网段外 `403`、拿不到令牌时的降级、状态文件与带票网址。

`tools/test-client.mjs` 用一个极简的 React / 宿主桩子把 `client.js` 真跑一遍（注册、渲染、改字段、点保存，
回环与手机两条通道各一遍），所以「手机上读不到值 / 报了成功却没写进去」这类只有真页面才暴露的问题，
能在重启 DSH 之前就被测出来（Remote 通道返回的是 `{ ok, value }` 信封，这是最容易踩的一处）。

`tools/check-config-schema.mjs` 覆盖「设置页写不写得进去」的硬前提：`peerDependencies` 是否声明了
`@deepseek-ai/schemastery`（含版本范围容不容得下装着的版本）、`Config` 是否是原生 Schemastery schema、
是否每个字段都标了 `.volatile()`；顺带对表 `client.js` 的表单字段与 `Config` 字段、控件类型与 schema 类型。
它把安装包里的 `schemastery` 铺进临时 `node_modules` 再加载 `index.js`，因此不需要 DSH。

`tools/asar-extract.mjs` 可以从 `app.asar` 里读文件（DSH 的实现、技能、模板都在里面）：

```bash
node tools/asar-extract.mjs "E:\Applications\DeepSeek Harness\resources\app.asar" "dsh/package.json"
```

`docs/dsh-plugin-refs/` 是从安装包里抽出来的 DSH 官方插件开发技能与模板，
**版权归 DeepSeek，已加进 `.gitignore`，不要提交**；保留在本地只是方便对照规范。

## 目录

```
index.js            插件 Host 半区（零依赖，只用 node: 内置模块）
cordis.patch.yml    bundle 的 patch：插入 remote-access 这一行 + 默认配置
package.json        清单（dsh.bundle.patch / exports / icon / meta）
locale/{zh,en}.json 插件页显示用的标题与说明
icon.svg            插件页图标
tools/              测试与 asar 取文件工具
docs/               本地参考（不入库）
```
