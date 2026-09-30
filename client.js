/**
 * dsh-remote-access 的浏览器半区：在「插件」页里挂一张说明卡片。
 *
 * 参数表单由 DSH 插件页自己渲染（因为 Host 半区声明了 Config）：
 * 在插件页找到本插件那一行（或它的组合包卡片），点「配置」即可改。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const rowStyle = { lineHeight: 1.7, marginTop: 6 };
    const codeStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      padding: '1px 4px',
      borderRadius: 3,
      background: 'rgba(127,127,127,0.18)',
    };
    const code = (text, key) => h('code', { key, style: codeStyle }, text);

    function Card() {
      return h(
        'div',
        { style: { padding: '4px 0' } },
        h('div', { style: { fontWeight: 600 } }, '远程访问入口（限网段）'),
        h(
          'div',
          { style: rowStyle },
          '把本机 DSH 的网页界面开放给你指定的网段（默认 Tailscale ',
          code('100.64.0.0/10'),
          '）。只监听该网段里属于本机的地址，网段外的对端一律 403；访问仍需 DSH 自己的令牌。',
        ),
        h(
          'div',
          { style: rowStyle },
          '带票网址写在 DSH 家目录的 ',
          code('remote-access-url.txt'),
          '：手机（需在同一 tailnet）打开那条网址一次，之后 30 天免票，直接访问 ',
          code('http://<地址>:<端口>/'),
          '。',
        ),
        h(
          'div',
          { style: rowStyle },
          '改参数：在本页找到 ',
          code('remote-access'),
          ' 那一行的「配置」，表单里可以改网段、监听地址、端口、上游、落地文件与日志级别。改完保存即生效。',
        ),
        h(
          'div',
          { style: { ...rowStyle, opacity: 0.8 } },
          '安全：',
          code('allowCidrs'),
          ' 是唯一的边界开关；带票网址等于本机操作权限，别外传。自测命令：',
          code('node tools/test-remote-access.mjs'),
          '。',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // plugins.item 是插件页声明的 slot；inject 会等它出现（页面注册时才渲染）
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            { name: 'plugins.item', id: 'remote-access-card', order: 100, label: '远程访问入口' },
            Card,
          ),
        );
      },
    };
  },
});
