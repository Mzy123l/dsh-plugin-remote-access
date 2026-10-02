/**
 * dsh-remote-access-cidr 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
 *
 * 注册位置：settings.section（设置左侧导航的一页）。
 *
 * 两条读写通道，按页面所在位置自动选：
 *   1. 本机（回环）页面 —— 官方通道 ctx.configForms.get('remote-access')：
 *      读 form.getSnapshot() → { status, value, revision, writable, mode }，
 *      写 form.mutate([{ op:'set', path:[字段], value }], revision) → Promise<boolean>。
 *   2. 手机等远程页面 —— DSH 的客户端策略让 configForms 在非回环页面恒为 unavailable
 *      （ui-settings 里 `persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`），
 *      但 Remote 通道本身是通的（那一页显示的数值就是 remote.settings.describe 来的），
 *      所以直接调 ctx.remote.settings.describe() / mutate()：
 *      写盘跑在 Host 网关自己的上下文里（不会撞上 HMR 事务），而且**等写盘完成才返回**，
 *      拿到的就是新值。两条路写的是同一个地方（profile 的 cordis.patch.yml）。
 *
 * 页面上只说人话：失败给一句「下一步做什么」，内部状态只写开发者控制台。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-access-cidr',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'remote-access';

    // 表单字段（与 index.js 的 Config 字段对表由 tools/check-config-schema.mjs 保证）
    const FIELDS = [
      { key: 'enabled', type: 'boolean', label: '启用' },
      { key: 'allowCidrs', type: 'list', label: '允许的网段', placeholder: '换行分割' },
      { key: 'denyCidrs', type: 'list', label: '排除的网段', placeholder: '换行分割' },
      { key: 'port', type: 'number', label: '端口', placeholder: '0=随机' },
      { key: 'maxConnections', type: 'number', label: '并发上限', placeholder: '0=不限制' },
      {
        key: 'logLevel',
        type: 'select',
        label: '日志级别',
        options: [
          { value: 'silent', label: '静默' },
          { value: 'info', label: '普通' },
          { value: 'debug', label: '详细' },
        ],
      },
      { key: 'accessCode', type: 'password', label: '访问密码', placeholder: '4-12位数字或字母' },
      {
        key: 'remoteLayout',
        type: 'select',
        label: '远程UI布局',
        options: [
          { value: 'phone', label: '手机（默认：只做可读性与手势）' },
          { value: 'phone-strong', label: '手机（增强：窄图标栏 + 侧栏抽屉）' },
          { value: 'desktop', label: '电脑' },
          { value: 'auto', label: '自动' },
        ],
      },
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
     * 手机布局的全部样式。挂在 html[data-ra-layout="phone"] 之下，所以本机页面
     * 拿不到这个属性、也就永远匹配不上任何一条规则（这就是「不动本地」的实现方式）。
     */
    const PHONE_CSS = `
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
  /* 工作区/会话名往往很长，320px 在 390px 屏上会挤成两行；给到 88vw 但右边仍留出可见的正文 */
  width: min(88vw, 340px) !important;
  z-index: 70 !important;
  border-right: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3)) !important;
  box-shadow: 0 18px 48px rgba(0,0,0,0.45) !important;
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
  max-width: 100vw !important;
  overflow-x: hidden !important;
  padding-left: env(safe-area-inset-left, 0px) !important;
  padding-right: env(safe-area-inset-right, 0px) !important;
  padding-bottom: env(safe-area-inset-bottom, 0px) !important;
  overscroll-behavior: contain;
}
/* 单独一条：只把「抬到正文之上」这件事放进增强模式，实底那条留在保守模式 */
html[data-ra-layout="phone"] [data-sidebar-right-panel] { z-index: 65 !important; /*strong*/ }

/* 手机上这两个浮层必须是**不透明**的。
   DSH 的默认表面是「玻璃」—— 有意让壁纸透出来；桌面三栏时很好看，但手机上它俩整个盖在正文上，
   于是两层文字糊在一起（左抽屉看起来像没画背景，右栏把底下的输入框/底部统计也透出来）。
   这里只给实底。曾经还叠过 backdrop-filter 的 blur()，但那个属性会把这一层推进独立的合成路径，
   在 Electron 视图 / 移动端 GPU 上的风险明显更高（我们排查过一例「DOM 正常但画面不更新」），
   而实底本身已经解决可读性 —— 不值得为一点观感换那个风险。
   装了壁纸插件时脚本还会借用它自己的「左侧栏覆盖」玻璃配方，那时观感与其余面板一致。 */
html[data-ra-layout="phone"][data-ra-drawer] [data-ra-sidebar],
html[data-ra-layout="phone"] [data-sidebar-right-panel] {
  background: var(--dsw-alias-bg-base, #101a36) !important;
}

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

      const matches = (query) => {
        try {
          return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches === true : false;
        } catch {
          return false;
        }
      };

      /** auto 的判据：够窄 或 有触摸指针（后者能兜住「宽屏但确实是手机/平板」） */
      function effectiveOf(nextMode) {
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
      function phoneCss(strong, skip) {
        const skips = skip || [];
        if (strong && skips.length === 0) return PHONE_CSS.replace(/\/\*strong\*\//g, '');
        return PHONE_CSS.split('}')
          .map((block) => block.trim())
          .filter((block) => {
            if (block.length === 0) return false;
            if (!strong && block.includes('/*strong*/')) return false;
            return !skips.some((word) => word && block.includes(word));
          })
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

      /** 排障用：?skip=z-index,grid-template 可在增强模式里按关键字丢掉对应规则块 */
      function raSkip() {
        try {
          return (new URLSearchParams(window.location.search).get('skip') || '')
            .split(',')
            .map((word) => word.trim())
            .filter(Boolean);
        } catch {
          return [];
        }
      }

      function injectStyle(strong, skip) {
        let tag = document.querySelector(`style[data-ra-layout-css="${LAYOUT_STYLE_ID}"]`);
        if (!tag) {
          tag = document.createElement('style');
          tag.dataset.raLayoutCss = LAYOUT_STYLE_ID;
          document.head.appendChild(tag);
        }
        tag.textContent = phoneCss(strong, skip);
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
        const closeBtn = document.querySelector('[data-slot="settings.close"]');
        if (!closeBtn) return;
        let content = closeBtn;
        while (content && content.parentElement) {
          const parent = content.parentElement;
          const nav = [...parent.children].find((child) => child.tagName === 'NAV');
          if (nav) {
            parent.setAttribute('data-ra-settings-panel', '');
            content.setAttribute('data-ra-settings-content', '');
            nav.setAttribute('data-ra-settings-nav', '');
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
          try { document.body.removeAttribute('data-we-sidebar-glass'); } catch { /* 忽略 */ }
          const scrimOff = document.getElementById(SCRIM_ID);
          if (scrimOff) scrimOff.removeAttribute('data-open');
          return;
        }
        // 「左侧栏覆盖」是壁纸引擎自己的开关：它做的就是给 body 挂这个属性，让原生侧栏跟着玻璃配方走
        // （不那么透出壁纸）。手机端直接借用它 —— 只打在**远程页面**上，所以本机观感不受影响；
        // 没装壁纸插件时这行什么也不做，上面 CSS 里那份实底兜底仍然生效。
        try { document.body.setAttribute('data-we-sidebar-glass', 'on'); } catch { /* 忽略 */ }
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
        const strong =
          layout === 'phone' && (override === 'strong' || (override !== 'safe' && mode === 'phone-strong'));
        const skip = layout === 'phone' ? raSkip() : [];
        const signature = `${strong ? `${layout}:strong` : layout}${skip.length ? `|${skip.join(',')}` : ''}`;
        if (signature === applied) {
          syncDom();
          return;
        }
        applied = signature;
        document.documentElement.setAttribute('data-ra-layout', layout);
        if (strong) document.documentElement.setAttribute('data-ra-strong', '');
        else document.documentElement.removeAttribute('data-ra-strong');
        if (layout === 'phone') injectStyle(strong, skip);
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
            const next = String(namespaceOf(response.value)?.value?.remoteLayout ?? 'auto');
            attempt = 0;
            mode = ['auto', 'phone', 'desktop'].includes(next) ? next : 'auto';
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

      function onTouchStart(e) {
        if (!phoneNow() || e.touches.length !== 1) { swipe = null; return; }
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
          // 向右滑：收起右栏优先（它盖在最上面），否则打开左抽屉
          if (rightOpen) { clickLabel('收起右侧边栏'); return; }
          if (!drawer) clickLabel('打开侧边栏');
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

      // 配置被改（本机设置页保存 / 另一台设备改了）→ 立刻生效，不必刷新
      const offs = [];
      try { offs.push(ctx.on('connection/reset', () => { attempt = 0; loadMode(); })); } catch { /* 忽略 */ }
      try {
        const off = ctx.remote.$on?.('settings/document-updated', () => { attempt = 0; loadMode(); });
        if (typeof off === 'function') offs.push(off);
      } catch { /* 忽略 */ }

      return () => {
        stopped = true;
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
        try { observer?.disconnect(); } catch { /* 忽略 */ }
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
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => stopLayout);
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
          const revisionRef = React.useRef(snap.revision);

          // 回环页面用 configForms（官方通道）；拿不到就退到 Remote 通道（手机）
          const viaForms = snap.status === 'ready' && snap.writable === true;
          const source = viaForms ? snap.value : remote?.config;

          React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), []);

          // 布局在「手机 ↔ 电脑」之间切换时（改了这一项、或横竖屏转了）让表单跟着重排
          const [, bumpLayout] = React.useState(0);
          React.useEffect(() => subscribeLayout(() => bumpLayout((n) => n + 1)), []);

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

          const rows = FIELDS.flatMap((field) => {
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
            return [h('div', { key: `${field.key}-l`, style: labelStyle }, field.label), input];
          });

          return h(
            'div',
            { style: { padding: phone ? '4px 2px' : '2px 0' } },
            h('div', { style: rowStyle }, rows),
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
          );
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: NS, order: 100, label: '远程访问' }, Panel),
        );
      },
    };
  },
});
