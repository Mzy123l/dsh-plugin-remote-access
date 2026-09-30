/**
 * dsh-remote-access 的浏览器半区：在「插件」页里提供本插件的配置页。
 *
 * 注册位置（DSH 插件页声明的槽位）：
 *  - plugins.bundle.config  key = 包名        → 显示在「本组合包」的详情页里
 *  - plugins.row.config     key = 包名#行id   → 给 remote-access 这一行加一个「配置」控件
 *
 * DSH 官方文档写明 plugins.item 是「官方插件卡片」那份账本（被官方设置页占用），
 * 第三方包的配置应注册到上面两个 keyed 槽位，因此这里不用 plugins.item。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = '@local/dsh-remote-access';
    const ROW_ID = 'remote-access';

    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      padding: '1px 4px',
      borderRadius: 3,
      background: 'rgba(127,127,127,0.18)',
    };
    const code = (text, key) => h('code', { key, style: mono }, text);
    const block = (style, ...children) =>
      h('div', { style: { lineHeight: 1.7, marginTop: 8, ...style } }, children);

    /** 可配置参数（默认值 + 说明）；真实生效值以 Host 半区读取到的为准 */
    const PARAMS = [
      ['enabled', 'true', '总开关：关掉即停止监听，不必卸载插件'],
      ['allowCidrs', "['100.64.0.0/10']", '允许来访的网段 —— 唯一的安全边界；也决定自动监听哪些本机地址'],
      ['denyCidrs', '[]', '白名单内的例外黑名单'],
      ['listen', "['auto']", '要监听的本机地址；auto = allowCidrs 内属于本机的地址'],
      ['port', '0', '监听端口；0 = 系统随机（固定成 19388 之类，手机网址就稳定了）'],
      ['maxConnections', '64', '并发连接上限；0 = 不限'],
      ['allowWebSocket', 'true', '是否透传 WebSocket（界面实时推送需要它）'],
      ['upstream', 'auto', 'DSH 界面地址，可写 http://127.0.0.1:19387'],
      ['rewriteHost', 'true', '把 Host/Origin 改写成上游地址'],
      ['forwardClientHeaders', 'true', '转发 x-forwarded-for / x-forwarded-proto'],
      ['timeoutMs', '0', '上游请求超时（毫秒）；0 = 不超时'],
      ['urlFile', "''", '带票网址写到哪；空 = DSH 家目录的 remote-access-url.txt，off = 不写'],
      ['printUrl', 'true', '同时把结果打到 DSH 日志'],
      ['logLevel', 'info', 'silent / info / debug'],
    ];

    function ParamTable() {
      return h(
        'div',
        { style: { marginTop: 8, overflowX: 'auto' } },
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'minmax(140px, max-content) minmax(120px, max-content) 1fr',
              gap: '4px 12px',
              alignItems: 'baseline',
            },
          },
          ...PARAMS.flatMap(([name, def, desc]) => [
            h('div', { key: `${name}-n` }, code(name)),
            h('div', { key: `${name}-d`, style: { opacity: 0.7 } }, code(def)),
            h('div', { key: `${name}-t` }, desc),
          ]),
        ),
      );
    }

    function Card() {
      return h(
        'div',
        { style: { padding: '2px 0' } },
        h('div', { style: { fontWeight: 600 } }, '远程访问入口（限网段）'),
        block(
          {},
          '把本机 DSH 的网页界面开放给你指定的网段（默认 Tailscale ',
          code('100.64.0.0/10'),
          '）：只监听该网段里属于本机的地址，网段外的对端一律 403；访问仍需 DSH 自己的令牌。',
        ),
        block(
          {},
          '带票网址写在 DSH 家目录的 ',
          code('remote-access-url.txt'),
          '：在手机（需在同一 tailnet）打开那条网址一次，之后 30 天免票，直接访问 ',
          code('http://<地址>:<端口>/'),
          '。',
        ),
        h('div', { style: { marginTop: 12, fontWeight: 600 } }, '可配置参数'),
        h(ParamTable),
        block(
          { marginTop: 12 },
          '怎么改：编辑 profile 里的 ',
          code('cordis.patch.yml'),
          '，找到 ',
          code('id: remote-access'),
          ' 这一行的 ',
          code('config'),
          ' 覆盖即可。保存后插件会重新挂载：关掉旧端口、按新参数重开，状态文件随之更新。',
        ),
        block(
          { opacity: 0.85 },
          '安全：',
          code('allowCidrs'),
          ' 是唯一的边界开关，写宽了等于把本机命令执行权限放开；带票网址等于本机操作权限，别外传。自测：',
          code('node tools/test-remote-access.mjs'),
          '。',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 组合包详情页里的配置区（key = npm 包名）
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, order: 100 }, Card),
        );
        // 给这一行加「配置」控件，点开就是这一页（key = <包名>#<行 id>）
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ROW_ID}`, order: 100 }, Card),
        );
      },
    };
  },
});
