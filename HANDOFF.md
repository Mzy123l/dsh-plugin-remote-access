# 交接文档 —— 给「创造模式」会话

> 先读 `AGENTS.md`（硬约定），再读本文（现状与卡点）。
> 你在创造模式里，**有 `cordis_inspect_query` 和 `plugin_manager`** —— 这两样正是本文卡点需要的。
> **先查再改，不要猜 API**（本文第 3 节给了具体查询清单）。

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

**唯一卡住的问题** ❌

- **设置页里点「保存」写不进配置**（详见第 2 节）。

---

## 2. 卡点：设置页保存写不进配置

### 已试过的通道与结果（都是实测报错）

| 通道 | 结果 |
|---|---|
| `ctx.configForms.get('remote-access').set(field, value)` | 返回 **`false`**（静默拒绝） |
| `ctx.remote.settings.mutate('remote-access', [{ op:'set', path, value }], rev)` | `RemoteError: gateway/input-invalid`，`details: { endpoint: 'settings/mutate', field: 'ops' }` —— **`ops` 元素形状我写错了** |
| `ctx.remote.settings.update(ns, { field: value }, rev)`（ns 依次试 `remote-access`、`@local/dsh-remote-access`） | **已改好但尚未验证**（需要重启 DSH 加载新客户端模块） |

### 重要线索

- 官方文档（安装包 `app.asar` 内）明确写：**"自定义条目页以 Host 条目 id 作为注册 id；行页面使用 bundle 包名和行 id。当条目提供可编辑 Config 字段时，页面宿主传入 `form.state` 和 `form.mutate(operations, expectedRevision)`。"**
  → 也就是说，**带官方写入通道的表单，只发给注册在 `plugins.row.config`（或 `plugins.item`）的页面**；`settings.section` 的页面**不会**自动拿到 `form`。
  → 而用户明确要求**只保留设置里的项**，删掉了 `plugins.row.config` / `plugins.bundle.config` 两处注册。**这正是当前的矛盾点。**
- 客户端能用的插件管理接口**没有写配置的方法**：
  `setPluginEnabled` / `setBundleEnabled` / `removeBundle` / `listBundles` / `listPlugins` / `inspect` / `installBundle` / `waitForInstall` / `cancelInstall` / `registries`；
  `remote.pluginInventory.list()` 也只有 `list()`。

### 两条出路（建议先查证再选）

1. **查清 `settings.update` 的 ns 与语义**：如果 `remote-access` 确实是"被服务的设置命名空间"，`update` 就能写（并且会触发插件重挂载 → 新参数生效）；
2. **改由 Host 半区写盘**：Host 有文件权限，可以
   - 直接改写 profile 的 `cordis.patch.yml`（需 YAML 处理，风险高），**或**
   - 写自己的覆盖文件（例如 `<DSH_HOME>/remote-access-config.json`），Host 启动时读它并覆盖 row config；客户端通过 **`host.call` / Host⇄Client 通道**把新参数送过去。
   官方给的通道是：Host 半区用 `harness.handle(method, fn)` 注册处理器，浏览器半区用 `host.call(method, args)` 调用（**只传 JSON**）。**注意**：这条 API 出现在安装包的"浏览器半区"文档里（浏览器半区拿到固定的 `React` / `console` / `styles` / `host`），**本项目现在的客户端是 module-loader 形态（`window.__ModuleLoader__.load({id, factory(require)})`），是否也能拿到 `host` 尚未验证** —— 用 `cordis_inspect_query` 查证。
   好处：Host 半区可以**即时重挂载**（关旧监听、按新参数重开），做到"保存即生效"，不必动 profile 文件。

---

## 3. 下一步：用 `cordis_inspect_query` 查这些（按顺序）

1. **Client `ctx.configForms`**：`get(entryId)` 返回的 scope 对象有哪些方法？`set` / `unset` / `mutate` / `snapshot`（或 `getSnapshot` / `describe`）的**确切签名**；`mutate` 的 `ops` 元素 schema；`whileServed(namespaces, register)` 的签名与语义；以及"哪些命名空间会被服务"。
2. **Client `ctx.remote.settings`**：`settings/update`、`settings/mutate`、`settings/replace`、`settings/describe` 的输入 schema（尤其 `ops` 的元素类型与 `ns` 的合法取值）。
3. **槽位 props**：`settings.section` 与 `plugins.row.config` 注册的组件**会被传入哪些属性**（`form.state` / `form.mutate` / `entryKey` / `view` …）；`plugins.row.config` 的 `key` 语义（`<包名>#<行id>`）。
4. **Host `Config.listConfigs`**：本插件（`@local/dsh-remote-access`）的 `packageDir` 与 schema 是否被识别（确认 `Config` 声明真的生效）。
5. **Host⇄Client 通道**：module-loader 形态的浏览器半区能否使用 `host.call`；若不能，正确的等价物是什么（`wire` / `@Remote` 定义？）。

**判定目标**：让「设置 → 远程访问」这一页**真的能写盘**。若结论是"必须用 `plugins.row.config` 的宿主 `form`"，请回头跟用户确认是否接受恢复那一处注册；若结论是"Host 自写盘可行"，按第 2 节方案 2 实施。

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
| `Config` 声明 | `export const Config = Schema.object({…})`（`Schema` 来自 `@deepseek-ai/cordis`，运行时能解析；纯 node 环境解析不到，用动态 import + 兜底）。字段可 `.description()`、`.default()`、`.min()/.max()`、`Schema.natural()`、`Schema.array(...)` |
| config 入参形态 | 声明 `Config` 后，`apply` 拿到的 config 可能是 **Schema 字段引用**，读值要用 `.get()` 兜底（本插件已做） |
| 改代码的生效条件 | **换 JS 必须重启 DSH**（热重载只重组配置，不换模块代）；`cordis.patch.yml` / home patch 的改动会触发重组（可热生效） |
| 重启的副作用 | 每次重启换 **token**（带票网址失效）与**随机端口**（除非 `port` 固定）；DSH 的 cookie **绑定 hostname:port** → 改端口后手机上要重新打开一次带票网址 |
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

1. **[当前卡点]** 让设置页「保存」真正落盘（第 2、3 节）。
2. 建议把 `port` 固定（例如 `19388`），否则手机网址每次重启都变。
3. `README.md` 的"怎么改参数"一节还是旧的（只写了改 `cordis.patch.yml`），需要补上"设置 → 远程访问"这一页。
4. 可选：命令行工具（`E:\Applications\dsh-remote-access`）——按参数启动 DSH、已在跑则改参数（用户提过，但 GUI 优先）。
5. 可选：客户端页面显示**当前生效的带票网址**（现在只能读文件）。需要 Host⇄Client 数据通道。
