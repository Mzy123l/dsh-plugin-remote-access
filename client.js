/**
 * dsh-plugin-remote-access 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
 *
 * 注册位置：settings.section（设置左侧导航的一页）。
 *
 * **唯一配置源**：`$DSH_HOME/remote-access-config.json`。
 * 本页不再走 DSH 的 configForms / ctx.remote.settings —— 那些读写的是共享 profile 的
 * `cordis.patch.yml`，多个 Windows 用户共用一个 profile 时会互相覆盖。
 *
 * 读写都走本插件自己的 `/__remote_access__/config`：
 *   · GET  → { ok, path, revision, config }
 *   · POST ← { patch: {字段: 值}, revision } → { ok, path, revision, config }
 * 本机（回环）页面由上游 webServer 上的同路径路由回答；手机页面由代理转发（先过访问门）。
 * 两种页面看到的是同一份本用户 JSON，写盘完成才回执。
 *
 * 页面上只说人话：失败给一句「下一步做什么」，内部状态只写开发者控制台。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Active UI language. DSH's own locale layer keeps `<html lang>` in sync
     * (zh -> "zh-CN", en -> "en"), so the plugin follows it instead of adding a
     * second language setting that could disagree with the app around it.
     *
     * **响应式**：早先这里是一个算一次就定死的常量，用户把 DSH 切成英文后插件这一节不会跟着变，
     * 必须刷新页面才生效。现在改成「读当前值」的函数 + 一份订阅者名单：
     * `bindLocale()` 在 apply 里订阅 locale 快照（拿不到就退回监听 locale/change 事件），
     * 语言真的变了才重算 LANG 并通知订阅者（设置面板重渲染、挂载时注册的 section 标签原地改写）。
     * 读不到 document 的环境（测试桩子）一律算 zh，与之前完全一致。
     */
    function detectLang() {
      try {
        return /^en/i.test(document.documentElement.lang || '') ? 'en' : 'zh';
      } catch {
        return 'zh';
      }
    }

    let LANG = detectLang();

    /** 语言变化的订阅者：拿到新语言就重渲染（设置面板 / 已经挂上去的 section 标签） */
    const langListeners = new Set();
    function onLangChange(fn) {
      langListeners.add(fn);
      return () => langListeners.delete(fn);
    }
    function setLang(next) {
      if (next === LANG) return;
      LANG = next;
      for (const fn of [...langListeners]) {
        try { fn(LANG); } catch { /* 订阅方自己的问题 */ }
      }
    }

    /**
     * 把语言接到 DSH 的 locale 服务上。三条途径，按可靠性排序：
     *   1. `ctx.get('locale')` 的 getSnapshot/subscribe —— 与官方组件同一口径（LocaleFace）；
     *   2. `locale/change` 事件（只带 active id）；
     *   3. **监听 `<html lang>` 属性变化**（MutationObserver）—— 这是最兜底、也最可靠的一条：
     *      官方的 syncDocumentLanguage 一定会把结果写到这个属性上，而前两条都依赖
     *      「能拿到 locale 服务 / 能收到事件」，插件没声明 inject 时根本拿不到。
     *
     * 为什么必须有第 3 条：`<html>` 在静态 HTML 里就带着 `lang="en"`（DSH 的 index.html 写死），
     * 而模块加载发生在 locale 同步**之前** —— 于是 `detectLang()` 读到 en、`LANG` 定成 en，
     * 之后官方把它改成 zh-CN 时如果我们没在听，这个错误就会一直留着。
     * 后果不只是文案语言：`clickLabel('Collapse sidebar')` 会去点一个根本不存在的英文按钮，
     * 于是抽屉关不掉、遮罩一直盖着、手势与返回键全部失效。**这是它最严重的一次表现。**
     */
    function bindLocale(ctx) {
      let off = null;
      const applyActive = (active) => {
        if (active) setLang(/^en/i.test(active) ? 'en' : 'zh');
        else setLang(detectLang());
      };
      try {
        const locale = typeof ctx?.get === 'function' ? ctx.get('locale') : null;
        if (locale && typeof locale.subscribe === 'function') {
          const read = () => {
            try {
              const snap = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
              if (snap && typeof snap.active === 'string') return snap.active;
            } catch { /* 退回 html lang */ }
            return null;
          };
          off = locale.subscribe(() => applyActive(read()));
        }
      } catch { /* 忽略：没有 locale 服务 */ }
      if (typeof off !== 'function') {
        try {
          off = ctx.on('locale/change', (snapshot) => {
            applyActive(typeof snapshot === 'string' ? snapshot : snapshot?.active);
          });
        } catch { /* 忽略 */ }
      }
      // 兜底 1：先按当前 DOM 校正一次（模块加载与 apply 之间语言可能已经定了）
      setLang(detectLang());
      // 兜底 2：盯住 <html lang>。官方每次同步语言都会写这个属性，
      // 所以哪怕上面两条都拿不到，这里也一定能跟上。没有 MutationObserver 的环境安静跳过。
      let observer = null;
      try {
        if (typeof MutationObserver === 'function' && document?.documentElement) {
          observer = new MutationObserver(() => setLang(detectLang()));
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        }
      } catch { /* 忽略 */ }
      return () => {
        try { if (typeof off === 'function') off(); } catch { /* 忽略 */ }
        try { if (observer) observer.disconnect(); } catch { /* 忽略 */ }
      };
    }

    /**
     * English copy, keyed by the Chinese source string (gettext-style msgid),
     * so call sites stay untouched and a missing entry falls back to the source
     * text instead of rendering an empty label.
     */
    const EN = {
      "服务": "Service",
      "收起侧边栏": "Collapse sidebar",
      "出厂值": "Factory default",
      "详细": "Detailed",
      "手机通知": "Phone notifications",
      "收起右侧边栏": "Collapse right sidebar",
      "换行分割": "newline-separated",
      "远程界面": "Remote UI",
      "外观": "Appearance",
      "字号大小": "Font size",
      "工作步骤展示": "Work step display",
      "简洁": "Compact",
      "显示代码工作视图": "Show code work view",
      "性能与用量": "Performance & usage",
      "保存中…": "Saving…",
      "启用": "Enabled",
      "关掉即停止监听，不需要卸载插件": "Turning this off stops the listener; no need to uninstall the plugin",
      "端口": "Port",
      "0=随机": "0 = random",
      "固定下来才好存书签（默认 0 = 系统随机）": "Pin it to keep a bookmarkable URL (default 0 = OS-assigned)",
      "允许的网段": "Allowed network ranges",
      "唯一的安全边界；listen=auto 时也用它挑本机要监听的地址": "The only security boundary; with listen=auto it also picks which local address to bind",
      "排除的网段": "Excluded network ranges",
      "白名单里的例外；输错访问密码的地址会自动加到这里，删掉即解封": "Exceptions to the allowlist; an address that fails the access code is added here automatically - delete it to unblock",
      "并发上限": "Connection limit",
      "0=不限制": "0 = unlimited",
      "日志级别": "Log level",
      "静默": "Silent",
      "普通": "Normal",
      "访问控制": "Access control",
      "访问密码": "Access code",
      "4-12位数字或字母": "4-12 digits or letters",
      "设了它就不用复制 token：手机开裸地址输一次即可；输错一次即拉黑该地址": "Set it and you never copy a token: open the bare address on the phone and enter it once. One wrong entry blocks that address.",
      "提问时通知手机": "Notify the phone when the model asks",
      "模型提问（ask_user_question）且没人回答时，让 App 弹状态栏通知": "Have the app raise a status-bar notification when the model asks a question (ask_user_question) and nobody answers",
      "一轮结束时通知手机": "Notify the phone when a turn ends",
      "正常跑完与异常结束都算；异常会带上分类（模型输出格式错 / 余额额度不足 / 网络连不上 / 被限流…）": "Covers normal completion and failures; failures carry a category (malformed model output / out of balance or quota / network unreachable / rate limited...)",
      "仅窗口不可见时通知": "Only when the window is hidden",
      "电脑上 DSH 窗口可见时不打扰；关掉则只要 App 不在前台就提醒": "No interruption while the DSH window is visible; turn this off and the app reminds you whenever it is not in the foreground",
      "远程UI布局": "Remote UI layout",
      "手机（横竖屏自适应）": "Phone (adapts to orientation)",
      "电脑": "Desktop",
      "自动": "Auto",
      "只作用于远程页面，本机界面不受影响；改完手机端立刻生效，不用刷新": "Affects remote pages only; the local UI is untouched. Takes effect on the phone immediately, no refresh needed",
      "手机端回车=换行": "Enter inserts a newline on the phone",
      "只有点「发送」才发送；Ctrl/Cmd+Enter 仍是发送，输入法合成中一律放行": "Only the Send button sends; Ctrl/Cmd+Enter still sends, and IME composition always passes through",
      "浅色": "Light",
      "深色": "Dark",
      "跟随系统": "Follow system",
      "10-22，0=出厂值": "10-22, 0 = factory default",
      "标准": "Standard",
      "完全展开": "Fully expanded",
      "开启": "On",
      "关闭": "Off",
      "启用手机端资源缓存": "Enable on-phone asset caching",
      "新鲜期（分钟）": "Freshness (minutes)",
      "1-1440，默认 10": "1-1440, default 10",
      "过期核对用首/尾片段指纹": "Revalidate with first/last chunk fingerprints",
      "接管 no-store 的大媒体": "Take over large no-store media",
      "整段 Range 视为整份": "Treat a full-range request as the whole file",
      "当前页面没有 fetch": "This page has no fetch",
      "收起态图标栏": "Collapsed sidebar rail",
      "保留图标栏（默认）": "Keep the icon rail (default)",
      "整条收起，只留悬浮按钮": "Collapse entirely, floating button only",
      "整条收起时正文占满全宽，左上角留一枚悬浮的官方展开按钮；点它照旧打开抽屉": "When collapsed the content takes the full width and only a floating official expand button stays in the top-left corner; tapping it opens the drawer as before",
      "分栏": "Split view",
      "退出全屏": "Exit fullscreen",
      "左抽屉": "Left drawer",
      "右栏": "Right sidebar",
      "打开侧边栏": "Open sidebar",
      "打开右侧边栏": "Open right sidebar",
      "电脑上的插件还没有通知接口（1.3.1 起才有）→ 更新插件并重启一次 DSH": "The plugin on the computer has no notification endpoint yet (added in 1.3.1) - update the plugin and restart DSH once",
      "通知接口需要重新解锁：刷新本页、再输一次访问密码": "The notification endpoint needs a fresh unlock: refresh this page and enter the access code again",
      "电脑上关掉了「提问时通知手机」": "Notify the phone when the model asks is turned off on the computer",
      "电脑上的插件已支持提问通知 ✓": "The plugin on the computer supports question notifications ✓",
      "读不到电脑上的插件状态": "Cannot read the plugin status on the computer",
      "本机页面不走这个缓存代理：手机上打开这一组时，这里会显示那边实际生效的口径": "This local page does not go through the cache proxy; open this section on the phone to see the policy actually in effect there",
      "电脑上的插件还没有缓存接口（1.3.8 起才有）→ 更新插件并重启一次 DSH": "The plugin on the computer has no cache endpoint yet (added in 1.3.8) - update the plugin and restart DSH once",
      "缓存接口需要重新解锁：刷新本页、再输一次访问密码": "The cache endpoint needs a fresh unlock: refresh this page and enter the access code again",
      "电脑上关掉了手机端缓存": "On-phone caching is turned off on the computer",
      "读不到电脑上的缓存状态": "Cannot read the cache status on the computer",
      "访问密码没改：只接受 4–12 位数字或字母（不能有空格和符号）。": "Access code not changed: only 4-12 digits or letters are accepted (no spaces or symbols).",
      "没有改动。": "No changes.",
      "写入被拒绝（配置在别处被改过），请点「重新读取」后再试一次。": "Write rejected (the config was changed elsewhere). Click Reload and try again.",
      "[remote-access] 保存失败": "[remote-access] save failed",
      "本页无需套用": "Nothing to apply on this page",
      "保存后，在远程页面打开时生效（本机界面不受影响）": "Applied to remote pages after saving (the local UI is untouched)",
      "开 · 已接管": "On · taken over",
      "生效策略": "Effective policy",
      "内容寻址产物": "Content-addressed assets",
      "immutable（一年内不重取）": "immutable (not re-fetched for a year)",
      "其它静态资源": "Other static assets",
      "过期核对": "Revalidation",
      "长度 + 类型": "Length + type",
      "首/尾各 64 KB 片段指纹": "First/last 64 KB fingerprints",
      "no-store 大媒体": "no-store large media",
      "尊重上游": "Respect upstream",
      "整段 Range": "Full-range requests",
      "原样透传 206": "Pass 206 through",
      "正文落盘": "Body on disk",
      "不落宿主盘（零字节）": "Never on the host disk (zero bytes)",
      "本次会话": "This session",
      "304（零字节）": "304 (zero bytes)",
      "小资源缓冲": "Small-asset buffering",
      "片段探针": "Chunk probes",
      "接管 no-store": "no-store takeover",
      "本轮流量账（按 URL 排字节）": "Traffic this round (bytes by URL)",
      "送出 / 收到": "Sent / received",
      "送出": "Sent",
      "次数": "Count",
      "读取中…": "Loading…",
      "刷新": "Refresh",
      "处理中…": "Working…",
      "清零本轮统计": "Reset this round",
      "用法：点「清零本轮统计」→ 完全退出 App（从最近任务划掉）→ 重新打开，回来后这里显示的就是那一轮的真实花费。": "Usage: click Reset this round -> fully quit the app (swipe it off recents) -> open it again; what you see here is that round's real cost.",
      "实时轮询（如音频频谱）与会话通道（聊天图片走的 RPC）不在缓存射程内，它们出现大数字属正常。": "Live polling (audio spectra) and the session channel (the RPC that carries chat images) are outside the cache's reach; large numbers there are expected.",
      "UI 设置": "UI settings",
      "缓存": "Cache",
      "保存": "Save",
      "重新读取": "Reload",
      "（每个 Windows 用户各一份；插件不读也不写共享 profile）。": "(one per Windows user; the plugin never reads or writes the shared profile).",
      "远程访问": "Remote access",
    };

    /** @param {string} source @returns {string} */
    const t = (source) => (LANG === 'en' && Object.prototype.hasOwnProperty.call(EN, source) ? EN[source] : source);

    // settings.section 的注册 id（与 bundle patch 的行 id 一致，便于排查）。
    const NS = 'remote-access-cidr';

    /**
     * 本页客户端代码的版本（与 package.json 对齐；`tools/test-client.mjs` 有一条断言钉着它）。
     *
     * 为什么页面上要显示出来：手机这一端跑的代码是**服务端按请求发过来的**，插件更新之后
     * 页面必须刷新才会换上新的一份 —— 只看「我把插件升级了」是看不出这件事的。
     * 1.3.2 那次就撞在这上面：代码推上去了、版本号也对了，但手机上跑的还是上一份，
     * 表现成「这个功能根本不存在」。所以设置页底部把「本页客户端版本」与
     * 「电脑那边的通知接口在不在」一起写出来 —— 这两句话能省掉一整轮排查。
     */
    const CLIENT_VERSION = '1.6.0';

    // 表单字段（配置只存在本用户 JSON 里；Host 用 DEFAULTS 做同样的归一化）
    //
    // 为什么是一个函数而不是常量：字段里的 label / section / hint 都是 t() 的结果，
    // 而语言现在可以在运行期变化（见 bindLocale）。做成函数后，语言一变就重建一次，
    // 下次渲染拿到的就是新语言；否则这一片永远是「模块加载时那种语言」。
    function buildFields() {
      return [
      // 分节（section）只是版式：让设置页读起来像一份配置清单，而不是一串控件。
      // 每一节标题下面是同类参数；`hint` 是字段下方那行小字（手机上比 placeholder 好读）。
      { key: 'enabled', type: 'boolean', section: t('服务'), label: t('启用'), hint: t('关掉即停止监听，不需要卸载插件') },
      { key: 'port', type: 'number', section: t('服务'), label: t('端口'), placeholder: t('0=随机'), hint: t('固定下来才好存书签（默认 0 = 系统随机）') },
      { key: 'allowCidrs', type: 'list', section: t('服务'), label: t('允许的网段'), placeholder: t('换行分割'), hint: t('唯一的安全边界；listen=auto 时也用它挑本机要监听的地址') },
      { key: 'denyCidrs', type: 'list', section: t('服务'), label: t('排除的网段'), placeholder: t('换行分割'), hint: t('白名单里的例外；输错访问密码的地址会自动加到这里，删掉即解封') },
      { key: 'maxConnections', type: 'number', section: t('服务'), label: t('并发上限'), placeholder: t('0=不限制') },
      {
        key: 'logLevel',
        type: 'select',
        section: t('服务'),
        label: t('日志级别'),
        options: [
          { value: 'silent', label: t('静默') },
          { value: 'info', label: t('普通') },
          { value: 'debug', label: t('详细') },
        ],
      },
      { key: 'accessCode', type: 'password', section: t('访问控制'), label: t('访问密码'), placeholder: t('4-12位数字或字母'), hint: t('设了它就不用复制 token：手机开裸地址输一次即可；输错一次即拉黑该地址') },
      // 安卓外壳的状态栏通知：宿主只负责回答「有没有选择在等 / 电脑窗口可见吗」，
      // 弹不弹、弹什么由 App 自己决定（它才知道自己在不在前台）
      { key: 'notifyOnChoice', type: 'boolean', section: t('手机通知'), label: t('提问时通知手机'), hint: t('模型提问（ask_user_question）且没人回答时，让 App 弹状态栏通知') },
      { key: 'notifyOnFinish', type: 'boolean', section: t('手机通知'), label: t('一轮结束时通知手机'), hint: t('正常跑完与异常结束都算；异常会带上分类（模型输出格式错 / 余额额度不足 / 网络连不上 / 被限流…）') },
      { key: 'notifyOnlyWhenWindowHidden', type: 'boolean', section: t('手机通知'), label: t('仅窗口不可见时通知'), hint: t('电脑上 DSH 窗口可见时不打扰；关掉则只要 App 不在前台就提醒') },
      {
        key: 'remoteLayout',
        type: 'select',
        section: t('远程界面'),
        label: t('远程UI布局'),
        options: [
          { value: 'phone', label: t('手机（横竖屏自适应）') },
          { value: 'desktop', label: t('电脑') },
          { value: 'auto', label: t('自动') },
        ],
        hint: t('只作用于远程页面，本机界面不受影响；改完手机端立刻生效，不用刷新'),
      },
      // 收起态的侧栏形态：是留一条 48px 图标栏（现状），还是整条收成 0 宽、只在左上角留一枚悬浮的官方展开按钮。
      // 与 remoteLayout 是两个维度：同一个手机档下，有人要图标栏，有人要满宽正文。
      {
        key: 'phoneCollapsedRail',
        type: 'select',
        section: t('远程界面'),
        label: t('收起态图标栏'),
        options: [
          { value: 'show', label: t('保留图标栏（默认）') },
          { value: 'hide', label: t('整条收起，只留悬浮按钮') },
        ],
        hint: t('整条收起时正文占满全宽，左上角留一枚悬浮的官方展开按钮；点它照旧打开抽屉'),
      },
      // 手机端输入：回车当成换行，只有点「发送」才真的发出去。
      // 为什么单独给一个开关：有人用外接键盘、或就是习惯回车发送；默认按手机的习惯来。
      { key: 'phoneEnterNewline', type: 'boolean', section: t('远程界面'), label: t('手机端回车=换行'), hint: t('只有点「发送」才发送；Ctrl/Cmd+Enter 仍是发送，输入法合成中一律放行') },
      // 「UI 设置」一组（group: 'ui'）：官方「通用设置」里的五项界面偏好，只作用于远程页面。
      // 为什么要有这一份副本：官方设置页在远程页面上是内存态（读写都到不了宿主），手机端改了刷新就还原；
      // 这里存的是同一批值，由 startUiSettingsController 在每次打开远程页面时重新套到页面上。
      // 'default' 一律 = 出厂值（跟着官方默认走），所以默认状态下这一组不做任何事。
      {
        key: 'remoteTheme',
        type: 'select',
        group: 'ui',
        label: t('外观'),
        options: [
          { value: 'default', label: t('出厂值') },
          // 顺序照官方那行来（THEME_PREFERENCES = light / dark / system），我们不要自作主张换个先后
          { value: 'light', label: t('浅色') },
          { value: 'dark', label: t('深色') },
          { value: 'system', label: t('跟随系统') },
        ],
      },
      { key: 'remoteFontSize', type: 'number', group: 'ui', label: t('字号大小'), placeholder: t('10-22，0=出厂值') },
      {
        key: 'remoteTranscriptView',
        type: 'select',
        group: 'ui',
        label: t('工作步骤展示'),
        options: [
          { value: 'default', label: t('出厂值') },
          { value: 'compact', label: t('简洁') },
          { value: 'standard', label: t('标准') },
          { value: 'detailed', label: t('详细') },
          { value: 'verbose', label: t('完全展开') },
        ],
      },
      {
        key: 'remoteDeveloperTools',
        type: 'select',
        group: 'ui',
        label: t('显示代码工作视图'),
        options: [
          { value: 'default', label: t('出厂值') },
          { value: 'on', label: t('开启') },
          { value: 'off', label: t('关闭') },
        ],
      },
      {
        key: 'remotePerformanceUsage',
        type: 'select',
        group: 'ui',
        label: t('性能与用量'),
        options: [
          { value: 'default', label: t('出厂值') },
          { value: 'compact', label: t('简洁') },
          { value: 'detailed', label: t('详细') },
        ],
      },
      // 「缓存」一组（group: 'cache'）：手机端资源缓存的口径。缓存本体在手机的 WebView 里，
      // 宿主只负责把响应头喂对（详见 index.js 的「手机端缓存策略」与 README 同名一节）。
      { key: 'cacheEnabled', type: 'boolean', group: 'cache', label: t('启用手机端资源缓存') },
      { key: 'cacheTtlMinutes', type: 'number', group: 'cache', label: t('新鲜期（分钟）'), placeholder: t('1-1440，默认 10') },
      { key: 'cacheProbe', type: 'boolean', group: 'cache', label: t('过期核对用首/尾片段指纹') },
      // 默认关：这是**逆着上游意愿**的一步（壁纸那类实时抓帧自己写了 no-store），
      // 开着最多会看到「新鲜期」这么久之前的旧帧/旧音轨，所以必须由用户显式打开。
      { key: 'cacheOverrideNoStore', type: 'boolean', group: 'cache', label: t('接管 no-store 的大媒体') },
      // 媒体元素取大文件时会发 Range，而浏览器**永远不缓存 206** —— 于是每次进页面都重下整段。
      // 这一项把「从 0 取到结尾」那一种改写成可缓存的整份。默认关：个别播放器可能失去拖动定位。
      { key: 'cacheFullRange', type: 'boolean', group: 'cache', label: t('整段 Range 视为整份') },
      ];
    }

    /** 当前语言下的字段表。设置面板每次渲染都取一次，所以语言变了立刻就是新的。 */
    let FIELDS = buildFields();
    // 语言一变就重建字段表；之后面板重渲染（或下一次读 FIELDS）拿到的是新语言。
    onLangChange(() => { FIELDS = buildFields(); });

    const DEFAULTS = {
      enabled: true,
      allowCidrs: [],
      denyCidrs: [],
      port: 0,
      maxConnections: 0,
      logLevel: 'info',
      accessCode: '',
      remoteLayout: 'auto',
      phoneEnterNewline: true,
      phoneCollapsedRail: 'show',
      // 通知这三个也要有出厂值：`decode` 读不到就退回这里，否则「宿主默认开着」会被显示成没开
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
    };

    /** 访问密码的规则，必须与 index.js 的 normalizeAccessCode 一致（check-config-schema 之外的人工约定） */
    const ACCESS_CODE_RE = /^[A-Za-z0-9]{4,12}$/;

    const listToText = (v) => (Array.isArray(v) ? v.join('\n') : v === undefined || v === null ? '' : String(v));
    const textToList = (t) =>
      String(t ?? '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

    function encode(field, raw) {
      if (field.type === 'boolean') return raw === true;
      if (field.type === 'number') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
      }
      if (field.type === 'list') return textToList(raw);
      return String(raw ?? '');
    }

    function decode(field, value) {
      if (value === undefined || value === null) return DEFAULTS[field.key];
      if (field.type === 'list') return listToText(value);
      if (field.type === 'boolean') return value === true;
      return value;
    }

    /** 输入框里显示什么：0 显示成空（好让占位符露出来） */
    const displayValue = (field, value) => {
      if (field.type === 'number') return Number(value) === 0 ? '' : String(value);
      if (field.type === 'boolean') return value === true;
      return value === undefined || value === null ? '' : value;
    };

    /** 人看的字节数（缓存自检 / 流量账那几行用） */
    function humanBytes(value) {
      const n = Number(value) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    function draftFrom(value) {
      const source = value && typeof value === 'object' ? value : {};
      const next = {};
      for (const field of FIELDS) next[field.key] = decode(field, source[field.key]);
      return next;
    }

    // ---------------------------------------------------------------- 本用户配置的唯一读写通道
    //
    // 配置只存在宿主那台机器的 `$DSH_HOME/remote-access-config.json`。本页通过插件自己的
    // `/__remote_access__/config` 读写它；不碰 DSH 的 configForms / ctx.remote.settings
    // （那两个读写的是共享 profile，多个 Windows 用户共用时会互相覆盖）。
    const CONFIG_ENDPOINT = '/__remote_access__/config';

    function createConfigStore() {
      let snapshot = { status: 'loading', writable: true, revision: undefined, value: undefined, path: '', error: '' };
      const listeners = new Set();
      const emit = () => {
        for (const fn of [...listeners]) {
          try { fn(); } catch { /* 订阅方自己的问题 */ }
        }
      };
      const applyData = (data) => {
        snapshot = {
          status: 'ready',
          writable: true,
          revision: data.revision,
          value: data.config && typeof data.config === 'object' ? data.config : {},
          path: String(data.path ?? ''),
          error: '',
        };
      };
      async function load() {
        if (typeof window.fetch !== 'function') {
          snapshot = { ...snapshot, status: 'error', writable: false, error: t('当前页面没有 fetch') };
          emit();
          return;
        }
        try {
          const res = await window.fetch(CONFIG_ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } });
          const data = await res.json().catch(() => null);
          if (!res.ok || data === null || data.ok !== true) {
            throw new Error(data?.error ?? `HTTP ${res.status}`);
          }
          applyData(data);
        } catch (err) {
          snapshot = { ...snapshot, status: 'error', writable: false, error: String(err?.message ?? err) };
        }
        emit();
      }
      async function mutate(ops, revision) {
        const patch = {};
        for (const op of ops) {
          const key = op?.path?.[0];
          if (key) patch[key] = op.value;
        }
        const res = await window.fetch(CONFIG_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ patch, revision }),
        });
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data !== null) {
          applyData(data);
          emit();
          return false; // 页面会提示「重新读取后再试」
        }
        if (!res.ok || data === null || data.ok !== true) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        applyData(data);
        emit();
        return true;
      }
      load();
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        mutate,
        reload: load,
      };
    }

    // ---------------------------------------------------------------- 远程 UI 布局
    //
    // 只做一件事：**在远程页面**上，按「远程UI布局」这一项，把桌面那套三栏界面改造成手机上能用的样子。
    // 四条硬约束，改这里之前先读一遍：
    //   1. 本机（回环）页面一个像素都不动。判据是 ctx.remote.$host.isLoopback（页面生命周期内固定），
    //      不是窗口宽度 —— 本机窗口拖窄了也不该变成手机布局。
    //   2. 不碰别人的渲染树：只给自己加的 <style> 与 data-ra-* 标记负责；
    //      唯一挂在框架树之外的东西是抽屉遮罩（body 下、有固定 id），不参与任何组件渲染。
    //   3. 不认 DSH 的 CSS-module 哈希名（BynINW_xxx 这种前缀会随版本变）：优先用 data-slot
    //      （槽位是稳定契约）定位，再用 [class*="_xxx"] 这种「只认后缀」的写法兜住可变哈希。
    //   4. 没有 DOM 的环境（tools/test-client.mjs 的桩子）必须安静地什么都不做。
    const LAYOUT_PHONE_WIDTH = 720;
    const LAYOUT_STYLE_ID = 'dsh-remote-access/layout.css';
    /**
     * 输入法刚结束后的这段窗口里，回车仍然可能是在「确认候选词」—— 这段时间内不插手。
     * 与官方自己的做法同一口径（它用 10ms），这里放宽一点：多吞一个换行没代价，多吃一个候选词确认很恼人。
     */
    const ENTER_COMPOSE_GUARD_MS = 60;

    /**
     * 手机布局的全部样式。挂在 html[data-ra-layout="phone"] 之下，所以本机页面
     * 拿不到这个属性、也就永远匹配不上任何一条规则（这就是「不动本地」的实现方式）。
     */
    const PHONE_CSS = `
/* 手机档样式：布局一律交给 @deepseek-ai/dsh-client-ui-layout（0.2.2）。
   < 768px 时官方自己就是「无轨道 + 模态抽屉 + 右栏全屏浮层」，列宽由它按内联 style 算。
   这里只补官方没做的：安全区、设置页手机排版、输入区。
   **不要**再写 grid-template-columns / grid-column / position:fixed 改侧栏 / 自建遮罩 —— 都踩过坑。 */

/* 抽屉描边与安全区。开合、遮罩、焦点、Esc 全由官方管，这里只改观感。
   宽度保持官方的 280px（列与内层都是这个值，单改一边会留空白）。 */
html[data-ra-layout="phone"] [data-ra-frame][data-sidebar-drawer] [data-ra-sidebar] {
  border-right: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3));
  padding-left: env(safe-area-inset-left, 0px) !important;
  overscroll-behavior: contain;
}

/* 右栏：官方在 < 768px 用 autoFullscreen。别写 width / max-width / inset ——
   那组会参与全屏浮层的宽度计算，一叠 !important 就可能压成 0 宽。 */
html[data-ra-layout="phone"] [data-sidebar-right-panel] {
  overflow-x: hidden !important;
  padding-left: env(safe-area-inset-left, 0px) !important;
  padding-right: env(safe-area-inset-right, 0px) !important;
  padding-bottom: env(safe-area-inset-bottom, 0px) !important;
  overscroll-behavior: contain;
}
html[data-ra-layout="phone"] [data-ra-center],
html[data-ra-layout="phone"] [data-ra-overlay] { padding-bottom: env(safe-area-inset-bottom, 0px); }

/* 列宽拖拽手柄在手机上没意义，还会和滑动手势打架 */
html[data-ra-layout="phone"] [data-ra-frame] > [class*="_handle"] { display: none !important; }
/* 「分栏」「退出全屏」在 390px 上没有意义，由脚本按 aria-label 打标记再隐藏 */
html[data-ra-layout="phone"] [data-ra-phone-hidden] { display: none !important; }

/* 设置面板：手机上是「上下两段」。左右两栏时右侧内容只剩一百来像素，中文会一个字一行 */
html[data-ra-layout="phone"] [data-ra-settings-panel] {
  /* 面板本身是 .overlay（fixed 全屏 flex 居中）里的 position:relative flex 子项：
     这里千万别写 inset —— 相对定位下它只会把面板推歪 8px、并让内容把高度撑出视口。
     直接要满屏，内部各区块自己滚。 */
  width: 100% !important; height: 100% !important;
  max-width: none !important; max-height: none !important;
  margin: 0 !important; border-radius: 0 !important;
  flex-direction: column !important;
  padding-top: env(safe-area-inset-top, 0px) !important;
  padding-bottom: env(safe-area-inset-bottom, 0px) !important;
}
html[data-ra-layout="phone"] [data-ra-settings-nav] {
  flex: 0 0 auto !important; width: auto !important; max-width: none !important;
  border-right: 0 !important;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25)) !important;
  padding: 10px 12px 8px !important;
}
html[data-ra-layout="phone"] [data-ra-settings-nav] [class*="_navList"] {
  flex-direction: row !important; overflow-x: auto !important; overflow-y: hidden !important;
  gap: 6px !important; scrollbar-width: none;
}
html[data-ra-layout="phone"] [data-ra-settings-nav] [class*="_navList"]::-webkit-scrollbar { display: none; }
html[data-ra-layout="phone"] [data-ra-settings-nav] [class*="_navCell"] {
  flex: 0 0 auto !important; width: auto !important; min-height: 40px !important; white-space: nowrap !important;
}
html[data-ra-layout="phone"] [data-ra-settings-nav] [class*="_navLabel"] { white-space: nowrap !important; }
html[data-ra-layout="phone"] [data-ra-settings-content] {
  /* min-height: 0 不能省：纵向 flex 子项的默认 min-height 是 auto（就按内容高），
     不写它内容区会被撑到 1185px、把「选项」挤出视口底下。 */
  flex: 1 1 auto !important; width: auto !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important;
}
html[data-ra-layout="phone"] [data-ra-settings-content] [class*="_options"] {
  flex: 1 1 auto !important; min-height: 0 !important;
}
html[data-ra-layout="phone"] [data-ra-settings-content] [class*="_row"],
html[data-ra-layout="phone"] [data-ra-settings-content] [class*="_setting"] {
  flex-wrap: wrap !important; min-width: 0 !important;
}
/* iOS 上输入框字号 <16px 会在聚焦时自动放大整页 */
html[data-ra-layout="phone"] [data-ra-settings-content] input,
html[data-ra-layout="phone"] [data-ra-settings-content] textarea,
html[data-ra-layout="phone"] [data-ra-settings-content] select { font-size: 16px !important; }

/* 输入区（我们的）：工具条允许换行，别把模型名截成「DeepSeek-V4…」 */
html[data-ra-layout="phone"] [data-slot="conversation.composer.bar"] [class*="_card"] {
  padding-left: 10px !important; padding-right: 10px !important;
}
html[data-ra-layout="phone"] [data-slot="conversation.composer.bar"] [class*="_row"] {
  flex-wrap: wrap !important; row-gap: 6px !important;
}
html[data-ra-layout="phone"] [data-slot="conversation.composer.bar"] [class*="_trailing"] {
  flex: 1 1 auto !important; min-width: 0 !important;
}

@media (orientation: landscape) and (max-height: 520px) {
  /* 横屏手机里垂直方向更金贵：导航那条压薄一点 */
  html[data-ra-layout="phone"] [data-ra-settings-nav] { padding: 6px 12px 4px !important; }
}
`;

    /** 布局变化（手机 ↔ 电脑、横屏 ↔ 竖屏）的订阅者，设置页组件靠它跟着重渲染 */
    const layoutListeners = new Set();
    const subscribeLayout = (fn) => {
      layoutListeners.add(fn);
      return () => layoutListeners.delete(fn);
    };
    const emitLayout = () => {
      for (const fn of [...layoutListeners]) {
        try { fn(); } catch { /* 订阅方自己的问题，不牵连布局 */ }
      }
    };

    /** 当前页面的「生效布局」——设置页组件用它决定表单是两列还是一列 */
    const phoneLayoutNow = () =>
      typeof document !== 'undefined' && document.documentElement.getAttribute('data-ra-layout') === 'phone';

    /**
     * 启动布局控制器。返回清理函数；**回环页面直接返回空清理**（这就是「只动远程」的开关）。
     */
    function startLayoutController(ctx, store) {
      const noop = () => {};
      if (typeof document === 'undefined') return noop; // 测试桩子 / 无 DOM
      let remote = false;
      try { remote = ctx?.remote?.$host?.isLoopback === false; } catch { remote = false; }
      if (!remote) return noop; // 本机页面：整段不启用

      let mode = 'auto';
      let applied = null;
      let stopped = false;
      let raScheduled = false;
      /** 「手机端回车=换行」的开头（配置里读；默认开） */
      let enterNewline = true;
      /** 收起态侧栏形态：'show'（48px 图标栏，现状）| 'hide'（0 宽 + 左上角悬浮官方按钮） */
      let railMode = 'show';

      const matches = (query) => {
        try {
          return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches === true : false;
        } catch {
          return false;
        }
      };

      /** auto 的判据：够窄 或 有触摸指针（后者能兜住「宽屏但确实是手机/平板」） */
      function effectiveOf(nextMode) {
        // 'phone-strong' 是旧值（手机档曾分保守/增强两档），继续按手机档处理
        if (nextMode === 'phone' || nextMode === 'phone-strong') return 'phone';
        if (nextMode === 'desktop') return 'desktop';
        return matches(`(max-width: ${LAYOUT_PHONE_WIDTH}px)`) || matches('(pointer: coarse)')
          ? 'phone'
          : 'desktop';
      }

      /**
       * 手机布局的 CSS 分两块：带 strong 标记的「增强」块，和其余「保守」块。
       *
       * 增强块干的都是**直接改 DSH 网格/层叠**的事（钉列号、把侧栏改成定浮层抽屉、把整屏浮层抬到正文之上）。
       * 真机上出现过「DOM 与计算样式全对、画面却不更新，拖一下宽度才显示」——视图/合成层面的问题，
       * 而关掉这些增强块页面就正常呈现。所以默认只注入保守块，增强由配置或 URL 显式开启。
       */
      /** 把某块里「包含关键字的那条声明」删掉（声明级二分用，不动选择器与其余声明） */
      function cutDeclarations(block, cuts) {
        const brace = block.indexOf('{');
        if (brace < 0) return block;
        const head = block.slice(0, brace + 1);
        const body = block
          .slice(brace + 1)
          .split(';')
          .filter((piece) => piece.trim().length > 0 && !cuts.some((word) => word && piece.includes(word)))
          .join(';');
        return body.trim().length > 0 ? head + body : head;
      }

      function phoneCss(strong, skip, cut) {
        const skips = skip || [];
        const cuts = cut || [];
        if (strong && skips.length === 0 && cuts.length === 0) return PHONE_CSS.replace(/\/\*strong\*\//g, '');
        return PHONE_CSS.split('}')
          .map((block) => block.trim())
          .filter((block) => {
            if (block.length === 0) return false;
            if (!strong && block.includes('/*strong*/')) return false;
            return !skips.some((word) => word && block.includes(word));
          })
          .map((block) => (cuts.length === 0 ? block : cutDeclarations(block, cuts)))
          .map((block) => block + '}')
          .join('\n');
      }

      /** 排障开关：URL 上带 ra=off|safe|strong 可临时覆盖远程UI布局（不改宿主配置，刷新即失效） */
      function raOverride() {
        try {
          return new URLSearchParams(window.location.search).get('ra') || '';
        } catch {
          return '';
        }
      }

      /** 排障用：从 URL 取一个逗号分隔的关键字列表 */
      function raWords(name) {
        try {
          return (new URLSearchParams(window.location.search).get(name) || '')
            .split(',')
            .map((word) => word.trim())
            .filter(Boolean);
        } catch {
          return [];
        }
      }

      /** ?skip=z-index,grid-template 丢掉整个规则块；?cut=box-shadow,inset 只删块内那几条声明 */
      function raSkip() {
        return raWords('skip');
      }
      function raCut() {
        return raWords('cut');
      }

      function injectStyle(strong, skip, cut) {
        let tag = document.querySelector(`style[data-ra-layout-css="${LAYOUT_STYLE_ID}"]`);
        if (!tag) {
          tag = document.createElement('style');
          tag.dataset.raLayoutCss = LAYOUT_STYLE_ID;
          document.head.appendChild(tag);
        }
        tag.textContent = phoneCss(strong, skip, cut);
        // 记下当前这份基准内容：弹窗开合后的「重绘兜底」会在这份基准后面追加一个变化的注释，
        // 不记的话它会把上一次的旧样式写回去。
        tag.dataset.raBase = tag.textContent;
      }

      /** 从某个槽位元素往上找到「frame 的直接子元素」（也就是那一列），与类名无关 */
      function columnOf(frame, slot) {
        const slotEl = document.querySelector(`[data-slot="${slot}"]`);
        if (!slotEl) return null;
        let node = slotEl;
        while (node && node.parentElement !== frame) node = node.parentElement;
        return node && node.parentElement === frame ? node : null;
      }

      /**
       * 设置面板的分区标记。这里刻意用「结构」而不是类名：
       * 面板 = 同时含 <nav> 与内容区的那一层，内容区 = 从「关闭」按钮往上、父节点里能看见那个 nav 的一层。
       */
      function tagSettings() {
        // 先清掉上一次的标记。**这一步是必须的**：设置页关掉后标记会残留，而残留的标记会把
        // 「设置页左侧导航 / 内容区」的样式继续作用在那两个元素上（真机上表现为左侧栏消失、中间内容看不见）。
        for (const el of document.querySelectorAll(
          '[data-ra-settings-panel],[data-ra-settings-nav],[data-ra-settings-content]',
        )) {
          el.removeAttribute('data-ra-settings-panel');
          el.removeAttribute('data-ra-settings-nav');
          el.removeAttribute('data-ra-settings-content');
        }
        const closeBtn = document.querySelector('[data-slot="settings.close"]');
        if (!closeBtn) return;
        // 只允许在设置覆盖层内部往上找。**绝不能爬出去**：frame 的直接子元素里就有左侧栏，
        // 而它本身是个 <nav> —— 一旦爬到 frame，就会把「左侧栏」认成设置页导航、把 overlay 层认成内容区，
        // 于是整页被设置样式接管（左侧栏消失、正文空白）。
        // 只允许「在设置面板内部」往上找。**绝不能爬到应用主框架那一层**：frame 的直接子元素里就有左侧栏，
        // 而它本身是个 <nav> —— 一旦命中，就会把「左侧栏」认成设置页导航、把 overlay 层认成内容区，
        // 于是整页被设置样式接管（真机现象：左侧栏消失、正文空白）。
        //
        // 注意：不能用「必须位于 [data-slot="shell.overlay"] 内」来收窄 —— 实测设置面板并不在那个槽位里
        // （它在自己的 wCInkW_panel 里），那样写会让这个函数**永远提前返回**，手机上设置页就一直是电脑版式。
        const frame = document.querySelector('[data-ra-frame]');
        let content = closeBtn;
        while (content && content.parentElement) {
          const parent = content.parentElement;
          if (frame && parent === frame) return;
          if (parent === document.body || parent === document.documentElement) return;
          const nav = [...parent.children].find((child) => child.tagName === 'NAV');
          if (nav) {
            parent.setAttribute('data-ra-settings-panel', '');
            content.setAttribute('data-ra-settings-content', '');
            nav.setAttribute('data-ra-settings-nav', '');
            return;
            return;
          }
          content = parent;
        }
      }

      /**
       * 这个元素「真的能点」吗：可见、有尺寸、且落在视口里。
       *
       * 为什么要专门判一次：DSH 的 DOM 里长期留着**隐藏的同名副本**（dock 把不活跃的 tab
       * 用 `[hidden]` + `transform: translateX(504px)` 停在屏幕右边）。直接 `querySelector`
       * 拿到的往往是那一份 —— 点了按钮却什么也没发生，日志里也看不出异常。
       * 我调这一项时就先被它骗过一次：右栏明明在屏幕上，我却一直在点屏外那份。
       */
      function isClickable(el) {
        if (!el || el.disabled) return false;
        if (el.closest('[hidden], [aria-hidden="true"]')) return false;
        const box = el.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return false;
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        return box.right > 0 && box.left < vw && box.bottom > 0 && box.top < vh;
      }

      /**
       * 按 aria-label 精确点一个**可见的**按钮，返回是否点到。
       *
       * 这是整个手机布局与 DSH 交互的**唯一**方式：手势也好、遮罩也好，都只是替用户去点它自己
       * 那个按钮，而不是我们去改它的 store / 布局状态。好处是行为永远与「用户自己点」一致，
       * 也不会因为猜错内部状态而让界面进入自相矛盾的形态。
       *
       * **两种语言都试**：官方的 aria-label 会跟着界面语言变，而我们的 `LANG` 是从
       * `<html lang>` 推断的 —— 一旦两者哪怕短暂地对不上（模块加载早于 locale 同步就是这种情况），
       * 只按当前语言去找就会**一个都点不到**。历史上这直接把抽屉卡在展开态：遮罩盖住整页，
       * 手势与返回键全部失效。所以这里对同一个语义把所有已知说法都试一遍，
       * 命中哪个用哪个 —— 点到的仍然是官方自己的按钮，行为语义不变。
       */
      /**
       * 官方布局服务（`ctx.layout`）—— **只当可选加速**，不是唯一路径。
       *
       * 坑：本插件的 client 声明的是 `inject: ['slots', 'remote']`，**没有 layout**。
       * Cordis 里 `ctx.get('layout')` 只能取到已注入的服务，没声明就大概率是 undefined，
       * 于是「手势里 if (!layout) return」会静默什么都不做 —— 真机上就是「滑了没反应」。
       * 所以下面所有动作都优先点**官方按钮**（稳定 data 属性、不认语言、不依赖 inject），
       * 拿得到服务时才用它兜底。
       */
      const layoutApi = () => {
        try { return ctx.get?.('layout') ?? null; } catch { return null; }
      };

      /** 按稳定的 data 属性点官方按钮（不认语言、不依赖 inject） */
      function clickStable(attr) {
        const btn = document.querySelector(`[${attr}]`);
        if (btn && isClickable(btn)) { btn.click(); return true; }
        return false;
      }

      /**
       * 左抽屉是不是开着 —— 读**官方**属性。
       *
       * 两个入口都要认：`[data-ra-frame]` 是我们自己在 syncDom() 里打上的标记，
       * 而 `[class*="_frame"]` 是官方原生的类名。只认前者时，一旦 syncDom 还没跑
       * 或标记被清掉，抽屉明明开着也会被判成「没开」—— 真机现象就是
       * 「在抽屉里左滑，抽屉没收起来，反而弹出了右侧面板」。
       */
      const drawerOpen = () => {
        const frame = document.querySelector('[data-ra-frame]') || document.querySelector('[class*="_frame"]');
        if (!frame) return false;
        // 官方：< 768px 且侧栏未收起时，抽屉是模态展开的
        // （frame 带 data-sidebar-drawer，收起时同时带 data-sidebar-collapsed）
        return frame.hasAttribute('data-sidebar-drawer') && !frame.hasAttribute('data-sidebar-collapsed');
      };

      /** 屏幕上那个正在显示的右栏面板（排除 dock 留在 DOM 里的隐藏副本） */
      const visibleRightPanel = () =>
        [...document.querySelectorAll('[data-sidebar-right-panel]')].find(isClickable) ?? null;

      /** 右侧栏是不是正以可见形态开着（手机上它是「无轨道 + 全屏浮层」） */
      const rightPanelOpen = () => visibleRightPanel() !== null;

      /**
       * 手机上没意义的右栏控件：「分栏」在 390px 上分不出两栏，「退出全屏」更是不可能
       * （宽度决定它必须全屏，点了也只会留一个空轨道）。按 aria-label 精确隐藏，
       * 不碰别的按钮 —— 尤其是「收起右侧边栏」，那是手机上唯一该留的出口。
       *
       * 这里仍然按文案匹配，但**只用于隐藏**、不用于「找出口」。匹配不到只是少藏一个按钮，
       * 不会像 1.5.0 那样把整个抽屉卡死，所以中英文都列上就够了。
       */
      const PHONE_HIDDEN_LABELS = [t('分栏'), t('退出全屏'), 'Split view', 'Split', 'Exit fullscreen'];
      function hideUselessRightControls() {
        const panel = document.querySelector('[data-sidebar-right-panel]');
        if (!panel) return;
        for (const btn of panel.querySelectorAll('button')) {
          const label = (btn.getAttribute('aria-label') ?? '').trim();
          if (PHONE_HIDDEN_LABELS.includes(label)) btn.setAttribute('data-ra-phone-hidden', '');
        }
      }

      // 两个浮层的「谁后开」时间戳：手机上它俩都是覆盖整屏的，同时开着只会互相盖。
      // 后开的那个留下，先开的那个替用户收掉（收的方式仍然是点它自己的收起按钮）。
      let drawerOpenedAt = 0;
      let rightOpenedAt = 0;
      let mutualBusy = false;

      /** 手机上两个浮层互斥：谁后开谁留下。收的方式点官方按钮，不认语言、不依赖 inject。 */
      function enforceOverlayExclusive(drawer) {
        if (mutualBusy) return;
        const rightOpen = rightPanelOpen();
        if (!drawer || !rightOpen) return;
        const closeDrawerFirst = drawerOpenedAt < rightOpenedAt;
        mutualBusy = true;
        if (closeDrawerFirst) closeDrawer();
        else closeRightbar();
        window.setTimeout(() => { mutualBusy = false; }, 300);
      }

      /**
       * 主动踢一次重绘。
       *
       * 真机上出现过：手机布局生效后 DOM 与计算样式全对，画面却停在旧帧，
       * **手动拖一下宽度才显示**。这是引擎侧的失效/合成没跟上，CSS 层保证不了；
       * 所以布局应用后主动做一次「改样式 → 强制同步重排 → 还原」，逼合成器重新栅格化。
       *
       * 用 opacity 而不是自定义属性：自定义属性变化不一定触发绘制，opacity 一定会。
       * 值取 0.999 而不是 1，且下一帧就还原，肉眼不可见。
       */
      function nudgeRepaint() {
        try {
          const html = document.documentElement;
          window.requestAnimationFrame(() => {
            html.style.opacity = '0.999';
            void html.offsetHeight; // 读布局属性 → 强制同步重排，把新样式推进渲染管线
            window.requestAnimationFrame(() => { html.style.removeProperty('opacity'); });
          });
        } catch { /* 忽略：这只是兜底，失败也不该影响布局 */ }
      }

      /**
       * 把「画成什么样」这件事交给 CSS：这里只负责给官方元素打标记。
       *
       * **抽屉状态不再由我们维护**：官方自己用 frame 上的 data-sidebar-drawer /
       * data-sidebar-collapsed 表达开合，遮罩也是它自己画的。我们原先那套
       * 「data-ra-drawer + 自建 #dsh-ra-scrim」已全部删除 —— 自建遮罩会吃掉手势，
       * 而且它只会去点左侧栏的收起按钮，右栏开着时向右滑就收不起来（真机 bug 之一）。
       */
      function syncDom() {
        if (stopped) return;
        const phone = document.documentElement.getAttribute('data-ra-layout') === 'phone';
        if (!phone) return;
        // **不再摘壁纸引擎的 data-we-sidebar-glass**：那是 1.5.0 为了让自建抽屉不透明才做的，
        // 会干扰壁纸引擎自身的状态机（真机上表现为整页被铺成主题色、壁纸消失）。
        // 现在抽屉交给官方，观感交给壁纸引擎，这里一个属性都不碰。
        const frame = document.querySelector('[data-slot="root"] > *');
        if (!frame) return;
        frame.setAttribute('data-ra-frame', '');
        for (const [slot, attr] of [
          ['sidebar', 'sidebar'],
          ['main', 'center'],
          ['rightbar', 'right'],
          ['shell.overlay', 'overlay'],
        ]) {
          const column = columnOf(frame, slot);
          if (column) column.setAttribute(`data-ra-${attr}`, '');
        }
        // 设置页在手机上是上下两段可滚动；右栏那两个没意义的控件（分栏 / 退出全屏）在手机上藏掉。
        tagSettings();
        hideUselessRightControls();
        // 抽屉开合只用于「两个整屏浮层互斥」的计时，状态本身读官方的属性
        const drawer = drawerOpen();
        const drawerChanged = drawer !== wasDrawer;
        if (drawerChanged) {
          wasDrawer = drawer;
          drawerOpenedAt = drawer ? Date.now() : 0;
        }
        const rightOpen = rightPanelOpen();
        const rightChanged = rightOpen !== wasRightOpen;
        if (rightChanged) {
          wasRightOpen = rightOpen;
          rightOpenedAt = rightOpen ? Date.now() : 0;
        }
        // 两个浮层互斥：手机上它们都盖满整屏，同时开着只会互相盖。走官方 layout 服务收掉先开的那个。
        if (drawer && rightOpen) enforceOverlayExclusive(drawer);
        // 抽屉/右栏状态变化时踢一次重绘：这两个整屏浮层的出现/消失最容易留下旧帧
        if (drawerChanged || rightChanged) nudgeRepaint();
      }
      let wasDrawer = false;
      let wasRightOpen = false;

      function scheduleSync() {
        if (stopped || raScheduled) return;
        if (document.documentElement.getAttribute('data-ra-layout') !== 'phone') return;
        raScheduled = true;
        window.setTimeout(() => {
          raScheduled = false;
          syncDom();
        }, 200);
      }

      function applyLayout() {
        if (stopped) return;
        const override = raOverride();
        const layout = override === 'off' ? 'desktop' : effectiveOf(mode);
        // 增强只在手机布局下有意义；?ra=strong / ?ra=safe 可以临时强制，便于真机二分
        // 手机档现在默认就是完整版（窄图标栏 + 侧栏抽屉）：原来的「保守版」只留在 ?ra=safe 这条排障开关上，
        // 不再作为可选模式出现在设置里；旧的 'phone-strong' 仍按手机档处理，免得老配置失效。
        const strong = layout === 'phone' && override !== 'safe';
        const skip = layout === 'phone' ? raSkip() : [];
        const cut = layout === 'phone' ? raCut() : [];
        const suffix = `${skip.length ? `|${skip.join(',')}` : ''}${cut.length ? `|cut:${cut.join(',')}` : ''}`;
        const signature = `${strong ? `${layout}:strong` : layout}${suffix}`;
        if (signature === applied) {
          syncDom();
          return;
        }
        applied = signature;
        document.documentElement.setAttribute('data-ra-layout', layout);
        if (strong) document.documentElement.setAttribute('data-ra-strong', '');
        else document.documentElement.removeAttribute('data-ra-strong');
        if (layout === 'phone') injectStyle(strong, skip, cut);
        syncDom();
        // 首次进入手机布局后踢一次重绘：这一步正好是「打开页面就是空白」的现场
        if (layout === 'phone') nudgeRepaint();
        emitLayout();
      }

      /** 从本用户配置里取「远程UI布局」与「手机端回车=换行」；还没读到时按 auto / 开处理 */
      function loadMode() {
        if (stopped) return;
        const snap = store.getSnapshot();
        if (snap.status !== 'ready') return;
        const value = snap.value ?? {};
        const next = String(value.remoteLayout ?? 'auto');
        mode = ['auto', 'phone', 'desktop'].includes(next) ? next : 'auto';
        // 「手机端回车=换行」与布局一起读：这一项是输入体验的开关，默认开
        enterNewline = value.phoneEnterNewline !== false;
        // 收起态侧栏形态：只认 'hide'，其余（含没写）一律 'show' = 1.5.0 现状
        railMode = String(value.phoneCollapsedRail ?? 'show') === 'hide' ? 'hide' : 'show';
        applyLayout();
      }

      injectStyle();
      applyLayout();
      const offStore = store.subscribe(loadMode);
      loadMode();

      // 视口/指针变化（横竖屏切换、外接屏）→ 重算；只在 auto 下有意义
      const mediaSources = [];
      const bindMedia = (query, handler) => {
        try {
          if (typeof window.matchMedia !== 'function') return;
          const mql = window.matchMedia(query);
          const fn = () => handler();
          mql.addEventListener?.('change', fn);
          mediaSources.push(() => mql.removeEventListener?.('change', fn));
        } catch { /* 忽略 */ }
      };
      bindMedia(`(max-width: ${LAYOUT_PHONE_WIDTH}px)`, () => { if (mode === 'auto') applyLayout(); });
      bindMedia('(pointer: coarse)', () => { if (mode === 'auto') applyLayout(); });

      // 从别处回到这个页面时重读一次配置。最常见的路径是：在桌面端把「远程UI布局」改完、再拿起手机看 ——
      // 这条路径上**不会有** settings/document-updated 事件（改的不是这个页面），于是页面会一直停在旧档。
      // 配置只在加载时读一次 + 靠事件跟随，遇上「页面早于配置变更」的时序就会看起来像「设置没生效」。
      try {
        const onVisible = () => {
          if (document.visibilityState === 'visible') loadMode();
        };
        document.addEventListener('visibilitychange', onVisible);
        mediaSources.push(() => document.removeEventListener('visibilitychange', onVisible));
      } catch { /* 忽略 */ }

      // ---------------------------------------------------------------- 手机端：回车 = 换行，不发送
      //
      // 官方把「回车发送」与编辑器的按键处理都挂在那棵 Lexical 编辑器上（冒泡阶段）。所以我们在
      // **document 的捕获阶段**先一步 preventDefault + stopPropagation：官方那条命令收不到这个事件，
      // 也就不会发送；然后我们自己把换行插进去。发送按钮不受影响 —— 点它照旧发送。
      //
      // 放行的四种情况，一条都不能少：
      //   · Shift / Ctrl / Cmd / Alt + Enter —— Shift+Enter 本来就是换行，Ctrl/Cmd+Enter 是发送；
      //   · 输入法合成中、或刚结束 60ms 内 —— 中文输入法用回车确认候选词，吃掉它等于打字打不出来；
      //   · 不在主输入框里（`[data-composer-input]`）—— 设置页的输入框、行内编辑器一律不碰；
      //   · 既不是手机布局、也不是粗指针设备 —— 本机与远程的电脑浏览器都保持原样。
      let composing = false;
      let composingAt = 0;

      const phoneLikeNow = () =>
        document.documentElement.getAttribute('data-ra-layout') === 'phone' || matches('(pointer: coarse)');

      function composerOf(target) {
        try {
          return target && typeof target.closest === 'function' ? target.closest('[data-composer-input]') : null;
        } catch {
          return null;
        }
      }

      /**
       * 编辑器根：优先最内层的 `contenteditable`，否则就是标记元素本身。
       * **只挑一个**目标 —— 早先「两个目标都派一遍」的写法正是重复插入的来源之一。
       */
      function editorRootOf(input) {
        try {
          const inner = typeof input.querySelector === 'function' ? input.querySelector('[contenteditable]') : null;
          if (inner && inner !== input) return inner;
        } catch { /* 取不到就用原元素 */ }
        return input;
      }

      /** 合成一个 `beforeinput`（inputType = insertLineBreak），老 WebView 没有 InputEvent 就退回 Event */
      function beforeInputEvent() {
        const init = { bubbles: true, cancelable: true, inputType: 'insertLineBreak' };
        if (typeof InputEvent === 'function') return new InputEvent('beforeinput', init);
        const event = new Event('beforeinput', { bubbles: true, cancelable: true });
        try { event.inputType = 'insertLineBreak'; } catch { /* 只读就算了 */ }
        return event;
      }

      /**
       * 往编辑器里插**一个**换行。三条路依次试，但判据必须是「编辑器有没有真的接管」：
       *   ① 合成 `beforeinput(insertLineBreak)` —— 编辑器（Lexical）收到就**同步** `preventDefault()` 并接下；
       *   ② 没人接管（没被 preventDefault、DOM 也没变）→ `execCommand('insertLineBreak')`，它同步生效；
       *   ③ 还不行才合成一次 `Shift+Enter`（走官方那条路）。
       * 三条都不成时**什么都不做**：绝不退回「发送」。
       *
       * ⚠️ 这里曾经用「同步读 `textContent` 变没变」来决定要不要往下试 —— 而编辑器把结果提交到 DOM 是
       * **异步**的，于是第一条路明明成了、又被判成没成，接着走了第二条，**一次回车插出两个换行**。
       * 现在以 `defaultPrevented` 为主判据（它是同步的），并且每条路最多执行一次。
       */
      function insertLineBreak(input) {
        const target = editorRootOf(input);
        const before = String(input.textContent ?? '');
        const changed = () => String(input.textContent ?? '') !== before;
        let event = null;
        try {
          event = beforeInputEvent();
          target.dispatchEvent(event);
        } catch { event = null; }
        if (event && event.defaultPrevented === true) return true; // ① 编辑器接管了（结果稍后才落到 DOM）
        if (changed()) return true;
        try {
          if (typeof document.execCommand === 'function' && document.execCommand('insertLineBreak') === true) {
            return true; // ② 同步生效；返回 true 即成功，绝不因为「DOM 还没更新」再插一次
          }
        } catch { /* 走 ③ */ }
        if (changed()) return true;
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }));
        } catch { /* 都不行就只吞掉这一下 */ }
        return changed();
      }

      function onComposerKeyDown(event) {
        if (stopped || !enterNewline) return;
        if (!phoneLikeNow()) return;
        if (!event || (event.key !== 'Enter' && event.keyCode !== 13)) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        const input = composerOf(event.target);
        if (!input) return;
        if (event.isComposing === true || event.keyCode === 229) return;
        if (composing || Date.now() - composingAt < ENTER_COMPOSE_GUARD_MS) return;
        // 到这里：手机端主输入框里的一下裸回车 → 吃掉它，换成换行
        try { event.preventDefault(); } catch { /* 忽略 */ }
        try { event.stopPropagation(); } catch { /* 忽略 */ }
        insertLineBreak(input);
      }

      const onCompositionStart = () => { composing = true; };
      const onCompositionEnd = () => { composing = false; composingAt = Date.now(); };
      let enterBound = false;
      try {
        document.addEventListener('keydown', onComposerKeyDown, true);
        document.addEventListener('compositionstart', onCompositionStart, true);
        document.addEventListener('compositionend', onCompositionEnd, true);
        enterBound = true;
      } catch { /* 没有 DOM 就算了 */ }

      // ---------------------------------------------------------------- 弹窗开合后的重绘
      //
      // 真机上复现到的一条：远程页面每次打开都会弹「预览版说明」（那次「继续」写不进宿主设置，
      // 所以每次都得重来），**点掉它之后手机档下左侧栏整条就不再绘制** —— DOM 里它好好在着
      // （0,0 56x950），像素没有；把我注入的样式清空后画面立刻恢复。
      //
      // 也就是「弹窗关闭这个瞬间」留下的失效没被触发。这里就盯着承载弹窗的 overlay 层：
      // 它一变，手机档下就强制一次样式重算（重写注入的样式表会让所有匹配元素重新计算样式并重绘），
      // 用最便宜的方式把这次重绘踢起来。
      function nudgeStyleRecalc() {
        if (stopped) return;
        if (document.documentElement.getAttribute('data-ra-layout') !== 'phone') return;
        const tag = document.querySelector(`style[data-ra-layout-css="${LAYOUT_STYLE_ID}"]`);
        if (!tag) return;
        // 末尾加一个变化着的时间戳注释：内容变了 → 样式表重新解析 → 受影响元素重算并重绘
        const base = tag.dataset.raBase || (tag.dataset.raBase = tag.textContent);
        tag.textContent = `${base}\n/* nudge ${Date.now()} */`;
      }

      let overlayObserver = null;
      try {
        const overlayLayer = document.querySelector('[data-slot="shell.overlay"]');
        if (overlayLayer) {
          overlayObserver = new MutationObserver(() => nudgeStyleRecalc());
          overlayObserver.observe(overlayLayer, { childList: true, subtree: true });
        }
      } catch { /* 观察不了就算了，这只是治症状的兜底 */ }

      // DOM 与侧栏开合：侧栏那个属性变化要立刻反映（不然抽屉会慢半拍）
      let observer = null;
      try {
        observer = new MutationObserver((records) => {
          if (stopped) return;
          for (const record of records) {
            if (record.type === 'attributes') { syncDom(); return; }
          }
          scheduleSync();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed'],
        });
      } catch { /* 观察不了就退化成「只在进页面时算一次」 */ }

      // ---------------------------------------------------------------- 边缘滑动手势
      //
      // 手机上左抽屉与右栏都是覆盖整屏的浮层，给它们配一对滑动（与系统「侧滑返回」同一套直觉）：
      //   向左滑 → 开右栏；  右栏开着时向右滑 → 收右栏
      //   向右滑 → 开左抽屉；抽屉开着时向左滑 → 收左抽屉
      //
      // 起手位置只影响「门槛」：贴边起手（≤28px）算明确意图，56px 就够了；
      // 从正文中间起手要更严格（72px + 更陡的横向比例），免得把正文里的横向滚动/选择手势吃掉。
      // 三条自制规则都是为了不跟正文打架：
      //   1. 只有「明显横向」才接管（|dx| > |dy| * 1.25，贴边起手只需 10px 位移即可判定）；
      //   2. 只有判定为横向之后才 preventDefault —— 纵向手势完全放给浏览器；
      //   3. 正文中间起手时横向比例放到 1.8 倍，宁可少触发也不误伤。
      const EDGE_ZONE = 28;
      const MIN_SWIPE = 56;
      const MIN_SWIPE_MID = 72;
      const RATIO_EDGE = 1.25;
      const RATIO_MID = 1.8;
      let swipe = null;
      const phoneNow = () => document.documentElement.getAttribute('data-ra-layout') === 'phone';

      /**
       * 起手点是不是落在「自己就要吃横向手势」的东西里 —— 是的话我们根本不接管这一划。
       *
       * 真机反馈：拖动壁纸吉祥物、横向拖表格/代码块，都会把抽屉/右栏划出来。原因是原来只看
       * 起手坐标与位移比例，不看**你按的是什么**：画布上的拖动和容器里的横向滚动同样是「明显的横向」。
       * 所以这里沿着祖先链找几类「横向归属方」，命中任意一类就放手：
       *   · 横向能滚的容器（表格、代码块 <pre>、设置页的胶囊条、轮播…）；
       *   · canvas / video / img —— 壁纸吉祥物、图片预览这类拖拽目标；
       *   · draggable、contenteditable、range 滑杆、select/textarea；
       *   · 壁纸引擎自己的节点（data-we* / data-wallpaper*）；
       *   · 当前有非折叠的文本选区（用户在拖选择柄）。
       * 判断失败一律当作「没命中」，也就是保持旧行为，不至于把滑动开关整个弄丢。
       */
      function horizontalOwner(target) {
        try {
          for (let el = target, depth = 0; el && depth < 14; el = el.parentElement, depth += 1) {
            if (typeof Element === 'undefined' || !(el instanceof Element)) break;
            const tag = el.tagName;
            if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IMG') return true;
            if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
            if (tag === 'INPUT' && el.type === 'range') return true;
            if (el.isContentEditable) return true;
            if (el.hasAttribute('draggable') && el.getAttribute('draggable') !== 'false') return true;
            // 壁纸引擎的 data-we-* / data-wallpaper-* 有两类，判据必须分开：
            //   · **页面级那批全挂在 <body> 上**（data-we-glass-page / -wallpaper / -parallax /
            //     -adapter / -glass-chat …，插件一启用就恒在）—— 它们只是 CSS 门控锚点，
            //     不是「会吃掉横向手势的元素」；
            //   · 真正挂在元素上的交互标记（例如壁纸选择器的 data-we-id）才算归属方。
            // 以前不分这两类：body 命中 → **首页**这种 DOM 浅的地方（起手点往上几层就到 body）
            // 整页划不动，而聊天页嵌套更深、14 层内走不到 body，反而正常 —— 真机上就是
            // 「新会话首页左右滑不出面板」。所以根节点一律跳过。
            const isRoot = el === document.body || el === document.documentElement;
            const attrs = typeof el.getAttributeNames === 'function' ? el.getAttributeNames() : [];
            if (!isRoot && attrs.some((n) => n.startsWith('data-we') || n.startsWith('data-wallpaper'))) return true;
            if (el.scrollWidth - el.clientWidth > 24) {
              const overflowX = getComputedStyle(el).overflowX;
              if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') return true;
            }
            const touchAction = getComputedStyle(el).touchAction;
            if (touchAction && (touchAction.includes('pan-x') || touchAction === 'none')) return true;
          }
          const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
          if (sel && !sel.isCollapsed && String(sel).length > 0) return true;
        } catch { /* 判断失败就当没命中 */ }
        return false;
      }

      function onTouchStart(e) {
        if (!phoneNow() || e.touches.length !== 1) { swipe = null; return; }
        // 右栏展开时它盖满整屏，**这时一律不判归属**。
        // 理由：右栏里全是横向可滚的容器（代码块、表格、页签），按祖先链判归属时连它自己的
        // 空白处都会命中 —— 真机现象就是「必须正好按在某个组件上才能滑，滑空白处完全没反应」。
        // 右栏开着时用户想做的就是「向右滑收起它」，所以不设归属判断。
        // 抽屉同理：整层都是侧栏列表，不再问「这一划归谁」。
        const overlayOpen = rightPanelOpen() || drawerOpen();
        if (!overlayOpen && horizontalOwner(e.target)) { swipe = null; return; }
        const point = e.touches[0];
        const width = window.innerWidth || 0;
        swipe = {
          x: point.clientX,
          y: point.clientY,
          fromLeft: point.clientX <= EDGE_ZONE,
          fromRight: point.clientX >= width - EDGE_ZONE,
          horizontal: false,
        };
      }

      function onTouchMove(e) {
        if (!swipe || e.touches.length !== 1) return;
        const point = e.touches[0];
        const dx = point.clientX - swipe.x;
        const dy = point.clientY - swipe.y;
        const fromEdge = swipe.fromLeft || swipe.fromRight;
        if (!swipe.horizontal) {
          const need = fromEdge ? 10 : 16;
          if (Math.abs(dx) < need) return;
          const ratio = fromEdge ? RATIO_EDGE : RATIO_MID;
          if (Math.abs(dx) <= Math.abs(dy) * ratio) { swipe = null; return; } // 纵向/斜向：交还给页面
          swipe.horizontal = true;
        }
        if (e.cancelable) e.preventDefault(); // 已确认横向：别让浏览器同时翻页/前进后退
      }

      /**
       * 手势落点。**优先点官方按钮**（稳定 data 属性、不认语言、不依赖 inject），
       * 拿得到 layout 服务时才用它兜底。
       *
       * 1.5.0 那套 `clickLabel('收起右侧边栏')` 有两个真机 bug，这次一并修掉：
       *   · 右栏展开时在空白处向右滑收不起来 —— 英文界面下找不到中文 aria-label 的按钮，
       *     静默失败；而且当时页面上还盖着自建遮罩，手势根本到不了这里。
       *   · 正文里有横向滚动块时误触发 —— 由 `horizontalOwner()` 在 onTouchStart 挡掉。
       */
      function onTouchEnd(e) {
        const started = swipe;
        swipe = null;
        if (!started || !started.horizontal) return;
        const point = e.changedTouches?.[0];
        if (!point) return;
        const dx = point.clientX - started.x;
        const fromEdge = started.fromLeft || started.fromRight;
        const need = fromEdge ? MIN_SWIPE : MIN_SWIPE_MID;
        if (Math.abs(dx) < need) return;
        const drawer = drawerOpen();
        const rightOpen = rightPanelOpen();
        if (dx > 0) {
          // 向右滑：抽屉开着 → 收抽屉（这就是「回到主页」）；否则右栏开着 → 收右栏；最后才是开抽屉
          if (drawer) { closeDrawer(); return; }
          if (rightOpen) { closeRightbar(); return; }
          openDrawer();
          return;
        }
        // 向左滑：抽屉开着 → 只收抽屉并**到此为止**。
        // 这里必须无条件 return：早先写的是 closeDrawer() 之后还往下走，
        // 而 closeDrawer() 找不到那枚按钮时会返回 false，于是继续执行到
        // openRightbar() —— 真机现象就是「抽屉里左滑，反而弹出右侧面板」。
        if (drawer) { closeDrawer(); return; }
        if (!rightOpen) openRightbar();
      }

      /** 打开左抽屉：点官方那枚展开按钮 */
      function openDrawer() {
        if (clickStable('data-sidebar-opener')) return true;
        if (clickStable('data-sidebar-toggle')) return true;
        try { layoutApi()?.toggleSidebar(); return true; } catch { return false; }
      }

      /**
       * 收起左抽屉。
       *
       * 优先点官方那枚 toggle；**点不到时直接动官方状态**。
       * 为什么不能只靠点按钮：抽屉展开时整层盖在正文上，侧栏里那枚 toggle 有时会被
       * 官方自己的遮罩/aria-hidden 挡住，`isClickable()` 判不过 → 按钮点不了 → 抽屉收不起来。
       * 真机上就是「抽屉里左滑，抽屉没收起来，反而弹出右侧面板」。
       * 所以按钮这条路失败后必须再用 `layout.toggleSidebar()` 兜一次 —— 它在抽屉展开时
       * 的语义正是「收起」。
       */
      function closeDrawer() {
        if (clickStable('data-sidebar-toggle')) return true;
        try { layoutApi()?.toggleSidebar(); return true; } catch { return false; }
      }

      /**
       * 打开右栏。官方的 `openRightbar(track, fullscreen)` 是**右栏占用方**上报用的，
       * 不是「用户点了展开」的入口。手机上真正该做的是点它自己那枚展开按钮 ——
       * 那是官方在 < 1024px 提供的唯一入口，内部会算好 track/fullscreen 再调 openRightbar。
       * 这枚按钮有稳定属性 `data-sidebar-right-expand`，不认语言。
       */
      function openRightbar() {
        return clickStable('data-sidebar-right-expand');
      }

      /**
       * 收起右栏。**必须点官方那枚 toggle，不能直接调 layout.closeRightbar()。**
       *
       * 原因（看官方源码就知道）：`layout.closeRightbar()` 只是把 store 里的
       * `rightbarShown` 置 false，那是「右栏占用方上报状态」的方向；真正把面板收起来
       * 是 ui-sidebar-right 自己监听状态后做的。我们单方面改状态，面板不一定跟着收 ——
       * 真机上表现为「右滑/返回键都没反应」。
       * 那枚收起按钮带稳定属性 `data-sidebar-right-toggle`，不认语言。
       */
      function closeRightbar() {
        const btn = document.querySelector('[data-sidebar-right-toggle]');
        if (btn && isClickable(btn)) { btn.click(); return true; }
        // 兜底：按钮找不到（面板结构变了）时才动服务，至少别让返回键完全失效
        try { layoutApi()?.closeRightbar(); return true; } catch { return false; }
      }

      try {
        window.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('touchend', onTouchEnd, { passive: true });
      } catch { /* 没有触摸 API 就算了 */ }

      // ---------------------------------------------------------------- 会话行：点一条就把抽屉收掉
      //
      // 手机上「左侧工作区列表」就是抽屉：点一条会话，DSH 切过去了，抽屉却还盖在正文上，
      // 得再点一次遮罩才看得见刚选中的会话 —— 于是「选会话」成了两步。所以这里替用户
      // **多点一下它自己的「收起侧边栏」**：与遮罩、手势、返回键走的是同一条路（不改任何状态）。
      //
      // 顺带按住另一件事：DSH 在**会话切换时会把光标塞进输入框**
      // （`dsh-client-ui-conversation` 里那个 `useEffect(…, [sessionId])` 调的 focusDraftEditor）。
      // 电脑上这是好意（切完就能直接打字），手机上一执行就弹出软键盘，把刚选中的会话盖掉一半。
      // 我们不改它那份逻辑，只在这一下之后的一小段窗口里让输入框**不可聚焦**（inert），
      // 窗口一过立刻恢复 —— 用户自己点输入框照常能打字，也不影响任何别处的焦点行为。
      const SESSION_FOCUS_GUARD_MS = 400;

      let focusGuardTimer = null;

      /** DSH 的输入框宿主（`data-composer-input` 是它自己给那个 contenteditable 的标记） */
      const composerInput = () => document.querySelector('[data-composer-input]');

      /** 这一小段窗口里不让输入框拿到焦点 */
      function guardComposerFocus() {
        const input = composerInput();
        try { if (input) input.inert = true; } catch { /* 老 WebView 没有 inert，下面那手兜底 */ }
        if (focusGuardTimer !== null) {
          try { window.clearTimeout(focusGuardTimer); } catch { /* 忽略 */ }
        }
        focusGuardTimer = window.setTimeout(() => {
          focusGuardTimer = null;
          try { if (input) input.inert = false; } catch { /* 忽略 */ }
        }, SESSION_FOCUS_GUARD_MS);
      }

      /** inert 不被支持（或它没拦住）时的兜底：窗口里谁把焦点塞进输入框，就把它交回去 */
      function onComposerFocusIn(event) {
        if (focusGuardTimer === null) return;
        const target = event?.target;
        if (!target || typeof target.closest !== 'function') return;
        if (!target.closest('[data-composer-input]')) return;
        try { target.blur?.(); } catch { /* 忽略 */ }
      }

      /**
       * 文档级（冒泡）地认「点了一条会话」。
       *
       * 为什么挂在 document 的冒泡阶段而不是侧栏的捕获阶段：点的这一下必须**先**走完 DSH 自己的
       * 处理（它才算把会话切过去），我们再去点「收起侧边栏」；捕获阶段抢在前面的话，抽屉一收，
       * 那一行可能已经被卸载，DSH 的 onClick 就轮不到执行了（会话反而没切过去）。
       *
       * 三道闸门缺一不可：
       *   1. 只在手机布局下（电脑布局里侧栏是普通一列，点完本来就看得到正文）；
       *   2. 抽屉得开着（不然这一下只是页面上的普通点击）；
       *   3. 点的得是**会话行**本身：行里那几个按钮（…菜单 / 置顶 / 归档）是行操作、自己
       *      stopPropagation 到不了这里；工作区分组行是 `workspace:…`，点它只是展开收起。
       */
      function onDocumentClick(event) {
        if (stopped || !phoneNow()) return;
        if (!drawerOpen()) return;
        const target = event?.target;
        if (!target || typeof target.closest !== 'function') return;
        const row = target.closest('[data-row-key]');
        if (!row || !row.closest('[data-ra-sidebar]')) return;
        if (!String(row.getAttribute('data-row-key') ?? '').startsWith('session:')) return;
        // 行里那几个按钮（…菜单 / 置顶 / 归档）是**行操作**，不是「选了这条会话」。DSH 自己在
        // 那一段上 stopPropagation，正常根本到不了这里；再挡一次是为了它哪天不再拦时，
        // 用户点个菜单不会连抽屉一起收掉、会话也切过去。
        if (target.closest('button')) return;
        guardComposerFocus();
        closeDrawer();
      }

      try {
        document.addEventListener('click', onDocumentClick);
        document.addEventListener('focusin', onComposerFocusIn, true);
      } catch { /* 没有 DOM 事件 API 就算了 */ }

      // ---------------------------------------------------------------- 返回键（手机布局里的浮层）
      //
      // 安卓外壳（android/）把系统返回键整个接管了，顺序是「先关网页里的浮层 → 再网页历史后退 → 最后退出」。
      // 网页这一半只回答两个问题，**自己不写任何状态**：
      //   · count()    —— 现在有几层该先关掉的东西（外壳据此决定这一下返回键归谁）；
      //   · closeTop() —— 关掉最上面那层，返回是否真的关掉了。
      // 关的方式仍然是「替用户点它自己的入口」：官方浮层派发一次合成 Escape（官方 Modal 基元的关闭
      // 路径之一，而且它自己保证只有最上面那层响应；`[role=menu]` 的下拉菜单也吃这一套），
      // 右栏与左抽屉点它们自己的「收起…」按钮，全局面板走官方 `layout.selectPanel(null)`
      // —— 与手势、遮罩、手点左上角图标走的是同一条路。
      // 为什么以 phoneLayoutNow() 为闸：这几样**只有手机布局**才叫浮层（电脑布局里侧栏就是普通一列，
      // 没什么可「关掉」的）。外壳不在（普通浏览器里打开）时没人调用这两个函数，等于不存在。

      /** 可见的官方浮层（[role=dialog][aria-modal] 或 [role=menu]）里最上面那个 */
      function topOfficialOverlay() {
        try {
          const nodes = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="menu"]')];
          for (let i = nodes.length - 1; i >= 0; i -= 1) if (isClickable(nodes[i])) return nodes[i];
        } catch { /* 选择器不支持就当没有浮层 */ }
        return null;
      }

      /**
       * 主区是不是停在「插件 / 自动化任务」这类**全局面板**上（左上角那个面板列表选中的那个）。
       *
       * 这一层不猜 DOM，读的是官方自己那份状态：`ctx.layout.panelInfo` 的 `activePanelId`
       * （null = 会话）。layout 是内置 UI 插件提供的服务，这里用 `ctx.get` **可选取** ——
       * 取不到（更老的 DSH）就当没有这一层；绝不把它写进 inject：inject 里少一个必需服务，
       * 整个插件会直接加载失败，代价太大。
       */
      function activeGlobalPanel() {
        try {
          const id = ctx.get?.('layout')?.panelInfo?.getSnapshot?.()?.activePanelId;
          return id ? String(id) : null;
        } catch {
          return null;
        }
      }

      /** 回会话：官方入口是 `layout.selectPanel(null)`，与手点左上角那个会话图标同一条路 */
      function backToConversation() {
        try {
          const layout = ctx.get?.('layout');
          if (!layout || typeof layout.selectPanel !== 'function') return false;
          layout.selectPanel(null);
          return true;
        } catch {
          return false;
        }
      }

      /** 手机布局下「返回键该先关掉」的层数，从上往下：官方浮层 → 右栏 → 左抽屉 → 全局面板 */
      function backLayerCount() {
        if (stopped || !phoneLayoutNow()) return 0;
        let count = 0;
        if (topOfficialOverlay()) count += 1;
        if (rightPanelOpen()) count += 1;
        if (drawerOpen()) count += 1;
        if (activeGlobalPanel()) count += 1;
        return count;
      }

      /** 关掉最上面那层；返回是否交出了一层（外壳吃掉这一下返回键） */
      function closeTopBackLayer() {
        if (stopped || !phoneLayoutNow()) return false;
        if (topOfficialOverlay()) {
          try {
            // 合成事件没有 isTrusted，但官方那条 document 上的 Escape 监听不查它（真机上验过）；
            // keyCode 一起给上，是为了兜住只认 keyCode 的老监听。
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape',
              code: 'Escape',
              keyCode: 27,
              bubbles: true,
              cancelable: true,
            }));
            return true;
          } catch {
            return false;
          }
        }
        // 右栏与抽屉都点官方自己的按钮：不认语言、不依赖 inject
        if (rightPanelOpen()) return closeRightbar();
        if (drawerOpen()) return closeDrawer();
        if (activeGlobalPanel()) return backToConversation();
        return false;
      }

      // 外壳的唯一入口。它只读这两个函数，既不改我们的 DOM 也不碰配置。
      const backApi = { version: 1, count: backLayerCount, closeTop: closeTopBackLayer };
      try { window.__dshRaBack = backApi; } catch { /* 忽略 */ }

      // 配置被改（本机设置页保存 / 另一台设备改了）→ 立刻生效，不必刷新
      const offs = [];
      try { offs.push(ctx.on('connection/reset', () => loadMode())); } catch { /* 忽略 */ }

      return () => {
        stopped = true;
        // 收回给外壳的入口：停用之后它必须立刻变成「问不到东西」，而不是拿到一份过期的答案
        try { if (window.__dshRaBack === backApi) delete window.__dshRaBack; } catch { /* 忽略 */ }
        try { offStore?.(); } catch { /* 忽略 */ }
        for (const off of offs) {
          try { off?.(); } catch { /* 忽略 */ }
        }
        for (const off of mediaSources) {
          try { off(); } catch { /* 忽略 */ }
        }
        try {
          window.removeEventListener('touchstart', onTouchStart);
          window.removeEventListener('touchmove', onTouchMove);
          window.removeEventListener('touchend', onTouchEnd);
        } catch { /* 忽略 */ }
        // 会话行那两下：监听要收回；万一停用时正卡在「按住焦点」的窗口里，输入框也要放开
        try {
          document.removeEventListener('click', onDocumentClick);
          document.removeEventListener('focusin', onComposerFocusIn, true);
        } catch { /* 忽略 */ }
        // 「回车=换行」那三个监听：停用后必须彻底安静（本机页面 / 卸载 / HMR 重挂）
        if (enterBound) {
          try {
            document.removeEventListener('keydown', onComposerKeyDown, true);
            document.removeEventListener('compositionstart', onCompositionStart, true);
            document.removeEventListener('compositionend', onCompositionEnd, true);
          } catch { /* 忽略 */ }
        }
        if (focusGuardTimer !== null) {
          try { window.clearTimeout(focusGuardTimer); } catch { /* 忽略 */ }
          focusGuardTimer = null;
        }
        try {
          const input = composerInput();
          if (input) input.inert = false;
        } catch { /* 忽略 */ }
        try { observer?.disconnect(); } catch { /* 忽略 */ }
      };
    }

    // ---------------------------------------------------------------- 电脑窗口可见性上报（只在本机页面）
    //
    // 手机要不要弹状态栏通知，还差一个只有渲染进程才知道的事实：**电脑前有没有人正看着 DSH**。
    // 窗口收进托盘 / 最小化 / 页面被关掉时，Electron 那边的窗口状态拿不到，但页面的
    // document.visibilityState 会变成 hidden —— 所以由本机页面自己在变化时报一次，
    // 宿主记下「可见 / 不可见」，安卓外壳轮询时一并取走。
    //
    // 三条约定：
    //   1. 只在本机（回环）页面上报 —— 与手机布局同一个开关（ctx.remote.$host.isLoopback）。
    //      远程页面报的是「手机自己可见吗」，那件事由外壳 App 自己回答，不该混进这个判断。
    //   2. 只发一个布尔值、一个固定路径；端点不在（老版本 DSH / 插件没启用）时安静失败。
    //   3. 带 25 秒心跳：页面被关掉或电脑关机后，宿主那份报告会过期，自动退回「不可见」，
    //      于是手机照常收到通知 —— 失效方向是「多提醒一次」，不是「该提醒时没提醒」。
    const PRESENCE_URL = '/__remote_access__/presence';
    const PRESENCE_HEARTBEAT_MS = 25000;

    /**
     * 启动窗口可见性上报。返回清理函数；**非回环页面直接返回空清理**。
     * @param ctx - 客户端根上下文（用 ctx.remote.$host.isLoopback 判断页面在哪一端）
     */
    function startPresenceReporter(ctx) {
      const noop = () => {};
      if (typeof document === 'undefined') return noop;
      let loopback = false;
      try { loopback = ctx?.remote?.$host?.isLoopback === true; } catch { loopback = false; }
      if (!loopback) return noop;
      if (typeof window === 'undefined' || typeof window.fetch !== 'function') return noop;

      let stopped = false;
      let timer = null;
      const send = () => {
        if (stopped) return;
        const visible = document.visibilityState !== 'hidden';
        try {
          const request = window.fetch(PRESENCE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visible }),
            cache: 'no-store',
          });
          // 路由不存在（老 DSH）或插件没启用时会 404/405：那是预期内的，别把噪音丢进控制台
          if (request && typeof request.catch === 'function') request.catch(() => {});
        } catch { /* fetch 本身不可用就算了 */ }
      };
      const onVisibility = () => send();

      document.addEventListener('visibilitychange', onVisibility);
      try { timer = window.setInterval(send, PRESENCE_HEARTBEAT_MS); } catch { timer = null; }
      send();

      return () => {
        if (stopped) return;
        stopped = true;
        try { if (timer !== null) window.clearInterval(timer); } catch { /* 忽略 */ }
        try { document.removeEventListener('visibilitychange', onVisibility); } catch { /* 忽略 */ }
      };
    }

    // ---------------------------------------------------------------- 自定义 CSS（只在远程页面生效）
    //
    // `$DSH_HOME/remote-access-custom.css`：给「只在手机上生效」的样式微调留一个入口，
    // 用户自己改文件、刷新一次就生效，不用来提需求、也不用动这里。
    //
    // 三条约束：
    //   1. 只注入远程页面 —— 本机（回环）页面根本不发这个请求，一个像素都不动；
    //   2. 拿不到 / 文件不存在都安静跳过（绝大多数用户不会建这个文件）；
    //   3. 内容只进 <style>，不做任何求值；端点回的是 JSON，不是 text/css。
    const CUSTOM_CSS_ENDPOINT = '/__remote_access__/custom.css';
    const CUSTOM_CSS_TAG_ID = 'dsh-remote-access/custom.css';

    function startCustomCssController(ctx) {
      const noop = () => {};
      let remote = false;
      try { remote = ctx?.remote?.$host?.isLoopback === false; } catch { remote = false; }
      if (!remote) return noop;
      // 没有 DOM 的环境（tools/test-client.mjs 的桩子、SSR）必须安静地什么都不做
      if (typeof document === 'undefined' || !document.head) return noop;
      if (typeof window.fetch !== 'function') return noop;

      let stopped = false;
      let loaded = false;

      const apply = (css) => {
        let tag = document.querySelector(`style[data-ra-custom-css="${CUSTOM_CSS_TAG_ID}"]`);
        if (css === '') {
          if (tag) tag.remove();
          return;
        }
        if (!tag) {
          tag = document.createElement('style');
          tag.dataset.raCustomCss = CUSTOM_CSS_TAG_ID;
          document.head.appendChild(tag);
        }
        tag.textContent = css;
      };

      const load = async () => {
        if (stopped || loaded) return;
        loaded = true;
        try {
          const res = await window.fetch(CUSTOM_CSS_ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } });
          if (stopped || !res.ok) return;
          const data = await res.json().catch(() => null);
          if (stopped || !data || data.ok !== true) return;
          apply(typeof data.css === 'string' ? data.css : '');
        } catch { /* 端点不存在（老宿主）或网络问题：安静跳过 */ }
      };

      load();

      // 从别处回到这个页面时重读一次：典型路径是「在电脑上改完 css、再拿起手机看」，
      // 与布局控制器同一个理由（那时页面通常没有被销毁，只是切到了后台）。
      const onVisible = () => { if (document.visibilityState === 'visible') { loaded = false; load(); } };
      document.addEventListener('visibilitychange', onVisible);

      return () => {
        if (stopped) return;
        stopped = true;
        try { document.removeEventListener('visibilitychange', onVisible); } catch { /* 忽略 */ }
        try { apply(''); } catch { /* 忽略 */ }
      };
    }

    // ---------------------------------------------------------------- UI 设置（只在远程页面生效）
    //
    // 官方的「通用设置」里有五项界面偏好，本插件把它们存进**本用户配置**（唯一配置源）。
    // 套用方式：
    //   · 外观 / 字号：只投影到本页 DOM（不写宿主设置），本机页面一个像素都不动；
    //   · 工作步骤展示 / 显示代码工作视图 / 性能与用量：官方在 0.2.1 只提供「写宿主」入口，
    //     本插件不写任何别的配置，因此它们跟随电脑设置，状态行会如实说明。
    //
    // 三条硬约束：
    //   1. 本机（回环）页面一个像素都不动 —— 与布局控制器同一个开关。
    //   2. 宿主的官方配置一个字都不写。
    //   3. 没有 DOM / 没有对应服务的环境必须安静地什么都不做（tools/test-client.mjs 的桩子）。

    /** 0.2.1 的 ui-layout 用这两个属性切换内置调色板（与官方 ThemePresenter 同一对） */
    const THEME_SOURCE_ATTR = 'data-ds-theme-source';
    const DARK_THEME_ATTR = 'data-ds-dark-theme';
    /** 0.2.1 的 ui-layout 把三种字号写成 body 上的 CSS 变量 */
    const FONT_SIZE_VARS = [
      ['text', '--dsh-content-font-size'],
      ['code', '--dsh-code-font-size'],
      ['terminal', '--dsh-terminal-font-size'],
    ];

    /**
     * 出厂值：'default' 的语义是「照着这几个值套一遍」，而不是「什么都不做」。
     * 为什么不做成「什么都不做」：用户在同一台手机上先选了「完全展开」、又改回「出厂值」时，
     * 页面上的状态还留着上一次的选择；显式套回官方默认值才是「出厂值」该有的语义。
     * 这几个值取自官方源码：ui-theme 的 DEFAULT_PREFERENCE（system）与字号默认 14；
     * ui-chat 的 DEFAULT_TRANSCRIPT_VIEW_MODE（Web 端 detailed）与 DEFAULT_PERFORMANCE_USAGE（detailed）；
     * ui-settings 的 developerTools 默认 true（内存作用域下本页的本地默认值也是 true）。
     */
    const FACTORY_UI = {
      setTheme: 'system',
      setFontSize: 14,
    };

    function themeServiceOf(ctx) {
      try {
        return typeof ctx?.get === 'function' ? ctx.get('theme') : null;
      } catch {
        return null;
      }
    }

    /** 把「外观」只投影到本页：改 root/body 属性与 color-scheme，不碰 ctx.theme 的持久化入口 */
    function projectThemeLocal(ctx, raw) {
      if (typeof document === 'undefined' || document.documentElement === null) return;
      const preference = ['dark', 'light', 'system'].includes(String(raw)) ? String(raw) : FACTORY_UI.setTheme;
      let scheme = preference;
      if (preference === 'system') {
        let dark = false;
        try {
          dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
        } catch { /* 老 WebView 没有 matchMedia：按浅色 */ }
        scheme = dark ? 'dark' : 'light';
      }
      const root = document.documentElement;
      root.style.colorScheme = scheme;
      root.setAttribute(THEME_SOURCE_ATTR, preference === 'system' ? 'system' : scheme);
      const body = document.body;
      if (!body) return;
      if (scheme === 'dark') body.setAttribute(DARK_THEME_ATTR, '');
      else body.removeAttribute(DARK_THEME_ATTR);
      // 宿主若用自定义主题，会把自己的 token 以内联变量挂在 body 上；本页换成内置浅/深色时
      // 必须先撤掉它们，否则内置调色板会被旧 token 盖住。
      try {
        const snapshot = themeServiceOf(ctx)?.getTheme?.();
        for (const name of Object.keys(snapshot?.active?.tokens ?? {})) body.style.removeProperty(name);
      } catch { /* 忽略 */ }
    }

    /** 把「字号大小」只投影到本页；0 = 恢复官方当前的字号（三种角色都恢复） */
    function projectFontSizeLocal(ctx, raw) {
      if (typeof document === 'undefined' || document.body === null) return;
      const px = Number(raw);
      let snapshot = null;
      try { snapshot = themeServiceOf(ctx)?.getTheme?.(); } catch { /* 忽略 */ }
      const host = snapshot?.fontSizes ?? {
        text: FACTORY_UI.setFontSize,
        code: FACTORY_UI.setFontSize,
        terminal: FACTORY_UI.setFontSize,
      };
      const valid = Number.isInteger(px) && px >= 10 && px <= 22;
      // 与 1.3.8 的语义一致：这一项只改「正文」字号；代码/终端保持官方值。
      // 改成「出厂值」时三种角色都恢复，免得上一轮的值残留在本页。
      for (const [role, name] of FONT_SIZE_VARS) {
        if (valid && role !== 'text') {
          document.body.style.setProperty(name, `${Number(host[role] ?? FACTORY_UI.setFontSize)}px`);
        } else {
          document.body.style.setProperty(name, `${valid ? px : Number(host[role] ?? FACTORY_UI.setFontSize)}px`);
        }
      }
    }

    /** 「UI 设置」在页面上的生效近况：给设置页那一组显示一行状态 */
    let uiStatus = null;
    const uiStatusListeners = new Set();
    const subscribeUiStatus = (fn) => {
      uiStatusListeners.add(fn);
      return () => uiStatusListeners.delete(fn);
    };
    const uiStatusNow = () => uiStatus;
    function publishUiStatus(next) {
      uiStatus = next;
      for (const fn of [...uiStatusListeners]) {
        try { fn(); } catch { /* 订阅方自己的问题，不牵连写入 */ }
      }
    }

    /**
     * 「UI 设置」控制器：只把**外观 / 字号**投影到远程页面的本页 DOM。
     * 另外三项在 DSH 0.2.1 上只提供「写宿主设置」的入口，而本插件不写任何别的配置，
     * 所以它们跟随电脑设置（设置页状态行会写明）。
     */
    function startUiSettingsController(ctx, store) {
      const noop = () => {};
      if (typeof document === 'undefined') return noop;
      let remote = false;
      try { remote = ctx?.remote?.$host?.isLoopback === false; } catch { remote = false; }
      if (!remote) return noop;

      let stopped = false;
      const offs = [];

      function apply() {
        if (stopped) return;
        const snap = store.getSnapshot();
        if (snap.status !== 'ready') return;
        const config = snap.value ?? {};
        try { projectThemeLocal(ctx, config.remoteTheme); } catch { /* 忽略 */ }
        try { projectFontSizeLocal(ctx, config.remoteFontSize); } catch { /* 忽略 */ }
        publishUiStatus({
          applied: [t('外观'), t('字号大小')],
          pending: [],
          skipped: [t('工作步骤展示'), t('显示代码工作视图'), t('性能与用量')],
          localOnly: true,
        });
      }

      try { offs.push(store.subscribe(apply)); } catch { /* 忽略 */ }
      // 桌面端改主题也会广播 theme/change，官方 presenter 会先套宿主主题；
      // 本页的远程外观必须在它之后重新投影一次，否则手机上会瞬间跟着电脑变。
      try { offs.push(ctx.on('theme/change', () => apply())); } catch { /* 忽略 */ }
      const onVisible = () => { if (document.visibilityState === 'visible') apply(); };
      document.addEventListener('visibilitychange', onVisible);
      offs.push(() => document.removeEventListener('visibilitychange', onVisible));

      apply();

      return () => {
        stopped = true;
        for (const off of offs) {
          try { off(); } catch { /* 忽略 */ }
        }
        uiStatus = null;
      };
    }

    return {
      // 服务必须声明才能访问，否则属性访问会抛 "... without inject"。
      // **刻意不声明 `locale`**：如果宿主那一侧没注册这个服务，声明了会让整个插件加载失败，
      // 而语言只是一个附加能力。改为在 bindLocale 里用 try/catch 探测，
      // 并始终挂一条 MutationObserver 盯 `<html lang>` 作为可靠兜底。
      inject: ['slots', 'remote'],
      apply(ctx) {
        // 所有配置读写都走本插件自己的端点（唯一数据源：本用户 JSON）。
        // 不用 ctx.configForms / ctx.remote.settings —— 它们读写的是共享 profile。
        const store = createConfigStore();

        // 远程页面才有布局改造；本机页面这里直接是个空清理函数（「不动本地」的开关就在这一行）
        const stopLayout = startLayoutController(ctx, store);
        const stopUi = startUiSettingsController(ctx, store);
        const stopCustomCss = startCustomCssController(ctx);
        // 反过来：只有本机页面才上报窗口可见性（安卓外壳靠它决定要不要弹通知）
        const stopPresence = startPresenceReporter(ctx);
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => stopLayout);
          if (typeof ctx.effect === 'function') ctx.effect(() => () => { stopLayout(); stopUi(); stopPresence(); stopCustomCss(); });
        } catch { /* 忽略 */ }

        function Panel() {
          const [snap, setSnap] = React.useState(() => store.getSnapshot());
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          // 语言一变就重渲染：t() 本身是「读当前 LANG」，只要渲染被触发就会拿到新语言
          const [, setLangTick] = React.useState(0);
          React.useEffect(() => onLangChange(() => setLangTick((n) => n + 1)), []);
          // 「UI 设置」「缓存」是两层可折叠的下一级菜单，默认都收起
          const [groupsOpen, setGroupsOpen] = React.useState({});
          const toggleGroup = (id) => setGroupsOpen((open) => ({ ...open, [id]: open[id] !== true }));
          const cacheOpen = groupsOpen.cache === true;
          const revisionRef = React.useRef(snap.revision);

          const isLocal = (() => {
            try { return ctx.remote?.$host?.isLoopback === true; } catch { return false; }
          })();
          const source = snap.value;

          /**
           * 页脚那句自检：本页跑的是哪一份客户端代码，以及电脑那边的通知接口在不在。
           *
           * 只在远程页面探一次（本机页面不需要通知，也不该去打这个端点）。
           * 这是「为什么手机上没弹通知」这类问题最省事的答案：代码旧了 / 宿主旧了 / 开关关了，
           * 三种原因在这里一眼能分开 —— 不必再让人去猜是网络还是插件。
           */
          const [linkNote, setLinkNote] = React.useState('');
          React.useEffect(() => {
            if (isLocal || typeof window.fetch !== 'function') return undefined;
            let alive = true;
            (async () => {
              try {
                const res = await window.fetch('/__remote_access__/notify?wait=0', { cache: 'no-store' });
                if (!alive) return;
                if (res.status === 404) {
                  setLinkNote(t('电脑上的插件还没有通知接口（1.3.1 起才有）→ 更新插件并重启一次 DSH'));
                  return;
                }
                if (res.status === 401 || res.status === 403) {
                  setLinkNote(t('通知接口需要重新解锁：刷新本页、再输一次访问密码'));
                  return;
                }
                const data = await res.json().catch(() => null);
                if (!alive) return;
                if (!res.ok || data === null) {
                  setLinkNote((LANG === 'en' ? `Notification endpoint returned HTTP ${res.status}` : `通知接口返回 HTTP ${res.status}`));
                  return;
                }
                const host = data.enabled === false
                  ? t('电脑上关掉了「提问时通知手机」')
                  : t('电脑上的插件已支持提问通知 ✓');
                // 外壳自报的那份通知环境（它每次轮询都会带一份上来）。
                // 「通知发了却不弹横幅」这种问题发生在手机那一端，宿主看不见 —— 这行字就是答案。
                // 这里**不打勾**：「通道=高」只是必要条件，厂商那层（小米的「后台弹出界面」等）
                // 系统不交给应用判断；打了勾反而会让人以为万事俱备。
                const phone = data.phone;
                let phoneNote = '';
                if (phone && phone.app) {
                  const bannerOk = phone.notifications && phone.importance >= 4;
                  const finishOk = phone.notifications && (phone.importanceFinish ?? 0) >= 4;
                  const parts = [
                    (LANG === 'en' ? `Notifications ${phone.notifications ? 'on' : 'off'}` : `通知${phone.notifications ? '已开' : '没开'}`),
                    (LANG === 'en' ? `Question channel=${phone.importance}${bannerOk ? '' : ' (banner suppressed)'}` : `提问通道=${phone.importance}${bannerOk ? '' : '（弹不出来）'}`),
                  ];
                  // 「任务结束」是单独一条通道，重要性也分开报（老 APK 不带这个字段，就只说提问那条）
                  if (phone.importanceFinish !== undefined) {
                    parts.push((LANG === 'en' ? `Finish channel=${phone.importanceFinish}${finishOk ? '' : ' (banner suppressed)'}` : `结束通道=${phone.importanceFinish}${finishOk ? '' : '（弹不出来）'}`));
                  }
                  phoneNote = (LANG === 'en' ? ` · Phone app ${phone.app}: ${parts.join(', ')}` : ` · 手机端 App ${phone.app}：${parts.join('、')}`);
                }
                setLinkNote(host + phoneNote);
              } catch {
                if (alive) setLinkNote(t('读不到电脑上的插件状态'));
              }
            })();
            return () => { alive = false; };
          }, [isLocal]);

          React.useEffect(() => {
            const off = store.subscribe(() => setSnap(store.getSnapshot()));
            // 补偿订阅之前已经完成的那次加载：否则「加载比组件挂载还快」时页面会停在 loading
            setSnap(store.getSnapshot());
            return off;
          }, []);

          /**
           * 「缓存」那一组的自检：只在手机上、且**展开这一组时**才去问一次宿主。
           * 默认收起 = 平时一个额外请求都不发；展开才 1 次（这条路径与通知自检同一套鉴权）。
           * 同一个端点带 `?reset=1` 就是「把流量账清零」—— 复现「退出重进还是大流量」时先清一次，
           * 再走一遍，回来看这一轮到底送出了多少。
           */
          const [cacheNote, setCacheNote] = React.useState('');
          const [cacheInfo, setCacheInfo] = React.useState(null);
          const [cacheBusy, setCacheBusy] = React.useState(false);
          const readCacheInfo = async (reset, alive) => {
            if (isLocal) {
              setCacheNote(t('本机页面不走这个缓存代理：手机上打开这一组时，这里会显示那边实际生效的口径'));
              return;
            }
            if (typeof window.fetch !== 'function') return;
            if (reset) setCacheBusy(true);
            try {
              const res = await window.fetch(`/__remote_access__/cache${reset ? '?reset=1' : ''}`, { cache: 'no-store' });
              if (alive && !alive()) return;
              if (res.status === 404) {
                setCacheNote(t('电脑上的插件还没有缓存接口（1.3.8 起才有）→ 更新插件并重启一次 DSH'));
                return;
              }
              if (res.status === 401 || res.status === 403) {
                setCacheNote(t('缓存接口需要重新解锁：刷新本页、再输一次访问密码'));
                return;
              }
              const data = await res.json().catch(() => null);
              if (alive && !alive()) return;
              if (!res.ok || data === null) {
                setCacheNote((LANG === 'en' ? `Cache endpoint returned HTTP ${res.status}` : `缓存接口返回 HTTP ${res.status}`));
                return;
              }
              const policy = data.policy ?? {};
              const stats = data.stats ?? {};
              const head = policy.enabled === false
                ? t('电脑上关掉了手机端缓存')
                : (LANG === 'en' ? `Content-addressed immutable · no validator ${policy.ttlMinutes} min · ` : `内容寻址 immutable · 无校验器 ${policy.ttlMinutes} 分钟 · `) +
                  (LANG === 'en' ? `Probe ${policy.probe === false ? 'off' : 'on'}` : `探针${policy.probe === false ? '关' : '开'}`);
              const traffic = data.traffic ?? null;
              const trafficText = traffic
                ? (LANG === 'en' ? ` · Sent this round ${humanBytes(traffic.totalOut)} (of which no-cache ${humanBytes(traffic.uncachedOut)})` : ` · 本轮送出 ${humanBytes(traffic.totalOut)}（其中无缓存口径 ${humanBytes(traffic.uncachedOut)}）`) +
                  `、WebSocket ${humanBytes(traffic.wsOut)}`
                : '';
              setCacheNote((LANG === 'en' ? `${head} · 304 this run ${stats.notModified ?? 0} / small assets ${stats.inline ?? 0} / probes ${stats.probe ?? 0}${trafficText}` : `${head} · 本次 304 ${stats.notModified ?? 0} 次 / 小资源 ${stats.inline ?? 0} / 探针 ${stats.probe ?? 0}${trafficText}`));
              setCacheInfo({ policy, stats, traffic, at: Date.now() });
            } catch {
              if (!alive || alive()) setCacheNote(t('读不到电脑上的缓存状态'));
            } finally {
              if (reset) setCacheBusy(false);
            }
          };
          React.useEffect(() => {
            if (!cacheOpen) return undefined;
            let alive = true;
            readCacheInfo(false, () => alive);
            return () => { alive = false; };
            // 只在「展开这一组」与「本机 ↔ 远程」切换时读一次（readCacheInfo 每次渲染都是新的，
            // 但它只读一次远端状态，不进 deps 才不会被自己反复触发）
          }, [cacheOpen, isLocal]);

          // 布局在「手机 ↔ 电脑」之间切换时（改了这一项、或横竖屏转了）让表单跟着重排
          const [, bumpLayout] = React.useState(0);
          React.useEffect(() => subscribeLayout(() => bumpLayout((n) => n + 1)), []);

          // 「UI 设置」的生效近况（只在这一组里显示一行小字）
          const [, bumpUi] = React.useState(0);
          React.useEffect(() => subscribeUiStatus(() => bumpUi((n) => n + 1)), []);

          React.useEffect(() => {
            if (revisionRef.current === snap.revision) return;
            revisionRef.current = snap.revision;
            setDraft(null);
          }, [snap.revision]);


          const current = draft ?? draftFrom(source);
          const setField = (key, value) => setDraft({ ...current, [key]: value });

          const onSave = async () => {
            // 先本地校验访问密码：Host 只认 4–12 位字母数字，不合规的值会被它丢掉。
            // 以前这里直接写盘 → 值被静默丢弃 → 用户以为设好了密码，手机上却撞见 DSH 那句英文 401。
            // 现在不合规就地拦下、说清规则，绝不写盘。
            const code = String(current.accessCode ?? '').trim();
            if (code && !ACCESS_CODE_RE.test(code)) {
              setStatus(t('访问密码没改：只接受 4–12 位数字或字母（不能有空格和符号）。'));
              return;
            }
            setBusy(true);
            setStatus(t('保存中…'));
            try {
              const base = source ?? {};
              // 两侧都过一遍「decode → encode」再比：Host 的配置里可能压根没有某个键
              // （老配置 + 新字段），直接拿裸值比会把它当成「用户改过」而多写一次默认值。
              const baseView = draftFrom(base);
              const changed = {};
              for (const field of FIELDS) {
                const next = encode(field, current[field.key]);
                const before = encode(field, baseView[field.key]);
                if (JSON.stringify(next) !== JSON.stringify(before)) changed[field.key] = next;
              }
              const count = Object.keys(changed).length;
              if (count === 0) {
                setStatus(t('没有改动。'));
                return;
              }
              const ops = Object.entries(changed).map(([key, value]) => ({ op: 'set', path: [key], value }));
              const accepted = await store.mutate(ops, snap.revision);
              if (accepted !== true) throw new Error(t('写入被拒绝（配置在别处被改过），请点「重新读取」后再试一次。'));
              setDraft(null);
              setStatus((LANG === 'en' ? `Saved ${count} item(s).` : `已保存 ${count} 项。`));
            } catch (err) {
              try { console.error(t('[remote-access] 保存失败'), err); } catch { /* 忽略 */ }
              setStatus((LANG === 'en' ? `Save failed: ${err?.message ?? err}` : `保存失败：${err?.message ?? err}`));
            } finally {
              setBusy(false);
            }
          };

          const onReload = () => {
            setStatus('');
            setDraft(null);
            store.reload();
          };

          // 手机上一列排（标签在上、控件在下）：300px 宽的设置页塞不下「标签 + 输入框」两列。
          // 其余场合保持原来的两列，和 DSH 设置页其它条目一致。phoneLayoutNow() 读的是控制器
          // 打在 <html> 上的标记，所以判定与本插件真正施加的布局永远同一份。
          const phone = phoneLayoutNow();
          const rowStyle = phone
            ? {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: '4px',
                alignItems: 'stretch',
              }
            : {
                display: 'grid',
                gridTemplateColumns: 'minmax(84px, max-content) minmax(180px, 1fr)',
                gap: '8px 12px',
                alignItems: 'center',
              };
          const inputStyle = {
            width: '100%',
            boxSizing: 'border-box',
            padding: phone ? '9px 10px' : '4px 6px',
            font: 'inherit',
            // 手机上不写死字号：iOS 在 <16px 的输入框聚焦时会自动放大整页
            // （对象键顺序有意义：font 简写在先，fontSize 在后才能盖住它）
            fontSize: phone ? 16 : undefined,
            color: 'inherit',
            background: 'rgba(127,127,127,0.08)',
            border: '1px solid rgba(127,127,127,0.35)',
            borderRadius: phone ? 8 : 4,
          };
          const labelStyle = phone ? { fontSize: 13, opacity: 0.85 } : undefined;
          const buttonStyle = phone ? { minHeight: 40, padding: '8px 16px', borderRadius: 8 } : undefined;
          // 复选框在手机上是行首一个 44px 的方块，单指才好点
          const checkStyle = phone ? { width: 22, height: 22 } : undefined;

          // 分组：都是可折叠的下一级菜单，默认收起（手机上不能一进来就铺满屏）。
          // 标题上带「已改 N 项」，收起来也知道动过没有 —— 判据是「与出厂默认值不同」，
          // 布尔项要按布尔比（否则默认就开着的那几项会被算成「已改」）。
          const uiFields = FIELDS.filter((field) => field.group === 'ui');
          const cacheFields = FIELDS.filter((field) => field.group === 'cache');
          const changedCount = (fields) => fields.filter((field) => {
            const raw = current[field.key];
            const fallback = DEFAULTS[field.key];
            if (field.type === 'boolean') return (raw === true) !== (fallback === true);
            if (field.type === 'number') return Number(raw) !== Number(fallback);
            return String(raw ?? '') !== String(fallback ?? '');
          }).length;
          const uiChanged = changedCount(uiFields);
          const cacheChanged = changedCount(cacheFields);
          const groupStyle = {
            marginTop: phone ? 14 : 16,
            border: '1px solid rgba(127,127,127,0.3)',
            borderRadius: phone ? 10 : 8,
            padding: `0 ${phone ? 10 : 12}px ${phone ? 10 : 12}px`,
          };
          const groupHeaderStyle = {
            width: '100%',
            minHeight: phone ? 44 : undefined,
            padding: phone ? '12px 0' : '10px 0',
            textAlign: 'left',
            font: 'inherit',
            fontWeight: 600,
            color: 'inherit',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          };
          const groupHintStyle = { fontSize: 12, opacity: 0.7, margin: '0 0 8px' };
          const uiState = uiStatusNow();
          const uiHint = uiState
            ? uiState.pending.length > 0
              ? (LANG === 'en' ? `Official entry point not ready yet: ${uiState.pending.join(', ')}` : `暂时没接上官方入口：${uiState.pending.join('、')}`)
              : uiState.localOnly
                ? (LANG === 'en' ? `Applied to this page only: ${uiState.applied.join(', ') || 'none'}` : `已只在本页应用：${uiState.applied.join('、') || '无'}`) +
                  (uiState.skipped.length > 0
                    ? (LANG === 'en' ? `; ${uiState.skipped.join(', ')} follow the desktop settings from DSH 0.2.1 (only a host-writing entry point is public, and this plugin will not change your desktop)` : `；${uiState.skipped.join('、')} 在 DSH 0.2.1 起跟随电脑设置（官方只提供写宿主入口，本插件不替你改电脑）`)
                    : '')
                : uiState.applied.length > 0
                  ? (LANG === 'en' ? `Applied to this page: ${uiState.applied.join(', ')}` : `已套用到本页：${uiState.applied.join('、')}`)
                  : t('本页无需套用')
            : t('保存后，在远程页面打开时生效（本机界面不受影响）');

          const renderField = (field) => {
            const value = displayValue(field, current[field.key]);
            const common = {
              key: `${field.key}-i`,
              disabled: busy,
              style: inputStyle,
              onChange: (e) => setField(field.key, e.target.value),
            };
            let input;
            if (field.type === 'boolean') {
              input = h('input', {
                key: `${field.key}-i`,
                type: 'checkbox',
                checked: value === true,
                disabled: busy,
                style: checkStyle,
                onChange: (e) => setField(field.key, e.target.checked),
              });
            } else if (field.type === 'list') {
              input = h('textarea', {
                ...common,
                rows: 2,
                value,
                placeholder: field.placeholder,
                style: { ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
              });
            } else if (field.type === 'select') {
              input = h(
                'select',
                { ...common, value: current[field.key] ?? '' },
                field.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
              );
            } else if (field.type === 'password') {
              input = h('input', {
                ...common,
                type: 'password',
                autoComplete: 'new-password',
                value,
                placeholder: field.placeholder,
              });
            } else {
              input = h('input', {
                ...common,
                type: field.type === 'number' ? 'number' : 'text',
                value,
                placeholder: field.placeholder,
              });
            }
            return [
              h('div', { key: `${field.key}-l`, style: labelStyle }, field.label),
              input,
              field.hint
                ? h(
                    'div',
                    {
                      key: `${field.key}-h`,
                      style: { fontSize: 11, opacity: 0.55, lineHeight: 1.6, gridColumn: phone ? '1' : '2' },
                    },
                    field.hint,
                  )
                : null,
            ];
          };

          /**
           * 主区按「节」铺开：每节一个标题行，然后是该节的字段（标签 / 控件 / 一行小字说明）。
           * 版式与 DSH 设置页其它条目一致，宽屏两列、手机单列。
           */
          const renderSections = (fields) => {
            const out = [];
            let lastSection = '';
            for (const field of fields) {
              const section = field.section ?? '';
              if (section && section !== lastSection) {
                lastSection = section;
                out.push(
                  h(
                    'div',
                    {
                      key: `section-${section}`,
                      style: {
                        gridColumn: phone ? '1' : '1 / -1',
                        marginTop: out.length === 0 ? 0 : phone ? 14 : 16,
                        paddingBottom: 4,
                        borderBottom: '1px solid rgba(127,127,127,0.25)',
                        fontSize: 12,
                        fontWeight: 600,
                        opacity: 0.85,
                      },
                    },
                    section,
                  ),
                );
              }
              out.push(...renderField(field));
            }
            return out;
          };

          /** 一层可折叠的下一级菜单（UI 设置 / 缓存）：默认收起，标题带「已改 N 项」 */
          const renderGroup = (id, title, hint, fields, changed, extra) => h(
            'div',
            { key: `group-${id}`, style: groupStyle },
            h(
              'button',
              {
                type: 'button',
                style: groupHeaderStyle,
                'aria-expanded': groupsOpen[id] === true ? 'true' : 'false',
                onClick: () => toggleGroup(id),
              },
              `${groupsOpen[id] === true ? '▾' : '▸'} ${title}${changed > 0 ? (LANG === 'en' ? ` (${changed} changed)` : `（已改 ${changed} 项）`) : ''}`,
            ),
            h('div', { style: groupHintStyle }, hint),
            groupsOpen[id] === true ? h('div', { style: rowStyle }, fields.flatMap(renderField)) : null,
            groupsOpen[id] === true ? extra : null,
          );

          /**
           * 「缓存」那一组展开后的三块（自上而下）：
           *   1. 生效策略 —— 一条一条对上，不必去翻配置文件；
           *   2. 本次会话计数 —— `304` 就是省下来的重传次数；
           *   3. 本轮流量账 —— 按 URL 排字节（组合包那类「DSH 自己发 immutable」的响应看不见缓存计数，
           *      只能靠字节数），配「刷新 / 清零本轮统计」。
           * 版式与设置页其它条目一致：左标签、右等宽数字；窄屏单列也不挤。
           */
          const cachePolicy = cacheInfo?.policy ?? null;
          const cacheCounters = cacheInfo?.stats ?? null;
          const cacheTraffic = cacheInfo?.traffic ?? null;
          const blockStyle = { marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(127,127,127,0.25)' };
          const blockTitleStyle = { fontSize: 12, fontWeight: 600, opacity: 0.9, margin: '0 0 6px' };
          const statRowStyle = {
            display: 'grid',
            gridTemplateColumns: phone ? 'minmax(88px, max-content) minmax(0, 1fr)' : 'minmax(112px, max-content) minmax(0, 1fr)',
            gap: '1px 10px',
            fontSize: 12,
            lineHeight: 1.75,
          };
          const statLabelStyle = { opacity: 0.62 };
          const statValueStyle = { fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' };
          const flagText = (on, off) => (on ? t('开 · 已接管') : (LANG === 'en' ? `Off · ${off}` : `关 · ${off}`));
          const statRow = (label, value) =>
            h(
              'div',
              { key: `stat-${label}`, style: statRowStyle },
              h('span', { style: statLabelStyle }, label),
              h('span', { style: statValueStyle }, value),
            );
          const trafficGrid = { display: 'grid', gridTemplateColumns: '68px 40px minmax(0, 1fr)', gap: '2px 8px' };

          const cacheExtra = h(
            'div',
            { style: { fontSize: 12 } },
            // ---- 生效策略
            h(
              'div',
              { style: blockStyle },
              h('div', { style: blockTitleStyle }, t('生效策略')),
              statRow(t('内容寻址产物'), t('immutable（一年内不重取）')),
              statRow(t('其它静态资源'), cachePolicy ? (LANG === 'en' ? `${cachePolicy.ttlMinutes} min (stale first, one background check)` : `${cachePolicy.ttlMinutes} 分钟（过期先出旧的，后台核对一次）`) : '—'),
              statRow(t('过期核对'), cachePolicy ? (cachePolicy.probe === false ? t('长度 + 类型') : t('首/尾各 64 KB 片段指纹')) : '—'),
              statRow(t('no-store 大媒体'), cachePolicy ? flagText(cachePolicy.overrideNoStore, t('尊重上游')) : '—'),
              statRow(t('整段 Range'), cachePolicy ? flagText(cachePolicy.overrideRange, t('原样透传 206')) : '—'),
              statRow(t('正文落盘'), cachePolicy && cachePolicy.storesOnHost === false ? t('不落宿主盘（零字节）') : '—'),
            ),
            // ---- 本次会话计数
            h(
              'div',
              { style: blockStyle },
              h('div', { style: blockTitleStyle }, t('本次会话')),
              statRow(t('304（零字节）'), cacheCounters ? (LANG === 'en' ? `${cacheCounters.notModified}` : `${cacheCounters.notModified} 次`) : '—'),
              statRow(t('小资源缓冲'), cacheCounters ? (LANG === 'en' ? `${cacheCounters.inline}` : `${cacheCounters.inline} 次`) : '—'),
              statRow(t('片段探针'), cacheCounters ? (LANG === 'en' ? `${cacheCounters.probe} (failed ${cacheCounters.probeFail})` : `${cacheCounters.probe} 次（失败 ${cacheCounters.probeFail}）`) : '—'),
              statRow(t('接管 no-store'), cacheCounters ? (LANG === 'en' ? `${cacheCounters.override ?? 0}` : `${cacheCounters.override ?? 0} 次`) : '—'),
            ),
            // ---- 本轮流量账
            h(
              'div',
              { style: blockStyle },
              h('div', { style: blockTitleStyle }, t('本轮流量账（按 URL 排字节）')),
              ...(cacheTraffic
                ? [
                    h(
                      'div',
                      { key: 'traffic-total', style: { ...statRowStyle, marginBottom: 6 } },
                      h('span', { style: statLabelStyle }, t('送出 / 收到')),
                      h(
                        'span',
                        { style: statValueStyle },
                        `${humanBytes(cacheTraffic.totalOut)} / ${humanBytes(cacheTraffic.totalIn)}` +
                          (LANG === 'en' ? `  of which no-cache ${humanBytes(cacheTraffic.uncachedOut)}` : `　其中无缓存口径 ${humanBytes(cacheTraffic.uncachedOut)}`) +
                          `　WebSocket ${humanBytes(cacheTraffic.wsOut)} / ${humanBytes(cacheTraffic.wsIn)}`,
                      ),
                    ),
                    h(
                      'div',
                      {
                        key: 'traffic-head',
                        style: {
                          ...trafficGrid,
                          fontSize: 11,
                          opacity: 0.55,
                          borderBottom: '1px solid rgba(127,127,127,0.25)',
                          paddingBottom: 3,
                          marginBottom: 3,
                        },
                      },
                      h('span', { style: { textAlign: 'right' } }, t('送出')),
                      h('span', { style: { textAlign: 'right' } }, t('次数')),
                      h('span', null, 'URL'),
                    ),
                    ...cacheTraffic.top.slice(0, 6).map((row) => {
                      const uncached = row.hits - row.cached;
                      return h(
                        'div',
                        { key: `row-${row.key}`, style: { marginBottom: row.reason ? 4 : 0 } },
                        h(
                          'div',
                          { style: { ...trafficGrid, fontVariantNumeric: 'tabular-nums', lineHeight: 1.6 } },
                          h('span', { style: { textAlign: 'right' } }, humanBytes(row.out)),
                          h('span', { style: { textAlign: 'right', opacity: uncached > 0 ? 0.95 : 0.6 } }, String(row.hits)),
                          h(
                            'span',
                            { style: { wordBreak: 'break-all', opacity: 0.9 } },
                            row.key,
                            uncached > 0 ? (LANG === 'en' ? `  (${uncached} no-cache -> re-sent next time)` : `　（${uncached} 次无缓存口径 → 下次仍会重传）`) : null,
                          ),
                        ),
                        row.reason
                          ? h(
                              'div',
                              { style: { fontSize: 11, opacity: 0.55, paddingLeft: phone ? 0 : 116 } },
                              (LANG === 'en' ? `Reason: ${row.reason}` : `原因：${row.reason}`),
                            )
                          : null,
                      );
                    }),
                  ]
                : [h('div', { key: 'traffic-none', style: statRowStyle }, h('span', { style: statLabelStyle }, cacheNote || '—'))]),
              !isLocal
                ? h(
                    'div',
                    { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                    h(
                      'button',
                      { type: 'button', style: buttonStyle, disabled: cacheBusy || busy, onClick: () => readCacheInfo(false, null) },
                      cacheBusy ? t('读取中…') : t('刷新'),
                    ),
                    h(
                      'button',
                      { type: 'button', style: buttonStyle, disabled: cacheBusy || busy, onClick: () => readCacheInfo(true, null) },
                      cacheBusy ? t('处理中…') : t('清零本轮统计'),
                    ),
                  )
                : null,
              !isLocal
                ? h(
                    'div',
                    { style: { marginTop: 6, fontSize: 11, opacity: 0.55, lineHeight: 1.7 } },
                    t('用法：点「清零本轮统计」→ 完全退出 App（从最近任务划掉）→ 重新打开，回来后这里显示的就是那一轮的真实花费。') +
                      t('实时轮询（如音频频谱）与会话通道（聊天图片走的 RPC）不在缓存射程内，它们出现大数字属正常。'),
                  )
                : null,
            ),
          );

          // 分组之外的都排在主区（缓存与 UI 设置都收在各自的下一级菜单里）
          const mainRows = renderSections(FIELDS.filter((field) => !field.group));

          return h(
            'div',
            { style: { padding: phone ? '4px 2px' : '2px 0' } },
            h('div', { style: rowStyle }, mainRows),
            renderGroup('ui', t('UI 设置'), uiHint, uiFields, uiChanged),
            renderGroup(
              'cache',
              t('缓存'),
              cacheNote || (LANG === 'en' ? `Default: content-addressed assets pinned for a year, everything else ${DEFAULTS.cacheTtlMinutes} min; no body is ever written to the host disk` : `默认：内容寻址的产物钉一年、其余 ${DEFAULTS.cacheTtlMinutes} 分钟；正文一律不落宿主盘`),
              cacheFields,
              cacheChanged,
              cacheExtra,
            ),
            h(
              'div',
              {
                style: phone
                  ? { marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
                  : { marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' },
              },
              h('button', { type: 'button', style: buttonStyle, onClick: onSave, disabled: busy }, busy ? t('保存中…') : t('保存')),
              h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: onReload }, t('重新读取')),
              status ? h('span', { style: { opacity: 0.9 } }, status) : null,
            ),
            // 自检那行：本页代码的版本 + 电脑那端通知接口的状态（排「怎么没通知」时先看它）
            h(
              'div',
              { style: { marginTop: 10, fontSize: 12, opacity: 0.7, lineHeight: 1.6 } },
              (LANG === 'en' ? `This page's client ${CLIENT_VERSION}${linkNote ? ` · ${linkNote}` : ''}` : `本页客户端 ${CLIENT_VERSION}${linkNote ? ` · ${linkNote}` : ''}`),
            ),
            // 配置读写失败时直接把原因写出来（本页只认这一个文件，读不到就什么都改不了）
            snap.status === 'error'
              ? h(
                  'div',
                  { style: { marginTop: 10, fontSize: 12, color: 'inherit', opacity: 0.9, lineHeight: 1.6 } },
                  (LANG === 'en' ? `Cannot read this user's config: ${snap.error || 'unknown error'} (click Reload to retry)` : `读不到本用户配置：${snap.error || '未知错误'}（点「重新读取」重试）`),
                )
              : null,
            // 配置来源那一行：只有本用户 JSON，没有共享 profile
            h(
              'div',
              { style: { marginTop: 6, fontSize: 12, opacity: 0.7, lineHeight: 1.6 } },
              (LANG === 'en' ? `Config lives only at: ${snap.path || '$DSH_HOME/remote-access-config.json'}` : `配置只存在：${snap.path || '$DSH_HOME/remote-access-config.json'}`) +
                t('（每个 Windows 用户各一份；插件不读也不写共享 profile）。'),
            ),
          );
        }

        // 语言：接上 DSH 的 locale 服务，切换语言时不需要刷新页面。
        // **必须放在注册 section 之前**：label 是注册那一刻的字符串，先定语言才不会用错语言注册一次。
        try { ctx.effect(() => bindLocale(ctx)); } catch { bindLocale(ctx); }

        ctx.slots.inject('settings.section', () => {
          // 官方把 label 读走之后不再回头读，改对象上的字段没有效果 ——
          // 所以语言变化时**重挂一次**（dispose 旧的、register 新的），这是官方公开的接口，
          // 不依赖任何内部字段。重挂失败就退化为「等下次刷新」，不会比原来更糟。
          let dispose = null;
          const register = () => {
            try { if (typeof dispose === 'function') dispose(); } catch { /* 忽略 */ }
            dispose = ctx.slots.register({ name: 'settings.section', id: NS, order: 100, label: t('远程访问') }, Panel);
          };
          register();
          const offLang = onLangChange(() => { try { register(); } catch { /* 忽略 */ } });
          return () => {
            try { offLang(); } catch { /* 忽略 */ }
            try { if (typeof dispose === 'function') dispose(); } catch { /* 忽略 */ }
          };
        });
      },
    };
  },
});
