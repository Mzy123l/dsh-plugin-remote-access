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

- 插件已装进共享 profile（`C:\Users\Assistant\.dsh\profiles\desktop`；本用户经 junction 指向它）。
- 已在本机 tailnet 地址（100.64.0.0/10 内）上成功监听；**不带令牌的请求被 DSH 挡成 401**（边界成立）。
- 已修两处：缺 `inject: ['connection']`（否则铸不出带票网址）、上游自检改为重试 8 次 × 2 秒（避免界面晚起误报）。
- **待办**：重启一次 DSH 让新代码生效，确认状态文件里出现完整的 `?token=...` 网址；手机打开一次换 cookie。

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | 插件本体（Host 半区，零依赖） |
| `cordis.patch.yml` | bundle 的 patch：插入 `remote-access` 一行 + 默认配置 |
| `package.json` | 清单（`dsh.bundle.patch` / `exports` / `icon` / `meta`） |
| `tools/` | `test-remote-access.mjs` 功能测试；`asar-extract.mjs` 从 `app.asar` 取文件 |
| `docs/` | DSH 官方插件开发文档（本地参考，**已 gitignore，勿提交**） |
