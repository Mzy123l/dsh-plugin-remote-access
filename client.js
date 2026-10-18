/**
 * dsh-plugin-remote-access 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
 *
 * 注册位置：settings.section（设置左侧导航的一页）。
 *
 * 两条读写通道，按 0.2.1 的实际行为自动选：
 *   1. 本机（回环）页面 —— 官方通道 ctx.configForms.get('remote-access')：
 *      读 form.getSnapshot() → { status, value, revision, writable }，
 *      写 form.mutate([{ op:'set', path:[字段], value }], revision) → Promise<boolean>。
 *   2. 手机等远程页面 —— 0.2.1 的 ui-settings 已经取消了「非回环 → memory」的降级，
 *      configForms 在远程页面上也能写宿主；但为了兼容 0.2.0 以及「远程页面的 Remote
 *      连接还没就绪」的瞬间，这里仍保留 ctx.remote.settings.describe() / mutate() 回退。
 *      两条路写的是同一个地方（profile 的 cordis.patch.yml），都会等写盘完成才返回。
 *
 * 页面上只说人话：失败给一句「下一步做什么」，内部状态只写开发者控制台。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'remote-access';

    /**
     * 本页客户端代码的版本（与 package.json 对齐；`tools/test-client.mjs` 有一条断言钉着它）。
     *
     * 为什么页面上要显示出来：手机这一端跑的代码是**服务端按请求发过来的**，插件更新之后
     * 页面必须刷新才会换上新的一份 —— 只看「我把插件升级了」是看不出这件事的。
     * 1.3.2 那次就撞在这上面：代码推上去了、版本号也对了，但手机上跑的还是上一份，
     * 表现成「这个功能根本不存在」。所以设置页底部把「本页客户端版本」与
     * 「电脑那边的通知接口在不在」一起写出来 —— 这两句话能省掉一整轮排查。
     */
    const CLIENT_VERSION = '1.4.0';

    // 表单字段（与 index.js 的 Config 字段对表由 tools/check-config-schema.mjs 保证）
    const FIELDS = [
      // 分节（section）只是版式：让设置页读起来像一份配置清单，而不是一串控件。
      // 每一节标题下面是同类参数；`hint` 是字段下方那行小字（手机上比 placeholder 好读）。
      { key: 'enabled', type: 'boolean', section: '服务', label: '启用', hint: '关掉即停止监听，不需要卸载插件' },
      { key: 'port', type: 'number', section: '服务', label: '端口', placeholder: '0=随机', hint: '固定下来才好存书签（默认 0 = 系统随机）' },
      { key: 'allowCidrs', type: 'list', section: '服务', label: '允许的网段', placeholder: '换行分割', hint: '唯一的安全边界；listen=auto 时也用它挑本机要监听的地址' },
      { key: 'denyCidrs', type: 'list', section: '服务', label: '排除的网段', placeholder: '换行分割', hint: '白名单里的例外；输错访问密码的地址会自动加到这里，删掉即解封' },
      { key: 'maxConnections', type: 'number', section: '服务', label: '并发上限', placeholder: '0=不限制' },
      {
        key: 'logLevel',
        type: 'select',
        section: '服务',
        label: '日志级别',
        options: [
          { value: 'silent', label: '静默' },
          { value: 'info', label: '普通' },
          { value: 'debug', label: '详细' },
        ],
      },
      { key: 'accessCode', type: 'password', section: '访问控制', label: '访问密码', placeholder: '4-12位数字或字母', hint: '设了它就不用复制 token：手机开裸地址输一次即可；输错一次即拉黑该地址' },
      // 安卓外壳的状态栏通知：宿主只负责回答「有没有选择在等 / 电脑窗口可见吗」，
      // 弹不弹、弹什么由 App 自己决定（它才知道自己在不在前台）
      { key: 'notifyOnChoice', type: 'boolean', section: '手机通知', label: '提问时通知手机', hint: '模型提问（ask_user_question）且没人回答时，让 App 弹状态栏通知' },
      { key: 'notifyOnFinish', type: 'boolean', section: '手机通知', label: '一轮结束时通知手机', hint: '正常跑完与异常结束都算；异常会带上分类（模型输出格式错 / 余额额度不足 / 网络连不上 / 被限流…）' },
      { key: 'notifyOnlyWhenWindowHidden', type: 'boolean', section: '手机通知', label: '仅窗口不可见时通知', hint: '电脑上 DSH 窗口可见时不打扰；关掉则只要 App 不在前台就提醒' },
      {
        key: 'remoteLayout',
        type: 'select',
        section: '远程界面',
        label: '远程UI布局',
        options: [
          { value: 'phone', label: '手机（横竖屏自适应）' },
          { value: 'desktop', label: '电脑' },
          { value: 'auto', label: '自动' },
        ],
        hint: '只作用于远程页面，本机界面不受影响；改完手机端立刻生效，不用刷新',
      },
      // 手机端输入：回车当成换行，只有点「发送」才真的发出去。
      // 为什么单独给一个开关：有人用外接键盘、或就是习惯回车发送；默认按手机的习惯来。
      { key: 'phoneEnterNewline', type: 'boolean', section: '远程界面', label: '手机端回车=换行', hint: '只有点「发送」才发送；Ctrl/Cmd+Enter 仍是发送，输入法合成中一律放行' },
      // 「UI 设置」一组（group: 'ui'）：官方「通用设置」里的五项界面偏好，只作用于远程页面。
      // 为什么要有这一份副本：官方设置页在远程页面上是内存态（读写都到不了宿主），手机端改了刷新就还原；
      // 这里存的是同一批值，由 startUiSettingsController 在每次打开远程页面时重新套到页面上。
      // 'default' 一律 = 出厂值（跟着官方默认走），所以默认状态下这一组不做任何事。
      {
        key: 'remoteTheme',
        type: 'select',
        group: 'ui',
        label: '外观',
        options: [
          { value: 'default', label: '出厂值' },
          // 顺序照官方那行来（THEME_PREFERENCES = light / dark / system），我们不要自作主张换个先后
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '跟随系统' },
        ],
      },
      { key: 'remoteFontSize', type: 'number', group: 'ui', label: '字号大小', placeholder: '10-22，0=出厂值' },
      {
        key: 'remoteTranscriptView',
        type: 'select',
        group: 'ui',
        label: '工作步骤展示',
        options: [
          { value: 'default', label: '出厂值' },
          { value: 'compact', label: '简洁' },
          { value: 'standard', label: '标准' },
          { value: 'detailed', label: '详细' },
          { value: 'verbose', label: '完全展开' },
        ],
      },
      {
        key: 'remoteDeveloperTools',
        type: 'select',
        group: 'ui',
        label: '显示代码工作视图',
        options: [
          { value: 'default', label: '出厂值' },
          { value: 'on', label: '开启' },
          { value: 'off', label: '关闭' },
        ],
      },
      {
        key: 'remotePerformanceUsage',
        type: 'select',
        group: 'ui',
        label: '性能与用量',
        options: [
          { value: 'default', label: '出厂值' },
          { value: 'compact', label: '简洁' },
          { value: 'detailed', label: '详细' },
        ],
      },
      // 「缓存」一组（group: 'cache'）：手机端资源缓存的口径。缓存本体在手机的 WebView 里，
      // 宿主只负责把响应头喂对（详见 index.js 的「手机端缓存策略」与 README 同名一节）。
      { key: 'cacheEnabled', type: 'boolean', group: 'cache', label: '启用手机端资源缓存' },
      { key: 'cacheTtlMinutes', type: 'number', group: 'cache', label: '新鲜期（分钟）', placeholder: '1-1440，默认 10' },
      { key: 'cacheProbe', type: 'boolean', group: 'cache', label: '过期核对用首/尾片段指纹' },
      // 默认关：这是**逆着上游意愿**的一步（壁纸那类实时抓帧自己写了 no-store），
      // 开着最多会看到「新鲜期」这么久之前的旧帧/旧音轨，所以必须由用户显式打开。
      { key: 'cacheOverrideNoStore', type: 'boolean', group: 'cache', label: '接管 no-store 的大媒体' },
      // 媒体元素取大文件时会发 Range，而浏览器**永远不缓存 206** —— 于是每次进页面都重下整段。
      // 这一项把「从 0 取到结尾」那一种改写成可缓存的整份。默认关：个别播放器可能失去拖动定位。
      { key: 'cacheFullRange', type: 'boolean', group: 'cache', label: '整段 Range 视为整份' },
    ];

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

    const namespaceOf = (view) => (view?.namespaces ?? []).find((row) => row?.ns === NS);

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
    const SCRIM_ID = 'dsh-ra-scrim';
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
/* 手机上「展开后的工作区抽屉」必须不透明。
   透明来自壁纸引擎的「侧栏液态玻璃」——它自己的旋钮是 --we-sidebar-tint / --we-sidebar-alpha
   （设置项：侧栏玻璃颜色权重 / 侧栏透明度），面板底色由
   color-mix(… var(--we-sidebar-color) var(--we-sidebar-tint, 20%), transparent …) 算出来。
   而手机上展开的抽屉整块盖在正文上，半透明会让两层文字糊在一起。
   这里只在本页把这两个变量拉满：**只作用于手机档，本机一个像素都不动**，也不去覆盖元素表面
   （之前那条 background !important 覆盖 DSH 玻璃表面，会让左侧栏整列不再绘制，已删）。 */
html[data-ra-layout="phone"] {
  --we-sidebar-tint: 100%;
  --we-sidebar-alpha: 1;
}
html[data-ra-layout="phone"] [data-ra-frame] > [class*="_handle"] { /*strong*/ display: none !important; }
html[data-ra-layout="phone"] [data-ra-center],
html[data-ra-layout="phone"] [data-ra-overlay] { padding-bottom: env(safe-area-inset-bottom, 0px); }

/* 关键：手机布局下**关掉框架自己的列宽过渡**。
   框架带着 .BynINW_frame[data-animating] 上的 transition: grid-template-columns …，而 grid-template-columns
   是可动画的布局属性；我用 !important 改写轨道值（48px / 0px）时又挂着这条过渡，真机上出现过
   「DOM 与计算值都对、画面却不重绘，直到手动拖一下宽度才刷新」的卡顿 —— 关掉它就没有这个组合了。
   反正手机端的轨道值由我定，过渡本身也没有意义。 */
html[data-ra-layout="phone"] [data-ra-frame] { transition: none !important; }

/* 侧栏：收起时保持 56px 图标栏；展开时改成「抽屉」压在正文上 —— 而不是把正文挤成 110px 一条 */
/* 三列显式钉住列号：抽屉模式把侧栏改成 position:fixed 后就脱离网格了，
   自动排位会把「正文」顶到第 1 条轨道（0px）上，正文会直接消失。 */
html[data-ra-layout="phone"] [data-ra-sidebar] { grid-column: 1 !important; /*strong*/ }
html[data-ra-layout="phone"] [data-ra-center] { grid-column: 2 !important; /*strong*/ }
html[data-ra-layout="phone"] [data-ra-right] { grid-column: 3 !important; /*strong*/ }
html[data-ra-layout="phone"][data-ra-drawer] [data-ra-frame] { grid-template-columns: 0px minmax(0px, 1fr) 0px !important; /*strong*/ }
html[data-ra-layout="phone"][data-ra-drawer] [data-ra-sidebar] {
  /*strong*/
  position: absolute !important;
  top: 0 !important; bottom: 0 !important; left: 0 !important; right: auto !important;
  /* 工作区/会话名往往很长，320px 在 390px 屏上会挤成两行；给到 340px（约 88vw）但右边仍留出可见的正文。
     这里刻意用普通 px 而不是 min(88vw, 340px)：真机上抽屉这一层只要带上「大模糊阴影 + min() 宽度 + 独立层叠」
     的组合，整块视图就会停止呈现（DOM 全对、画面不更新，拖一下视图宽度才恢复）——
     已用声明级开关逐条验证：单独去掉 box-shadow / 宽度里的 min() / z-index 任一条都能恢复。
     所以这一层保持「便宜」：普通宽度 + 1px 描边，不要大模糊阴影。 */
  width: 340px !important;
  z-index: 70 !important;
  border-right: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)) !important;
  padding-left: env(safe-area-inset-left, 0px) !important;
  /* 抽屉里滑到底不要带动后面的正文一起滚 */
  overscroll-behavior: contain;
}

/* 右栏：DSH 自己在 viewportWidth < 768 时就选了 autoFullscreen（无轨道 + 全屏浮层），
   所以这里不去抢它的布局，只做收尾 —— 安全区、不横向溢出、以及把手机上没意义的控件藏掉。 */
html[data-ra-layout="phone"] [data-ra-right] {
  /* 抬到正文之上：底部统计、输入框、对话/轨迹页签各自都有层叠上下文，
     不抬的话它们会画在右栏这个浮层上面（真机截图里就是「这一页冒出了输入框和底部 info」）。 */
  position: relative !important; /*strong*/
  z-index: 64 !important; /*strong*/
}
html[data-ra-layout="phone"] [data-sidebar-right-panel] {
  /*strong*/
  /* 这一组（max-width / overflow-x / 安全区内边距 / overscroll）会参与右栏全屏浮层的宽度计算：
     框架自己的全屏做法是 inline width:0 + left/right 负值 + width:auto，我这些 !important 一叠上去
     就可能把它压成 0 宽 —— 正文空白、只看得见输入框与底栏。保守档里先完全不动右栏。 */
  max-width: 100vw !important;
  overflow-x: hidden !important;
  padding-left: env(safe-area-inset-left, 0px) !important;
  padding-right: env(safe-area-inset-right, 0px) !important;
  padding-bottom: env(safe-area-inset-bottom, 0px) !important;
  overscroll-behavior: contain;
}
/* 单独一条：只把「抬到正文之上」这件事放进增强模式，实底那条留在保守模式 */
html[data-ra-layout="phone"] [data-sidebar-right-panel] { z-index: 65 !important; /*strong*/ }

/* 这里曾经给这两个浮层加「不透明实底 + 强雾化」来治「太透」。
   **已删除**：真机上复现到，这条 background（!important 覆盖 DSH 的玻璃表面）会让左侧栏整条不再绘制 ——
   DOM 里它在（0,0 56x950），像素没有；只要摘掉这一条就恢复。排查协议：清本地标记 → 重载（弹窗出现）→
   点掉弹窗 → 截图；摘别的规则都不解决，只有摘这条解决。
   观感那件事现在不再由我插手：不碰壁纸引擎的任何外观开关 —— 原先我强行打开它的「侧栏液态玻璃」正是「左侧透明」的来源，
   壁纸插件不在时就用 DSH 的默认表面 —— 宁可少一点好看，也不能让页面画不出来。 */

/* 收起的图标栏在手机上再窄一点（56 → 48）：省下的横向像素全给正文 */
html[data-ra-layout="phone"]:not([data-ra-drawer]) [data-ra-frame] { /*strong*/
  grid-template-columns: 48px minmax(0px, 1fr) 0px !important;
}
/* 「分栏」在 390px 上没有意义，「退出全屏」更是不可能（宽度决定它必须全屏）。
   由脚本按 aria-label 精确打上这个标记再隐藏，避免拿类名去猜。 */
html[data-ra-layout="phone"] [data-ra-phone-hidden] { display: none !important; }

#dsh-ra-scrim { display: none; }
html[data-ra-layout="phone"] #dsh-ra-scrim[data-open] { /*strong*/
  display: block; position: absolute; inset: 0; z-index: 60;
  background: rgba(0,0,0,0.42); -webkit-tap-highlight-color: transparent;
}

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

/* 输入区：工具条允许换行，别把模型名截成「DeepSeek-V4…」 */
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

/* 抽屉的实底：**不覆盖 DSH 的表面元素**（那条 background !important 覆盖表面会让左侧栏整列不再绘制，
   已在 d92a572 删除并验证），改为在抽屉背后垫一层自己的底色 —— 伪元素 + z-index:-1，
   正好夹在父层背景与内容之间。这样即使内层面板仍带着壁纸引擎调出来的半透明底色，合成结果也不透明。
   只在手机档的抽屉上生效、且只在壁纸激活时（透明正是那时才发生）；本机与电脑档不注入。 */
html[data-ra-layout="phone"][data-ra-drawer] body[data-we-wallpaper] [data-ra-sidebar]::before {
  content: "" !important;
  position: absolute !important;
  inset: 0 !important;
  z-index: -1 !important;
  /* 用壁纸引擎自己的「可读性底色」：那是当前主题下真正不透明的表面色（实测 #151849）。
     绝不能用 --dsw-alias-bg-base —— 它被壁纸插件改成了 transparent，垫了等于没垫（已实测）。 */
  background: var(--we-readability-base, #151517) !important; /*strong*/
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
    function startLayoutController(ctx) {
      const noop = () => {};
      if (typeof document === 'undefined') return noop; // 测试桩子 / 无 DOM
      let remote = false;
      try { remote = ctx?.remote?.$host?.isLoopback === false; } catch { remote = false; }
      if (!remote) return noop; // 本机页面：整段不启用

      let mode = 'auto';
      let applied = null;
      let stopped = false;
      let attempt = 0;
      let retryTimer = null;
      let raScheduled = false;
      /** 「手机端回车=换行」的开头（配置里读；默认开） */
      let enterNewline = true;

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
       */
      function clickLabel(label) {
        const candidates = [...document.querySelectorAll('button')].filter(
          (b) => (b.getAttribute('aria-label') ?? '') === label,
        );
        const btn = candidates.find(isClickable);
        if (!btn) return false;
        btn.click();
        return true;
      }

      /** 屏幕上那个正在显示的右栏面板（排除 dock 留在 DOM 里的隐藏副本） */
      const visibleRightPanel = () =>
        [...document.querySelectorAll('[data-sidebar-right-panel]')].find(isClickable) ?? null;

      /** 右侧栏是不是正以可见形态开着（手机上它是「无轨道 + 全屏浮层」） */
      const rightPanelOpen = () => visibleRightPanel() !== null;

      /** 抽屉遮罩：点它等于点「收起侧边栏」，行为与用户自己收起完全一致（不自己改状态） */
      function ensureScrim() {
        let scrim = document.getElementById(SCRIM_ID);
        if (scrim) return scrim;
        scrim = document.createElement('div');
        scrim.id = SCRIM_ID;
        scrim.addEventListener('click', () => { clickLabel('收起侧边栏'); });
        document.body.appendChild(scrim);
        return scrim;
      }

      /**
       * 手机上没意义的右栏控件：「分栏」在 390px 上分不出两栏，「退出全屏」更是不可能
       * （宽度决定它必须全屏，点了也只会留一个空轨道）。按 aria-label 精确隐藏，
       * 不碰别的按钮 —— 尤其是「收起右侧边栏」，那是手机上唯一该留的出口。
       */
      const PHONE_HIDDEN_LABELS = ['分栏', '退出全屏', 'Split', 'Exit fullscreen'];
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

      /** 手机上两个浮层互斥：谁后开谁留下 */
      function enforceOverlayExclusive(drawer) {
        if (mutualBusy) return;
        const rightOpen = rightPanelOpen();
        if (!drawer || !rightOpen) return;
        const closeDrawer = drawerOpenedAt < rightOpenedAt;
        mutualBusy = true;
        const ok = closeDrawer ? clickLabel('收起侧边栏') : clickLabel('收起右侧边栏');
        if (ok) {
          const what = closeDrawer ? '左抽屉' : '右栏';
          try { console.info(`[remote-access] 手机上两个浮层互斥：收掉先开的${what}`); } catch { /* 忽略 */ }
        }
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

      /** 把「画成什么样」这件事交给 CSS：这里只负责打标记与开关 data-ra-drawer */
      function syncDom() {
        if (stopped) return;
        const phone = document.documentElement.getAttribute('data-ra-layout') === 'phone';
        if (!phone) {
          document.documentElement.removeAttribute('data-ra-drawer');
          // 退出手机布局时把借来的玻璃属性还回去，别把本机的原生侧栏观感改了
          try { /* 不再碰这个属性，见下方说明 */ } catch { /* 忽略 */ }
          const scrimOff = document.getElementById(SCRIM_ID);
          if (scrimOff) scrimOff.removeAttribute('data-open');
          return;
        }
        // 「左侧栏覆盖」是壁纸引擎自己的开关：它做的就是给 body 挂这个属性，让原生侧栏跟着玻璃配方走
        // （不那么透出壁纸）。手机端直接借用它 —— 只打在**远程页面**上，所以本机观感不受影响；
        // 没装壁纸插件时这行什么也不做，上面 CSS 里那份实底兜底仍然生效。
        // 手机上把壁纸引擎的「侧栏液态玻璃」总开关**摘掉**（只摘属性、不动任何元素样式）。
        // 那个开关的语义是「开了才透明」（插件 settings-schema 原话：关闭后侧栏恢复原生外观，不透明/不模糊），
        // 而展开后的工作区抽屉在手机上整块盖在正文上，透明会让两层文字糊在一起。
        // 为什么不用 background 兜底：给 [data-ra-sidebar] 加 !important 实底正是「左侧栏整条不绘制」的原因（已删）。
        // 本机不受影响 —— 这段只在远程页面跑；插件若在别处又设回来，syncDom 下一次会再摘掉。
        try { document.body.removeAttribute('data-we-sidebar-glass'); } catch { /* 忽略 */ }
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
        // 这两项一度被我停用（当时误判它们是「整页不绘制」的元凶）。真正的原因是那条 background 实底（已删除），
        // 而且 tagSettings() 已经收紧（先清旧标记 + 只允许在 shell.overlay 内查找、不许爬进 frame），
        // 所以恢复：设置页在手机上是上下两段可滚动；右栏那两个没意义的控件（分栏 / 退出全屏）在手机上藏掉。
        tagSettings();
        hideUselessRightControls();
        // 侧栏展开（没有 data-sidebar-collapsed）→ 抽屉模式：正文占满宽度，侧栏浮在上面
        const drawer = !frame.hasAttribute('data-sidebar-collapsed');
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
        if (drawer) document.documentElement.setAttribute('data-ra-drawer', '');
        else document.documentElement.removeAttribute('data-ra-drawer');
        const scrim = ensureScrim();
        if (drawer) scrim.setAttribute('data-open', '');
        else scrim.removeAttribute('data-open');
        // 互斥只在增强模式有意义：那时侧栏是「脱离网格的定浮层」，会和右栏抢同一块屏；
        // 保守模式下侧栏老老实实占着自己那一列，不该去替用户点关任何面板。
        if (document.documentElement.hasAttribute('data-ra-strong')) enforceOverlayExclusive(drawer);
        // 抽屉/右栏状态变化时也踢一次：这两个整屏浮层的出现/消失最容易留下旧帧
        if (drawerChanged || rightChanged) nudgeRepaint();
      }
      let wasDrawer = false;
      let wasRightOpen = false;

      /** DOM 变动很密（聊天流式输出），所以合并到 200ms 一次，且只在手机布局下干活 */
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

      /** 读一次「远程UI布局」配置；失败就退到 auto（并重试几次，刚进页面时 Remote 可能还没就绪） */
      function loadMode() {
        Promise.resolve()
          .then(() => ctx.remote.settings.describe())
          .then((response) => {
            if (stopped) return;
            if (!response?.ok) throw new Error(response?.error?.message ?? '读取被拒绝');
            const value = namespaceOf(response.value)?.value ?? {};
            const next = String(value.remoteLayout ?? 'auto');
            attempt = 0;
            mode = ['auto', 'phone', 'desktop'].includes(next) ? next : 'auto';
            // 「手机端回车=换行」与布局一起读：这一项是输入体验的开关，默认开
            enterNewline = value.phoneEnterNewline !== false;
            applyLayout();
          })
          .catch((err) => {
            if (stopped) return;
            try { console.warn('[remote-access] 读「远程UI布局」失败，先按自动处理', err); } catch { /* 忽略 */ }
            attempt += 1;
            if (attempt < 5) retryTimer = window.setTimeout(loadMode, 300 * attempt);
          });
      }

      injectStyle();
      applyLayout();
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
        // 抽屉开着时，整层都是我们自己的侧栏列表（工作区/会话那一串）：不再问「这一划归谁」——
        // 否则列表里任何一个横向略有溢出的容器都会把「滑回主页」整个吃掉（真机上就是这么发生的）。
        const drawerOpen = document.documentElement.hasAttribute('data-ra-drawer');
        if (!drawerOpen && horizontalOwner(e.target)) { swipe = null; return; }
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
        const drawer = document.documentElement.hasAttribute('data-ra-drawer');
        const rightOpen = rightPanelOpen();
        if (dx > 0) {
          // 向右滑：抽屉开着时先**收起抽屉**（这就是「回到主页」），其次收右栏，最后才是打开抽屉
          if (drawer) { clickLabel('收起侧边栏'); return; }
          if (rightOpen) { clickLabel('收起右侧边栏'); return; }
          clickLabel('打开侧边栏');
          return;
        }
        // 向左滑：收起抽屉优先，否则打开右栏
        if (drawer) { clickLabel('收起侧边栏'); return; }
        if (!rightOpen) clickLabel('打开右侧边栏');
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
        if (!document.documentElement.hasAttribute('data-ra-drawer')) return;
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
        clickLabel('收起侧边栏');
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
        if (document.documentElement.hasAttribute('data-ra-drawer')) count += 1;
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
        if (rightPanelOpen()) return clickLabel('收起右侧边栏');
        if (document.documentElement.hasAttribute('data-ra-drawer')) return clickLabel('收起侧边栏');
        if (activeGlobalPanel()) return backToConversation();
        return false;
      }

      // 外壳的唯一入口。它只读这两个函数，既不改我们的 DOM 也不碰配置。
      const backApi = { version: 1, count: backLayerCount, closeTop: closeTopBackLayer };
      try { window.__dshRaBack = backApi; } catch { /* 忽略 */ }

      // 配置被改（本机设置页保存 / 另一台设备改了）→ 立刻生效，不必刷新
      const offs = [];
      try { offs.push(ctx.on('connection/reset', () => { attempt = 0; loadMode(); })); } catch { /* 忽略 */ }
      try {
        const off = ctx.remote.$on?.('settings/document-updated', () => { attempt = 0; loadMode(); });
        if (typeof off === 'function') offs.push(off);
      } catch { /* 忽略 */ }

      return () => {
        stopped = true;
        // 收回给外壳的入口：停用之后它必须立刻变成「问不到东西」，而不是拿到一份过期的答案
        try { if (window.__dshRaBack === backApi) delete window.__dshRaBack; } catch { /* 忽略 */ }
        if (retryTimer) window.clearTimeout(retryTimer);
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

    // ---------------------------------------------------------------- UI 设置（只在远程页面生效）
    //
    // 官方的「通用设置」里有五项界面偏好。
    //
    // 0.2.0：非回环页面把设置通道降级成内存态
    //        （`persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`），
    //        官方 setter 只改本页；本插件存一份值，每次打开远程页面重新套一遍。
    // 0.2.1：这个降级被取消了（ConfigFormController 不再有 persistence/mode），
    //        远程页面调官方 setter 会**直接写宿主设置**。继续沿用那套，会把「手机选的外观」
    //        悄悄改成电脑的外观。所以 0.2.1 起：
    //          · 外观 / 字号：只投影到本页 DOM（不写宿主），本机页面仍一个像素都不动；
    //          · 工作步骤展示 / 显示代码工作视图 / 性能与用量：官方只保留「写宿主」的入口，
    //            没有公开的「只改本页」路径，因此不再远程覆盖，状态行会如实说明；
    //          · 0.2.0 仍走原来的官方入口（本页生效）。
    //
    // 三条硬约束不变：
    //   1. 本机（回环）页面一个像素都不动 —— 与布局控制器同一个开关。
    //   2. 宿主的官方配置一个字都不写。
    //   3. 没有 DOM / 没有对应服务的环境必须安静地什么都不做（tools/test-client.mjs 的桩子）。
    const UI_FIELDS = [
      'remoteTheme',
      'remoteFontSize',
      'remoteTranscriptView',
      'remoteDeveloperTools',
      'remotePerformanceUsage',
    ];

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
      // 官方那行的判据分端：桌面客户端 standard，其余（手机浏览器）detailed
      setTranscriptView: typeof globalThis !== 'undefined' && 'dshDesktop' in globalThis ? 'standard' : 'detailed',
      setDeveloperTools: true,
      setPerformanceUsage: 'detailed',
    };

    /**
     * 0.2.1 起官方设置表单在远程页面上也可写（快照里不再有 0.2.0 的 `mode` 字段）。
     * 用它决定要不要把「官方 setter 会写宿主」这条路径换成本页投影。
     */
    function settingsPersistAcrossPages(ctx) {
      try {
        const snapshot = ctx?.configForms?.get?.(NS)?.getSnapshot?.();
        return snapshot !== undefined && snapshot !== null && !('mode' in snapshot);
      } catch {
        return false;
      }
    }

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

    /** 控制器退出时把本页恢复成宿主自己的主题/字号（不触发任何写盘） */
    function restoreHostUi(ctx) {
      if (typeof document === 'undefined' || document.documentElement === null) return;
      let snapshot = null;
      try { snapshot = themeServiceOf(ctx)?.getTheme?.(); } catch { /* 忽略 */ }
      if (!snapshot) return;
      const scheme = snapshot.active?.colorScheme === 'dark' ? 'dark' : 'light';
      const root = document.documentElement;
      root.style.colorScheme = scheme;
      root.setAttribute(THEME_SOURCE_ATTR, snapshot.preference === 'system' ? 'system' : scheme);
      const body = document.body;
      if (body) {
        if (scheme === 'dark') body.setAttribute(DARK_THEME_ATTR, '');
        else body.removeAttribute(DARK_THEME_ATTR);
        for (const [name, value] of Object.entries(snapshot.active?.tokens ?? {})) body.style.setProperty(name, value);
        for (const [role, name] of FONT_SIZE_VARS) {
          const px = Number(snapshot.fontSizes?.[role] ?? FACTORY_UI.setFontSize);
          body.style.setProperty(name, `${px}px`);
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
     * 找官方那五项各自的「本页写入入口」。官方只给前两项做了服务，其余挂在那几行设置项的注入面上：
     *   - 外观 / 字号大小 → ui-theme 的 theme 服务（setTheme / setFontSize）
     *   - 显示代码工作视图 → ui-settings 的 configForms.developerTools.setEnabled
     *   - 工作步骤展示 / 性能与用量 → settings.general.item 里 id 为 transcript-view / performance-usage
     *     那两行的注入面（官方没给服务入口，设置页那两行拿到的就是这两个函数）。
     * ctx.slots.entries() 是官方公开的「注册视图」，取到 inject 直接调，与用户点那两行同一条路径。
     * 入口可能比本插件晚就绪，所以缺谁就把谁记进 pending，由调用方退避重试。
     */
    function officialUiSetters(ctx) {
      const found = {};
      const theme = (() => {
        try { return typeof ctx.get === 'function' ? ctx.get('theme') : null; } catch { return null; }
      })();
      if (theme && typeof theme.setTheme === 'function') found.setTheme = (id) => theme.setTheme(id);
      if (theme && typeof theme.setFontSize === 'function') {
        found.setFontSize = (px) => {
          // 0.2.0 是 setFontSize(px)；0.2.1 改成 setFontSize(role, px)（text/code/terminal）。
          // 这个入口只在 0.2.0 的远程页面用；0.2.1 走本页投影，不写宿主。
          if (theme.setFontSize.length >= 2) {
            for (const role of ['text', 'code', 'terminal']) theme.setFontSize(role, px);
          } else {
            theme.setFontSize(px);
          }
        };
      }
      const developerTools = (() => {
        try {
          const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : null;
          return forms?.developerTools ?? null;
        } catch { return null; }
      })();
      if (developerTools && typeof developerTools.setEnabled === 'function') {
        found.setDeveloperTools = (enabled) => developerTools.setEnabled(enabled === true);
      }
      try {
        const entries = ctx.slots?.entries?.('settings.general.item') ?? [];
        for (const entry of entries) {
          const id = entry?.options?.id;
          if (id !== 'transcript-view' && id !== 'performance-usage') continue;
          if (typeof entry.inject !== 'function') continue;
          let face;
          try { face = entry.inject(); } catch { continue; }
          if (id === 'transcript-view' && typeof face?.setTranscriptView === 'function') {
            found.setTranscriptView = face.setTranscriptView;
          }
          if (id === 'performance-usage' && typeof face?.setPerformanceUsage === 'function') {
            found.setPerformanceUsage = face.setPerformanceUsage;
          }
        }
      } catch { /* 拿不到就等下一次重试 */ }
      return found;
    }

    /**
     * 把读到的配置套到本页上。返回 { applied, pending, skipped }：
     * applied = 已经套上去的项（中文名，给状态行用）；pending = 入口还没就绪的项；
     * skipped = 0.2.1 上「官方只提供写宿主入口、无法只作用于本页」而停用的项。
     * 单项失败只记一条 console.warn —— 官方组件缺席时（比如关掉了 ui-theme）整套照常跑。
     */
    function applyUiSettings(config, setters, { ctx, localOnly = false } = {}) {
      const applied = [];
      const pending = [];
      const skipped = [];
      const warn = (label, err) => {
        try { console.warn('[remote-access] 套用「' + label + '」失败：', err); } catch { /* 忽略 */ }
      };
      const run = (name, label, apply) => {
        const setter = setters[name];
        if (typeof setter !== 'function') { pending.push(label); return; }
        try { apply(setter); applied.push(label); } catch (err) { warn(label, err); }
      };
      const runLocal = (label, apply) => {
        try { apply(); applied.push(label); } catch (err) { warn(label, err); }
      };
      const themeValue = () => {
        const raw = String(config.remoteTheme ?? 'default');
        return ['dark', 'light', 'system'].includes(raw) ? raw : FACTORY_UI.setTheme;
      };
      const fontSizeValue = () => {
        const px = Number(config.remoteFontSize);
        return Number.isInteger(px) && px >= 10 && px <= 22 ? px : FACTORY_UI.setFontSize;
      };
      if (localOnly) {
        // 0.2.1：只投影到本页，绝不调用会写宿主设置的官方 setter。
        if (ctx) {
          runLocal('外观', () => projectThemeLocal(ctx, themeValue()));
          runLocal('字号大小', () => projectFontSizeLocal(ctx, config.remoteFontSize));
        } else {
          pending.push('外观', '字号大小');
        }
        skipped.push('工作步骤展示', '显示代码工作视图', '性能与用量');
      } else {
        run('setTheme', '外观', (set) => set(themeValue()));
        run('setFontSize', '字号大小', (set) => set(fontSizeValue()));
        run('setTranscriptView', '工作步骤展示', (set) => {
          const raw = String(config.remoteTranscriptView ?? 'default');
          set(['compact', 'standard', 'detailed', 'verbose'].includes(raw) ? raw : FACTORY_UI.setTranscriptView);
        });
        run('setDeveloperTools', '显示代码工作视图', (set) => {
          const raw = String(config.remoteDeveloperTools ?? 'default');
          set(raw === 'on' ? true : raw === 'off' ? false : FACTORY_UI.setDeveloperTools);
        });
        run('setPerformanceUsage', '性能与用量', (set) => {
          const raw = String(config.remotePerformanceUsage ?? 'default');
          set(['compact', 'detailed'].includes(raw) ? raw : FACTORY_UI.setPerformanceUsage);
        });
      }
      return { applied, pending, skipped };
    }

    /**
     * 「UI 设置」控制器。返回清理函数；**回环页面直接返回空清理**（与布局控制器同一个开关）。
     */
    function startUiSettingsController(ctx) {
      const noop = () => {};
      if (typeof document === 'undefined') return noop;
      let remote = false;
      try { remote = ctx?.remote?.$host?.isLoopback === false; } catch { remote = false; }
      if (!remote) return noop;

      let stopped = false;
      let config = null;
      let setters = null;
      let attempt = 0;
      let retryTimer = null;
      const offs = [];
      // 0.2.1 的官方设置会跨端写宿主；这时外观/字号只做本页投影，其余三项不覆盖。
      const localOnly = settingsPersistAcrossPages(ctx);

      /** 退避重试：次数用完就停（页面状态行会说明哪几项没接上） */
      function scheduleRetry(run, limit) {
        if (stopped) return;
        attempt += 1;
        if (attempt > limit) return;
        retryTimer = window.setTimeout(run, 300 * attempt);
      }

      /** 配置读到了就套一遍；入口没齐就重试（官方组件可能比本插件晚挂载） */
      function apply() {
        if (stopped || config === null) return;
        if (setters === null) setters = officialUiSetters(ctx);
        const result = applyUiSettings(config, setters, { ctx, localOnly });
        publishUiStatus({
          applied: result.applied,
          pending: result.pending,
          skipped: result.skipped,
          localOnly,
        });
        if (result.pending.length > 0) {
          setters = null; // 入口是「拿到就用」，缺的那几个下次重新找一遍
          scheduleRetry(apply, 8);
        }
      }

      function load() {
        if (stopped) return;
        Promise.resolve()
          .then(() => ctx.remote.settings.describe())
          .then((response) => {
            if (stopped) return;
            if (!response?.ok) throw new Error(response?.error?.message ?? '读取被拒绝');
            const value = namespaceOf(response.value)?.value ?? {};
            const next = {};
            for (const key of UI_FIELDS) next[key] = value[key];
            config = next;
            attempt = 0;
            setters = null;
            apply();
          })
          .catch((err) => {
            if (stopped) return;
            try { console.warn('[remote-access] 读「UI 设置」失败，稍后重试', err); } catch { /* 忽略 */ }
            scheduleRetry(load, 5);
          });
      }

      const on = (fn) => {
        try {
          const off = fn();
          if (typeof off === 'function') offs.push(off);
        } catch { /* 忽略 */ }
      };
      // 0.2.1：桌面端改主题也会广播 theme/change，官方 presenter 会先套宿主主题；
      // 本页的远程外观必须在它之后重新投影一次，否则手机上会瞬间跟着电脑变。
      on(() => ctx.on('theme/change', () => {
        if (!localOnly || stopped || config === null) return;
        const raw = String(config.remoteTheme ?? 'default');
        projectThemeLocal(ctx, ['dark', 'light', 'system'].includes(raw) ? raw : FACTORY_UI.setTheme);
        projectFontSizeLocal(ctx, config.remoteFontSize);
      }));
      on(() => ctx.on('connection/reset', () => { attempt = 0; setters = null; load(); }));
      on(() => ctx.remote.$on?.('settings/document-updated', () => { attempt = 0; load(); }));
      // 官方那两行的注册要等 settings.general.item 被声明之后才拿得到 → 注册一变就重试一次
      on(() => ctx.on('slots/changed', (key) => {
        if (key !== 'settings.general.item' || config === null) return;
        attempt = 0;
        setters = null;
        apply();
      }));
      // 从别处回到这个页面时重读：配置可能是在桌面上改的，这条路径上没有 document-updated 事件
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        attempt = 0;
        setters = null;
        load();
      };
      document.addEventListener('visibilitychange', onVisible);
      offs.push(() => document.removeEventListener('visibilitychange', onVisible));

      load();

      return () => {
        stopped = true;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        for (const off of offs) {
          try { off(); } catch { /* 忽略 */ }
        }
        if (localOnly) restoreHostUi(ctx);
        uiStatus = null;
      };
    }

    return {
      // 服务必须声明才能访问，否则属性访问会抛 "... without inject"
      inject: ['slots', 'configForms', 'remote', 'remote.settings'],
      apply(ctx) {
        // ui-settings 提供的共享表单控制器：同一个条目在浏览器里只有一个实例，
        // 生命周期归提供方，我们只订阅，不 dispose。
        const form = ctx.configForms.get(NS);
        const describe = ctx.configForms.describe();
        const settings = ctx.remote.settings;

        // 远程页面才有布局改造；本机页面这里直接是个空清理函数（「不动本地」的开关就在这一行）
        const stopLayout = startLayoutController(ctx);
        const stopUi = startUiSettingsController(ctx);
        // 反过来：只有本机页面才上报窗口可见性（安卓外壳靠它决定要不要弹通知）
        const stopPresence = startPresenceReporter(ctx);
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => stopLayout);
          if (typeof ctx.effect === 'function') ctx.effect(() => () => { stopLayout(); stopUi(); stopPresence(); });
        } catch { /* 忽略 */ }

        /**
         * 远程页面（手机）读：Remote 通道。
         * ctx.remote.* 返回的是 RemoteResult 信封（`{ ok, value }` / `{ ok:false, error }`），
         * 不是裸数据 —— 官方镜像同样是 `response.ok ? response.value : response.error.message`。
         * 信封当数据用，就会「找不到命名空间 → 页面全空/全 0」。
         */
        async function readRemote() {
          const response = await settings.describe();
          if (!response?.ok) throw new Error(response?.error?.message ?? '读取被拒绝');
          const ns = namespaceOf(response.value);
          return { config: ns?.value ?? {}, revision: ns?.revision };
        }

        /** 远程页面写：交给 Host 网关去跑（写盘完成才返回）；value 是单个命名空间视图 */
        async function writeRemote(changed, revision) {
          const ops = Object.entries(changed).map(([key, value]) => ({ op: 'set', path: [key], value }));
          const response = await settings.mutate(NS, ops, revision);
          if (!response?.ok) throw new Error(response?.error?.message ?? '写入被拒绝');
          const view = response.value;
          return { config: view?.value ?? { ...changed }, revision: view?.revision };
        }

        function Panel() {
          const [snap, setSnap] = React.useState(() => form.getSnapshot());
          const [remote, setRemote] = React.useState(null);
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          // 「UI 设置」「缓存」是两层可折叠的下一级菜单，默认都收起
          const [groupsOpen, setGroupsOpen] = React.useState({});
          const toggleGroup = (id) => setGroupsOpen((open) => ({ ...open, [id]: open[id] !== true }));
          const cacheOpen = groupsOpen.cache === true;
          const revisionRef = React.useRef(snap.revision);

          // 回环页面用 configForms（官方通道）；拿不到就退到 Remote 通道（手机）
          const viaForms = snap.status === 'ready' && snap.writable === true;
          const source = viaForms ? snap.value : remote?.config;

          /**
           * 页脚那句自检：本页跑的是哪一份客户端代码，以及电脑那边的通知接口在不在。
           *
           * 只在远程页面探一次（本机页面不需要通知，也不该去打这个端点）。
           * 这是「为什么手机上没弹通知」这类问题最省事的答案：代码旧了 / 宿主旧了 / 开关关了，
           * 三种原因在这里一眼能分开 —— 不必再让人去猜是网络还是插件。
           */
          const [linkNote, setLinkNote] = React.useState('');
          React.useEffect(() => {
            if (viaForms || typeof window.fetch !== 'function') return undefined;
            let alive = true;
            (async () => {
              try {
                const res = await window.fetch('/__remote_access__/notify?wait=0', { cache: 'no-store' });
                if (!alive) return;
                if (res.status === 404) {
                  setLinkNote('电脑上的插件还没有通知接口（1.3.1 起才有）→ 更新插件并重启一次 DSH');
                  return;
                }
                if (res.status === 401 || res.status === 403) {
                  setLinkNote('通知接口需要重新解锁：刷新本页、再输一次访问密码');
                  return;
                }
                const data = await res.json().catch(() => null);
                if (!alive) return;
                if (!res.ok || data === null) {
                  setLinkNote(`通知接口返回 HTTP ${res.status}`);
                  return;
                }
                const host = data.enabled === false
                  ? '电脑上关掉了「提问时通知手机」'
                  : '电脑上的插件已支持提问通知 ✓';
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
                    `通知${phone.notifications ? '已开' : '没开'}`,
                    `提问通道=${phone.importance}${bannerOk ? '' : '（弹不出来）'}`,
                  ];
                  // 「任务结束」是单独一条通道，重要性也分开报（老 APK 不带这个字段，就只说提问那条）
                  if (phone.importanceFinish !== undefined) {
                    parts.push(`结束通道=${phone.importanceFinish}${finishOk ? '' : '（弹不出来）'}`);
                  }
                  phoneNote = ` · 手机端 App ${phone.app}：${parts.join('、')}`;
                }
                setLinkNote(host + phoneNote);
              } catch {
                if (alive) setLinkNote('读不到电脑上的插件状态');
              }
            })();
            return () => { alive = false; };
          }, [viaForms]);

          React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), []);

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
            if (viaForms) {
              setCacheNote('本机页面不走这个缓存代理：手机上打开这一组时，这里会显示那边实际生效的口径');
              return;
            }
            if (typeof window.fetch !== 'function') return;
            if (reset) setCacheBusy(true);
            try {
              const res = await window.fetch(`/__remote_access__/cache${reset ? '?reset=1' : ''}`, { cache: 'no-store' });
              if (alive && !alive()) return;
              if (res.status === 404) {
                setCacheNote('电脑上的插件还没有缓存接口（1.3.8 起才有）→ 更新插件并重启一次 DSH');
                return;
              }
              if (res.status === 401 || res.status === 403) {
                setCacheNote('缓存接口需要重新解锁：刷新本页、再输一次访问密码');
                return;
              }
              const data = await res.json().catch(() => null);
              if (alive && !alive()) return;
              if (!res.ok || data === null) {
                setCacheNote(`缓存接口返回 HTTP ${res.status}`);
                return;
              }
              const policy = data.policy ?? {};
              const stats = data.stats ?? {};
              const head = policy.enabled === false
                ? '电脑上关掉了手机端缓存'
                : `内容寻址 immutable · 无校验器 ${policy.ttlMinutes} 分钟 · ` +
                  `探针${policy.probe === false ? '关' : '开'}`;
              const traffic = data.traffic ?? null;
              const trafficText = traffic
                ? ` · 本轮送出 ${humanBytes(traffic.totalOut)}（其中无缓存口径 ${humanBytes(traffic.uncachedOut)}）` +
                  `、WebSocket ${humanBytes(traffic.wsOut)}`
                : '';
              setCacheNote(`${head} · 本次 304 ${stats.notModified ?? 0} 次 / 小资源 ${stats.inline ?? 0} / 探针 ${stats.probe ?? 0}${trafficText}`);
              setCacheInfo({ policy, stats, traffic, at: Date.now() });
            } catch {
              if (!alive || alive()) setCacheNote('读不到电脑上的缓存状态');
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
          }, [cacheOpen, viaForms]);

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

          React.useEffect(() => {
            if (viaForms) {
              setRemote(null);
              return undefined;
            }
            let alive = true;
            let timer;
            let attempt = 0;
            // 刚进页面时 Remote 连接可能还没就绪：失败就重试几次；
            // 并且跟着官方镜像，在 connection/reset 与 settings/document-updated 时重读。
            const load = async () => {
              try {
                const next = await readRemote();
                if (!alive) return;
                setRemote(next);
                setStatus('');
              } catch (err) {
                if (!alive) return;
                try { console.error('[remote-access] 读远端配置失败', err); } catch { /* 忽略 */ }
                attempt += 1;
                if (attempt < 4) {
                  timer = setTimeout(load, 250 * attempt);
                  return;
                }
                setRemote({ config: {}, revision: undefined });
                setStatus(`读不到配置：${err?.message ?? err}`);
              }
            };
            load();
            let offReset;
            let offUpdated;
            try { offReset = ctx.on('connection/reset', () => { attempt = 0; load(); }); } catch { /* 忽略 */ }
            try {
              offUpdated = ctx.remote.$on?.('settings/document-updated', () => {
                attempt = 0;
                load();
              });
            } catch { /* 忽略 */ }
            return () => {
              alive = false;
              clearTimeout(timer);
              try { offReset?.(); } catch { /* 忽略 */ }
              try { offUpdated?.(); } catch { /* 忽略 */ }
            };
          }, [viaForms]);

          const current = draft ?? draftFrom(source);
          const setField = (key, value) => setDraft({ ...current, [key]: value });

          const onSave = async () => {
            // 先本地校验访问密码：Host 只认 4–12 位字母数字，不合规的值会被它丢掉。
            // 以前这里直接写盘 → 值被静默丢弃 → 用户以为设好了密码，手机上却撞见 DSH 那句英文 401。
            // 现在不合规就地拦下、说清规则，绝不写盘。
            const code = String(current.accessCode ?? '').trim();
            if (code && !ACCESS_CODE_RE.test(code)) {
              setStatus('访问密码没改：只接受 4–12 位数字或字母（不能有空格和符号）。');
              return;
            }
            setBusy(true);
            setStatus('保存中…');
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
                setStatus('没有改动。');
                return;
              }
              if (viaForms) {
                const ops = Object.entries(changed).map(([key, value]) => ({ op: 'set', path: [key], value }));
                const accepted = await form.mutate(ops, snap.revision);
                if (accepted !== true) throw new Error('写入被拒绝，请点「重新读取」后再试一次。');
              } else {
                setRemote(await writeRemote(changed, remote?.revision));
              }
              setDraft(null);
              setStatus(`已保存 ${count} 项。`);
            } catch (err) {
              try { console.error('[remote-access] 保存失败', err); } catch { /* 忽略 */ }
              setStatus(`保存失败：${err?.message ?? err}`);
            } finally {
              setBusy(false);
            }
          };

          const onReload = () => {
            setStatus('');
            setDraft(null);
            if (viaForms) {
              try {
                Promise.resolve(describe?.load?.()).then(() => setSnap(form.getSnapshot()));
              } catch {
                setSnap(form.getSnapshot());
              }
              return;
            }
            readRemote()
              .then(setRemote)
              .catch(() => setRemote({ config: {}, revision: undefined }));
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
              ? `暂时没接上官方入口：${uiState.pending.join('、')}`
              : uiState.localOnly
                ? `已只在本页应用：${uiState.applied.join('、') || '无'}` +
                  (uiState.skipped.length > 0
                    ? `；${uiState.skipped.join('、')} 在 DSH 0.2.1 起跟随电脑设置（官方只提供写宿主入口，本插件不替你改电脑）`
                    : '')
                : uiState.applied.length > 0
                  ? `已套用到本页：${uiState.applied.join('、')}`
                  : '本页无需套用'
            : '保存后，在远程页面打开时生效（本机界面不受影响）';

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
              `${groupsOpen[id] === true ? '▾' : '▸'} ${title}${changed > 0 ? `（已改 ${changed} 项）` : ''}`,
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
          const flagText = (on, off) => (on ? '开 · 已接管' : `关 · ${off}`);
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
              h('div', { style: blockTitleStyle }, '生效策略'),
              statRow('内容寻址产物', 'immutable（一年内不重取）'),
              statRow('其它静态资源', cachePolicy ? `${cachePolicy.ttlMinutes} 分钟（过期先出旧的，后台核对一次）` : '—'),
              statRow('过期核对', cachePolicy ? (cachePolicy.probe === false ? '长度 + 类型' : '首/尾各 64 KB 片段指纹') : '—'),
              statRow('no-store 大媒体', cachePolicy ? flagText(cachePolicy.overrideNoStore, '尊重上游') : '—'),
              statRow('整段 Range', cachePolicy ? flagText(cachePolicy.overrideRange, '原样透传 206') : '—'),
              statRow('正文落盘', cachePolicy && cachePolicy.storesOnHost === false ? '不落宿主盘（零字节）' : '—'),
            ),
            // ---- 本次会话计数
            h(
              'div',
              { style: blockStyle },
              h('div', { style: blockTitleStyle }, '本次会话'),
              statRow('304（零字节）', cacheCounters ? `${cacheCounters.notModified} 次` : '—'),
              statRow('小资源缓冲', cacheCounters ? `${cacheCounters.inline} 次` : '—'),
              statRow('片段探针', cacheCounters ? `${cacheCounters.probe} 次（失败 ${cacheCounters.probeFail}）` : '—'),
              statRow('接管 no-store', cacheCounters ? `${cacheCounters.override ?? 0} 次` : '—'),
            ),
            // ---- 本轮流量账
            h(
              'div',
              { style: blockStyle },
              h('div', { style: blockTitleStyle }, '本轮流量账（按 URL 排字节）'),
              ...(cacheTraffic
                ? [
                    h(
                      'div',
                      { key: 'traffic-total', style: { ...statRowStyle, marginBottom: 6 } },
                      h('span', { style: statLabelStyle }, '送出 / 收到'),
                      h(
                        'span',
                        { style: statValueStyle },
                        `${humanBytes(cacheTraffic.totalOut)} / ${humanBytes(cacheTraffic.totalIn)}` +
                          `　其中无缓存口径 ${humanBytes(cacheTraffic.uncachedOut)}` +
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
                      h('span', { style: { textAlign: 'right' } }, '送出'),
                      h('span', { style: { textAlign: 'right' } }, '次数'),
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
                            uncached > 0 ? `　（${uncached} 次无缓存口径 → 下次仍会重传）` : null,
                          ),
                        ),
                        row.reason
                          ? h(
                              'div',
                              { style: { fontSize: 11, opacity: 0.55, paddingLeft: phone ? 0 : 116 } },
                              `原因：${row.reason}`,
                            )
                          : null,
                      );
                    }),
                  ]
                : [h('div', { key: 'traffic-none', style: statRowStyle }, h('span', { style: statLabelStyle }, cacheNote || '—'))]),
              !viaForms
                ? h(
                    'div',
                    { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                    h(
                      'button',
                      { type: 'button', style: buttonStyle, disabled: cacheBusy || busy, onClick: () => readCacheInfo(false, null) },
                      cacheBusy ? '读取中…' : '刷新',
                    ),
                    h(
                      'button',
                      { type: 'button', style: buttonStyle, disabled: cacheBusy || busy, onClick: () => readCacheInfo(true, null) },
                      cacheBusy ? '处理中…' : '清零本轮统计',
                    ),
                  )
                : null,
              !viaForms
                ? h(
                    'div',
                    { style: { marginTop: 6, fontSize: 11, opacity: 0.55, lineHeight: 1.7 } },
                    '用法：点「清零本轮统计」→ 完全退出 App（从最近任务划掉）→ 重新打开，回来后这里显示的就是那一轮的真实花费。' +
                      '实时轮询（如音频频谱）与会话通道（聊天图片走的 RPC）不在缓存射程内，它们出现大数字属正常。',
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
            renderGroup('ui', 'UI 设置', uiHint, uiFields, uiChanged),
            renderGroup(
              'cache',
              '缓存',
              cacheNote || `默认：内容寻址的产物钉一年、其余 ${DEFAULTS.cacheTtlMinutes} 分钟；正文一律不落宿主盘`,
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
              h('button', { type: 'button', style: buttonStyle, onClick: onSave, disabled: busy }, busy ? '保存中…' : '保存'),
              h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: onReload }, '重新读取'),
              status ? h('span', { style: { opacity: 0.9 } }, status) : null,
            ),
            // 自检那行：本页代码的版本 + 电脑那端通知接口的状态（排「怎么没通知」时先看它）
            h(
              'div',
              { style: { marginTop: 10, fontSize: 12, opacity: 0.7, lineHeight: 1.6 } },
              `本页客户端 ${CLIENT_VERSION}${linkNote ? ` · ${linkNote}` : ''}`,
            ),
          );
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: NS, order: 100, label: '远程访问' }, Panel),
        );
      },
    };
  },
});
