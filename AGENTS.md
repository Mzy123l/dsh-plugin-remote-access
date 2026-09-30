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
```

## 安装与生效

- 装：DSH 插件页 → 添加插件 → 填本目录绝对路径；或 `dsh plugin --profile desktop add <路径>`
  （DSH 正在运行时 profile 写锁会占住 CLI，那就走 GUI）。
- **改过 `index.js` 后必须重启 DSH**：热重载只重组合配置，不换代码的模块代。
- 看效果：`<DSH_HOME>\remote-access-url.txt` —— 含带票网址、生效配置、上游探测与自检诊断。

## 现状（2026-09-30）

**Host 半区已完成** ✅：只监听允许网段内的本机地址、网段外对端 403、HTTP/WS 透传、Host+Origin 改写、
带 token 网址写入状态文件、上游自检重试 8×2 秒、失败必写状态文件、`ctx.effect` 关监听；
独立测试 **10/10** 通过。手机侧已实测：带票网址 → 303 → cookie → 200；无票 401；网段外 403。

**Client 半区（`client.js`）已能渲染** ✅：注册进 `settings.section`，设置左侧导航出现「远程访问」一页。

**唯一卡点** ❌：设置页点「保存」写不进配置（`configForms.set` 返回 false；`settings.mutate` 的 `ops` 形状被
判非法；已改试 `settings.update(ns, patch, rev)`，**尚未验证**）。

👉 **细节、报错原文、以及要给「创造模式」会话用的查询清单，见 `HANDOFF.md`**（那里还列了已确认的
DSH 内部事实：槽位形状、`inject` 点号规则、settings Remote 签名等）。

**关键教训**：客户端 `inject` 必须写点号全名（`'remote.pluginManager'`、`'remote.settings'`），
只写 `'remote'` 会在访问时报 `without inject`；改 JS 后**必须重启 DSH**。

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | 插件本体（Host 半区，零依赖） |
| `client.js` | 浏览器半区（module-loader 形态）：设置页里的参数表单 |
| `HANDOFF.md` | 交接文档：现状、卡点、给创造模式会话的查询清单 |
| `cordis.patch.yml` | bundle 的 patch：插入 `remote-access` 一行 + 默认配置 |
| `package.json` | 清单（`dsh.bundle.patch` / `exports` / `icon` / `meta`） |
| `tools/` | `test-remote-access.mjs` 功能测试；`asar-extract.mjs` 从 `app.asar` 取文件 |
| `docs/` | DSH 官方插件开发文档（本地参考，**已 gitignore，勿提交**） |
