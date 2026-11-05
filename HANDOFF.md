# 交接文档：dsh-plugin-remote-access 移动端改造

> 生成时间：2026-11-06 01:30
> 当前状态：**代码已完全回退到 1.5.0 原始版本**，DSH 可正常启动
> 目标：在 1.5.0 基础上，只做用户明确要求的三件事

---

## 一、用户明确要求的三件事（只做这些，不要扩大范围）

1. **部分 UI 用官方的**
   - 布局完全交给 DSH 0.2.2 的 `@deepseek-ai/dsh-client-ui-layout`
   - 不要自己覆盖网格轨道（`grid-template-columns`）
   - 不要自建抽屉遮罩
   - 左上角图标换成**官方鲸鱼**（Issue #6 要求）

2. **左右滑动手势**
   - 修两个已知 bug：
     - 右栏展开时，在空白处向右滑无法收起
     - 正文有横向滚动块时，会误触发左右栏

3. **完整的返回键逻辑**
   - 层级：官方浮层 → 右栏 → 左抽屉 → 全局面板

**用户原话**：「除了刚刚我明文要求的：部分UI、滑动、返回事件，全部回退至1.5.0」

---

## 二、绝对不要碰的东西（前一轮踩过的坑）

### 2.1 不要加这些 CSS（用户没要求，且出过问题）

| 规则 | 后果 |
|---|---|
| `html[data-ra-phone] button { min-height: 40px }` | 输入区左下角加号从 24×24 被撑成 24×40，变成「跑道形」 |
| `padding-bottom: env(safe-area-inset-bottom)` 加在 `[class*="_centerCol"]` | 输入区高度异常（整个中间列含输入区，被多垫一条空白） |
| 输入框 `font-size: 16px` | 用户没要求 |
| 设置页窄屏字号 | 用户没要求 |

**1.5.0 的输入区只有三条规则，用户要求保持原样：**

```css
html[data-ra-layout="phone"] [data-slot="conversation.composer.bar"] [class*="_card"] {
  padding-left: 10px !important; padding-right: 10px !important;
}
html[data-ra-layout="phone"] [data-slot="conversation.composer.bar"] [class*="_row"] {
  flex-wrap: wrap !important; row-gap: 6px !important;
}
html[data-ra-layout="phone"] [data-slot="conversation.composer.bar"] [class*="_trailing"] {
  flex: 1 1 auto !important; min-width: 0 !important;
}
```

> 注意：`_trailing { flex: 1 1 auto }` 实测会让工具条折行（`WB CN · 2,060` 掉到第二行），
> 但用户明确要求「输入框这块回退到 1.5.0」，所以**保留原样，不要改**。

### 2.2 不要删的配置项

`index.js` 里的 `remoteLayout` 和 `phoneCollapsedRail` **不要删**（用户只说过要删设置页上的两个下拉框，
后来说「全部回退至 1.5.0」，所以配置项本身保留）。

### 2.3 不要动 profile 的 cordis.patch.yml

`C:\Users\15861\.dsh\profiles\desktop\cordis.patch.yml` —— 已经清理过，
不要再往里面加/删 directory-picker 相关条目。

---

## 三、已知问题：directory-picker 服务冲突（**不要再尝试修**）

### 现象

插件页显示「异常」：

```
启用失败：dsh: warning: 1 entry did not activate directory-picker-browse
(@deepseek-ai/dsh-host-directory-picker-browse):
Error: service "directoryPicker" has been registered at <NativeDirectoryPicker>
```

### 根因（已查清，不要重复排查）

1. `dsh-host-directory-picker` 的 seam 基类构造函数里**写死了服务名**：
   ```js
   var DirectoryPicker = class extends Service {
     constructor(ctx) { super(ctx, "directoryPicker"); }
   }
   ```
   `native` 和 `browse` 都继承它 → 抢同一个服务名，只能活一个。

2. DSH 0.2.2 的 `dsh-host-directory-picker-auto` 判定逻辑（`lib/index.js:66-72`）：
   ```js
   if (facts.allowsRemoteAuthorities || !isLoopbackHost(facts.bindHost)) return "browse";
   if (facts.ssh) return "browse";
   if (facts.platform === "darwin" || facts.platform === "win32") return "native";  // ← Windows 命中这条
   if (facts.platform !== "linux" || !facts.linuxChooser) return "browse";
   return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? "native" : "browse";
   ```
   **Windows 上必然返回 `native`**（在电脑屏幕弹系统对话框，手机端会一直等）。

3. **关键**：0.2.2 的 auto 是**运行时动态创建**条目，不是静态 patch 行：
   ```js
   await ctx.effect(async () => {
     for (const name of [BACKEND_PACKAGES[backend], SURFACE_PACKAGES[backend]]) {
       const id = await ctx.loader.create({ name });   // ← 运行时创建
       ...
     }
     return unmount;
   });
   ```
   所以 **`cordis.patch.yml` 里的 `disabled: true` 拦不住它**。
   1.5.0 的 patch 之所以在 0.2.1 上有效，是因为 0.2.1 的 auto 是静态行。

### 已验证无效的方案（不要重试）

- ❌ 在插件 bundle patch 里写 `disabled: true`（当前就是这个，无效）
- ❌ 在 profile patch 里写 `disabled: true`（同样无效）
- ❌ 用 `name` 守卫改行名（`applyPatches` 里 name 是守卫不是赋值，不匹配会静默跳过）
- ❌ 清理 node_modules 里的重复插件副本（已清理，不是原因）

### 唯一可行方向（交给创造模式判断）

在插件 `index.js` 里**抢先注册** browse 后端，让 auto 后注册时失败。
但需要确认这样做不会让 DSH 启动失败（auto 的 `apply` 里 catch 后会 `unmount` 并 rethrow）。

**或者**：接受这个异常，因为插件主体功能（远程访问、手机布局、缓存、通知）都正常，
只影响「手机上选工作区目录」这一个操作。

---

## 四、当前环境事实

| 项 | 值 |
|---|---|
| DSH 版本 | 0.2.2-rc.1（**打包成 `app.asar`**） |
| DSH 安装路径 | `E:\Applications\DeepSeek Harness\` |
| asar 内代码 | `dsh/node_modules/@deepseek-ai/...` |
| 取 asar 文件的工具 | `tools/asar-extract.mjs`（仓库自带） |
| 插件工作区 | `C:\ProgramData\dsh-plugins\dsh-remote-access` |
| 插件在 profile 里的形态 | `SymbolicLink` → 工作区（`pnpm link:` 协议） |
| profile 路径 | `C:\Users\15861\.dsh\profiles\desktop`（本身也是 junction → `C:\Users\Assistant\...`） |
| 端口 | 13888（Tailscale `100.64.0.5`） |
| 访问密码 | 已设置 |

### 注意：DSH 安装形态会在「解包 `app/` 目录」和「打包 `app.asar`」之间变化

本轮遇到过两次。写脚本读 DSH 源码时，先确认当前形态：
```powershell
Get-ChildItem "E:\Applications\DeepSeek Harness\resources" -Force
```

---

## 五、重要：git 仓库反复损坏

`.git` 目录下的 `HEAD`、`config`、`index` 三个文件**多次莫名消失**（`objects`、`refs`、`packed-refs` 完好）。

修复方法：
```powershell
$g = "C:\ProgramData\dsh-plugins\dsh-remote-access\.git"
"ref: refs/heads/feat/mobile-native-layout" | Set-Content "$g\HEAD" -NoNewline -Encoding ascii
# 再写 config，然后：
git -C <repo> -c safe.directory=<repo> reset HEAD -- .
```

**每次改代码前先确认 git 可用**，否则回滚会很困难。

---

## 六、测试命令

```powershell
cd C:\ProgramData\dsh-plugins\dsh-remote-access
node --check client.js
node --check index.js
node tools/test-client.mjs          # 1.5.0 基线：32 条
node tools/test-remote-access.mjs   # 1.5.0 基线：169 条
node tools/check-config-schema.mjs  # 13 条
node tools/check-dsh-compat.mjs     # 15 条
```

---

## 七、1.5.0 的关键实现（供参考）

### 手势（`client.js` 约 L1088-1210）

```js
const EDGE_ZONE = 28;
const MIN_SWIPE = 56;
const MIN_SWIPE_MID = 72;
const RATIO_EDGE = 1.25;
const RATIO_MID = 1.8;
```

现状问题：
- `onTouchStart` 里用 `document.documentElement.hasAttribute('data-ra-drawer')` 判断抽屉
- `onTouchEnd` 里用 `clickLabel('收起侧边栏')` —— **按中文 aria-label 找按钮**，
  英文界面下会找不到（这是要修的点之一）

### 返回键（`client.js` 约 L1292-1385）

```js
const backApi = { version: 1, count: backLayerCount, closeTop: closeTopBackLayer };
window.__dshRaBack = backApi;
```

安卓外壳（`android/`）读这两个函数决定返回键行为。

### 官方可用的 API（0.2.2）

```js
// 布局服务（比点按钮可靠，不受语言影响）
const layout = ctx.get('layout');
layout.toggleSidebar();
layout.openRightbar(track, fullscreen);
layout.closeRightbar();
layout.selectPanel(null);

// 官方稳定属性（不认语言）
'button[data-sidebar-opener]'        // 左上角展开按钮（可换鲸鱼图标）
'button[data-sidebar-right-expand]'  // 右栏展开
'button[data-sidebar-right-toggle]'  // 右栏收起
'[data-sidebar-right-panel]'         // 右栏面板
```

### 鲸鱼 SVG（取自官方 `FISH_LOGO_PATH`）

- viewBox: `0 0 23.16 17.04`
- path 数据 3448 字符，在之前被回退的版本里有过完整内容
- 官方用法：`require("@deepseek-ai/dsh-client-ui-primitives").FishLogo`

---

## 八、用户沟通注意

- 用户要求：**不要自作主张扩大范围**，只做明文要求的事
- 用户对反复解释技术细节不耐烦，**要直接给结论**
- 改任何文件前先备份，改完告知具体改了什么
- **不要触发重启**，让用户自己决定何时重启
