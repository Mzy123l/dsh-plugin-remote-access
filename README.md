# dsh-remote-access

给 **DeepSeek Harness（DSH）桌面版**用的插件：把本机 DSH 的网页界面**只开放给你指定的网段**
（默认 Tailscale 的 `100.64.0.0/10`），于是手机或另一台电脑也能用上它。

- **不绑 `0.0.0.0`**：只监听「允许网段」里属于本机的地址，网段外的对端一律 `403`。
- **不写死地址**：网段、监听地址、端口、上游、落地文件全是配置项。
- **两种进入方式**：复制带令牌的网址；或者设一个数字密码，手机开裸地址输一次（之后 30 天免密）。
- **在设置页里改**：保存即热重载（原地关掉旧监听、按新参数重开），不用重启 DSH。
- **失败可见**：无论成功失败都会写一份自诊断文件，看不到 DSH 日志时也能定位。

## 安装

用 DSH 插件页（推荐，GUI 会把依赖和「启用」一起写好）：

```
设置 → 插件 → 添加插件 → 填本仓库目录的绝对路径 → 安装
```

也可以用 CLI（DSH 正在运行时 profile 写锁会占住，CLI 可能一直等；两种方式二选一即可）：

```powershell
dsh plugin --profile desktop add <本仓库目录的绝对路径>
```

装完**重启一次 DSH**。之后改参数都是热重载；但换了 `index.js` / `client.js` 的代码仍需重启一次才会加载。

## 使用

### 方式一：设访问密码（推荐，手机不用复制长串）

1. 「设置 → 远程访问 → 访问密码」填 4–12 位数字（建议 6 位），保存。
2. 手机打开 `http://<地址>:<端口>/` —— 地址和端口见状态文件里的 `手机访问:` 那一行。
3. 输一次密码即可进入，之后 **30 天免密**（cookie）。
4. 密码**输错一次**，该地址就**自动写进「排除的网段」**（形如 `100.x.y.z/32`）、之后一律 `403`；
   解封 = 到「设置 → 远程访问 → 排除的网段」里把那一项删掉。

### 方式二：用带令牌的网址（不设密码）

打开状态文件里的 `远程访问网址: http://…/?token=…` **一次**，DSH 会把 token 换成自己的签名
cookie（默认 30 天）；之后直接访问 `http://<地址>:<端口>/` 即可。没票就是 `401`。

> **每次启动 DSH 都会换一张 token**（用另一个 Windows 账户跑 DSH，也有它自己的一张），所以旧网址、
> 别的账户/上一次运行留下的网址里那个 `?token=…` 已经作废 —— 拿它访问会看到 DSH 自己那句
> `dsh web authentication required; …`。省事的做法：设了 `accessCode` 就直接打开**裸地址**
> （`http://<地址>:<端口>/`）输一次密码；没设就复制状态文件里**当前**那条带票网址。
> 旧 cookie 同理不通用（DSH 的 cookie 绑 `hostname:port`）。

### 状态文件

`<DSH_HOME>\remote-access-url.txt`（默认在 `%USERPROFILE%\.dsh`，权限 `0600`）里写着：带票网址、
手机访问地址、是否开启了解锁密码、已拉黑的地址与「待补写」的地址、放行密钥、当前生效的配置、
上游自检结果。打不开时先看它。

> ⚠️ 文件里有**访问令牌，等于本机操作权限**，不要外传（访问密码在里面打码成 `***`）。

## 配置

「设置 → 远程访问」里只有 7 项：**启用 / 允许的网段 / 排除的网段 / 端口 / 并发上限 / 日志级别 / 访问密码**。
保存会写进 profile 的 `cordis.patch.yml`，插件随即热重载（端口会变，新网址以状态文件为准）。

**手机上的同一页也能改**：DSH 的客户端策略让 `configForms` 在非回环页面不可写，但 Remote 通道本身是通的，
所以那一页直接调 `ctx.remote.settings.describe()` / `mutate()`，写盘跑在 Host 网关自己的上下文里，
落盘位置与桌面**完全相同**，而且等写盘完成才回执。

其余参数只在 `cordis.patch.yml` 里配（也不建议常用）：

| 键 | 默认 | 说明 | 设置页 |
|---|---|---|---|
| `enabled` | `true` | 关掉它只需设 `false`，不必卸载 | ✅ |
| `allowCidrs` | `['100.64.0.0/10']` | 允许来访的网段；也是 `listen: auto` 挑选本机监听地址的依据 | ✅ |
| `denyCidrs` | `[]` | 白名单里的例外黑名单；输错访问密码的地址会**自动加到这里**，删掉该项即解封 | ✅ |
| `port` | `0` | 监听端口，`0` = 系统随机 | ✅ |
| `maxConnections` | `64` | 并发连接上限（浏览器会开好几条 keep-alive，别设太小） | ✅ |
| `logLevel` | `'info'` | `silent` / `info` / `debug` | ✅ |
| `accessCode` | `''` | 解锁密码（4–12 位数字）。设了就**不用复制 token**：手机开裸地址输一次即可；输错一次即把该地址写进「排除的网段」 | ✅ |
| `listen` | `['auto']` | `auto` = 只监听上面网段里的本机地址；也可写 `['100.x.y.z']` | — |
| `upstream` | `'auto'` | DSH 界面地址；`auto` 读 `ctx.webServer.port` | — |
| `rewriteHost` | `true` | 把 `Host`/`Origin` 改写成上游 authority | — |
| `forwardClientHeaders` | `true` | 转发 `x-forwarded-for` / `x-forwarded-proto` | — |
| `timeoutMs` | `0` | 上游请求超时（毫秒），`0` = 不超时 | — |
| `allowWebSocket` | `true` | 透传 WebSocket（界面实时推送靠它） | — |
| `urlFile` | `''` → `<DSH_HOME>/remote-access-url.txt` | 状态文件写哪；`off` = 不写 | — |
| `printUrl` | `true` | 同时把带票网址打到 DSH 日志 | — |
| `banFile` | `''` → 与状态文件同目录的 `remote-access-bans.txt` | 拉黑**暂存**文件：只有「写进排除的网段」失败时才用得上，平时不用碰 | — |

**改密码不会把已经进来的设备踢下线**：放行 cookie 的密钥与 `accessCode` 无关，单独存在
`<DSH_HOME>\remote-access-secret`（`0600`），DSH 重启后也照样有效。想让所有设备重新输一次密码，
删掉那个文件即可。

## 手机上的「新建工作区」选目录

DSH 默认用 `directory-picker-auto`：它判定「回环绑定 + 非 SSH + 有显示会话」时会挑**原生**后端，
而原生后端是在**宿主屏幕上**弹系统对话框 —— 手机那边点下去只会一直等（表现就是「打不开文件管理器」）。

本插件的 bundle patch 因此把选目录器固定成**应用内浏览**：关掉 auto，改挂
`dsh-host-directory-picker-browse`（列目录 / 建目录的后端）+ `dsh-client-ui-directory-picker-browse`
（「选择工作区目录」对话框）。手机上点新建工作区就会弹出这个应用内对话框，桌面上也一样。

- 桌面端代价：系统原生对话框换成应用内对话框（功能等价）。
- 安全说明：已授权的远程端因此可以**列目录、建目录**。它本来就能通过 DSH 跑命令，所以这不是新的权限等级；
  不想让远程端看到文件系统，就把 `cordis.patch.yml` 里 `disabled` 那段和两行 `-browse` 删掉
  （代价：手机端不再有选目录能力）。

### 为什么只看到「主目录」，怎么去别的盘

对话框的面包屑**在主目录以内会折叠**：起点显示成「主目录」，`C:\`、`Users` 这些上层被有意隐掉，
所以「找不到上一级」是设计而不是坏了。跳出去很容易：

点面包屑**右端的铅笔按钮（「编辑路径」）**，它会变成输入框并预填当前路径，改成你要的路径回车即可：

| 输入 | 效果 |
|---|---|
| `C:\` | C 盘顶层，所有顶层文件夹都出来了 |
| `D:\projects` | 直接跳到目标目录 |
| `\\server\share` | UNC 路径 |

宿主只接受**完全限定**路径（Windows 上必须是 `C:\…` 或完整的 `\\server\share…`；`\foo`、相对路径会被拒绝）。
跳到主目录**以外**之后，面包屑就会显示真实完整路径。目标文件夹不存在时，先用对话框里的「新建文件夹」，
或直接输入一个已存在的目录再点「打开」。

## 安全边界

- 只监听 `allowCidrs` 里的本机地址，**永远不会绑 `0.0.0.0`**。
- 每个连进来的对端地址也必须在 `allowCidrs` 内，否则 `403`；被拉黑（在 `denyCidrs` / 拉黑暂存里）的一律 `403`。
- 没设 `accessCode` 时：DSH 自身的令牌 / cookie 仍然生效（没票 `401`），本插件不降低 DSH 的任何鉴权。
- **设了 `accessCode` 就别再把它当「双因子」**：那时「网段 + 数字密码」就是全部凭据 —— 解锁成功后由本插件
  在**服务端**替请求补上 DSH 的令牌（浏览器始终看不到 token），token 在这条路径上不再是第二道门。
  想回到「必须带票」的严格模式，把 `accessCode` 清空即可。
- 一次密码错误立即拉黑该地址（写进「排除的网段」`denyCidrs`；万一写盘失败，它仍会被立刻拦住、
  暂存到 `banFile` 并在状态文件里写明），这是**故意的**：可暴力猜的数字密码需要一道硬刹车。
- 建议再在 Tailscale ACL 里限定设备；`tailscale funnel`（公网入口）不要开。
- 本插件把来自网段的请求改写 `Host`/`Origin` 后转给回环上的 DSH，因此**它就是这个边界的守门人**：
  `allowCidrs` 写宽了，等于把本机命令执行权限放开。

## 常见问题

**显示 `dsh web authentication required`（DSH 自己那句英文）** — 说明这次访问用的是**已经作废的票**：
每次启动 DSH 都会换一张 token，别的账户/上一次运行留下的那条 `?token=…` 网址都不能再用了。
换个做法：设了 `accessCode` 就直接打开**裸地址** `http://<地址>:<端口>/` 输一次密码；
没设就复制状态文件里**当前**那条带票网址。

如果你**之前明明能进**、现在只看到这句：那是浏览器里那张 DSH cookie 失效了（每次重启 DSH 都会换）。
清掉该站点的 cookie（或用无痕窗口）再打开即可；从当前版本起，插件遇到这种 401 会**自动带当前票重试一次**，
DSH 顺手发一张新 cookie，你不用再手动清。

**输错密码被挡在外面** — 该 IP 已被拉黑。到「设置 → 远程访问 → 排除的网段」里删掉对应那一项
（形如 `100.x.y.z/32`）即可。如果状态文件里「待补写」不为空，说明当时写盘失败、它还没进配置，
那就删掉 `<DSH_HOME>\remote-access-bans.txt` 里的那一行。

**前几天还好，现在又要重新验证** — 换过端口或重启过 DSH。DSH 的 cookie 绑定 `hostname:port`，所以旧的不通用；
按「使用」里的步骤重来一次。

**设置页点了保存没反应 / 报失败** — 跑 `node tools/check-config-schema.mjs`，它会检查写盘的两个硬前提
（`Config` 是原生 Schemastery schema 且字段都标了 `.volatile()`；`package.json` 把
`@deepseek-ai/schemastery` 声明成了 peerDependency）。改完 `package.json` 要重启一次 DSH 才生效。

**手机在选目录里只能看到主目录** — 见上面「为什么只看到主目录」。

## 开发与测试

```bash
node --check index.js                 # 语法
node tools/test-remote-access.mjs     # Host 功能测试（起一个假上游，不需要 DSH）
node tools/test-client.mjs            # 客户端冒烟测试（极简 React / 宿主桩子真跑一遍设置页，不需要浏览器）
node tools/check-config-schema.mjs    # 用安装包里的真 Schemastery 校验 Config（找不到安装包则 SKIP）
```

`test-remote-access.mjs` 覆盖转发、`Host`/`Origin` 改写、`x-forwarded-for`、WebSocket `101` 透传、
网段外 `403`、解锁页与「错一次自动写进排除的网段」（含写盘失败退回暂存）、改密码不踢人、热重载换端口。

`test-client.mjs` 覆盖设置页注册与渲染、回环与手机两条读写通道、保存与失败提示
（Remote 通道返回的是 `{ ok, value }` 信封，这是最容易踩的一处）。

`check-config-schema.mjs` 覆盖设置页写盘的两道硬前提，并顺带对表 `client.js` 的表单字段与 `Config`。

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | 插件 Host 半区（零依赖，只用 `node:` 内置模块） |
| `client.js` | 浏览器半区：设置页里的参数表单 |
| `cordis.patch.yml` | bundle 的 patch：插入插件行、固定选目录器 |
| `package.json` | 清单（`dsh.bundle.patch` / `exports` / `icon` / `meta`） |
| `locale/{zh,en}.json` | 插件页显示用的标题与说明 |
| `icon.svg` | 插件页图标 |
| `tools/` | 测试与从 `app.asar` 取文件的工具 |
| `LICENSE` | MIT |

## 许可

[MIT](LICENSE) © 2026 Mzy123l
