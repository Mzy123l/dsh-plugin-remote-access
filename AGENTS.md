# dsh-remote-access — 项目约定与现状

给 **DSH（DeepSeek Harness）桌面版**用的「限网段远程访问入口」插件：让手机 / 另一台设备在指定网段
（默认 Tailscale `100.64.0.0/10`）通过一条带令牌的网址打开本机 DSH 的网页界面。

## 硬约定

- 中文注释、中文提交信息；变量名 / 函数名保持英文。
- **不要把地址写死**：网段、监听地址、端口、上游端口一律走 `Config`（`cordis.patch.yml` 的 `config`）。
- 零依赖：只用 `node:` 内置模块（装进 profile 不拉任何第三方包）。
- **安全边界不许放松**：只监听 `allowCidrs` 内的本机地址（永不 `0.0.0.0`）；对端也必须在 `allowCidrs` 内；
  不绕过 DSH 自己的令牌 / cookie。要改这些地方先说清理由。
- **失败必须可见**：任何提前退出都要写状态文件（`<DSH_HOME>/remote-access-url.txt`），不许"哑巴失败"。

## 常用命令

```bash
node --check index.js                 # 语法检查
node tools/test-remote-access.mjs     # 独立功能测试（起假上游，无需 DSH）
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
独立测试 **10/10** 通过。手机侧已实测：带票网址 → 303 → cookie → 200；无票 401；网段外 403。

**Client 半区（`client.js`）已完成** ✅：注册进 `settings.section`，设置左侧导航出现「远程访问」一页，
参数读写走官方通道 `ctx.configForms.get('remote-access')`（`getSnapshot` 读、`mutate([{op:'set',path:[key],value}], revision)` 原子写）。

**设置页保存已修好** ✅（原卡点的根因见下）。**待用户重启 DSH 后实测一次**（换 JS 必须重启）。

**根因（原来写不进去的原因）**：Host 的设置文档只服务「`Config` 是原生 Schemastery schema、且含
`.volatile()` 字段」的条目（`@deepseek-ai/dsh-settings` 的 `volatileForm` / `isVolatilePath`）。
`@deepseek-ai/dsh-app-boot` 的 `isNativeConfigSchema` 认的是 `Symbol.for('schemastery')`，而真包名是
**`@deepseek-ai/schemastery`**（不是 `cordis`）。原来 `import('@deepseek-ai/cordis')` 取 `Schema`
得到 undefined → `Config` 没导出 → `Config.listConfigs` 里这一行 `status: "absent"` → 命名空间从不出现
→ `configForms.set` 静默返回 false。

**关键教训**：
- 客户端 `inject` 必须写点号全名（`'remote.pluginManager'`、`'remote.settings'`），只写 `'remote'` 会报 `without inject`；
- 这两个 `remote` 面孔现在已不需要：读写都走 `configForms`（它内部持有 `remote.settings`）；
- 改 JS 后**必须重启 DSH**；
- 提参数前先看 `Config.listConfigs` 里这一行的 `status`：不是 `schema` 就说明 Host 还不服务它。

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | 插件本体（Host 半区，零依赖） |
| `client.js` | 浏览器半区（module-loader 形态）：设置页里的参数表单 |
| `HANDOFF.md` | 交接文档：现状、原卡点的根因判断链、已查明的 DSH 内部事实 |
| `cordis.patch.yml` | bundle 的 patch：插入 `remote-access` 一行 + 默认配置 |
| `package.json` | 清单（`dsh.bundle.patch` / `exports` / `icon` / `meta`） |
| `tools/` | `test-remote-access.mjs` 功能测试；`check-config-schema.mjs` Config 校验；`asar-extract.mjs` 从 `app.asar` 取文件 |
| `docs/` | DSH 官方插件开发文档（本地参考，**已 gitignore，勿提交**） |
