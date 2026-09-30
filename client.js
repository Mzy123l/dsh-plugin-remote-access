/**
 * dsh-remote-access 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
 *
 * 注册位置：settings.section（设置左侧导航的一页）。插件页那两处（plugins.row.config /
 * plugins.bundle.config）按使用要求已移除。
 *
 * 写盘通道 = 官方唯一通道：ctx.configForms.get(命名空间)
 *   命名空间就是 Loader 条目的 options.id，也就是 cordis.patch.yml 里那一行的 id（remote-access）。
 *   读：form.getSnapshot() → { status, value, base, user, revision, writable, mode }
 *   写：form.mutate([{ op:'set', path:[字段], value }], revision) → Promise<boolean>
 *   Host 侧把值落到 profile 的 patch 层（cordis.patch.yml），重启 DSH 后生效。
 *
 * 页面上只说人话：失败给一句「用户下一步该做什么」，内部状态（status / mode / revision 之类）
 * 只往开发者控制台写，不摆在界面上。configForms 在命名空间没被服务时只会静默返回 false。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'remote-access';
    const STATUS_HINT = 'DSH 家目录\\remote-access-url.txt';

    const FIELDS = [
      { key: 'enabled', type: 'boolean', label: '启用', hint: '关掉即停止监听，不必卸载插件' },
      { key: 'allowCidrs', type: 'list', label: '允许的网段', hint: '唯一的安全边界；也是自动选择监听地址的依据。一行一个或用逗号分隔' },
      { key: 'denyCidrs', type: 'list', label: '排除的网段', hint: '白名单内的例外黑名单，可留空' },
      { key: 'listen', type: 'list', label: '监听地址', hint: 'auto 或留空 = 只监听允许网段里属于本机的地址' },
      { key: 'port', type: 'number', label: '监听端口', hint: '0 = 系统随机；固定成 19388 之类，手机网址就稳定了' },
      { key: 'maxConnections', type: 'number', label: '并发上限', hint: '0 = 不限制' },
      { key: 'allowWebSocket', type: 'boolean', label: '透传 WebSocket', hint: '界面实时推送需要它，一般别关' },
      { key: 'upstream', type: 'string', label: 'DSH 界面地址', hint: 'auto = 自动探测；也可写 http://127.0.0.1:19387' },
      { key: 'rewriteHost', type: 'boolean', label: '改写 Host/Origin', hint: '改写为上游地址，省去改别的插件配置' },
      { key: 'forwardClientHeaders', type: 'boolean', label: '转发 x-forwarded-*', hint: '只在需要上游看真实来源时打开' },
      { key: 'timeoutMs', type: 'number', label: '上游超时(ms)', hint: '0 = 不超时' },
      { key: 'urlFile', type: 'string', label: '状态文件路径', hint: `留空 = ${STATUS_HINT}；填 off = 不写` },
      { key: 'printUrl', type: 'boolean', label: '同时写日志', hint: '把监听结果与带票网址打到 DSH 日志' },
      { key: 'logLevel', type: 'string', label: '日志级别', hint: 'silent / info / debug' },
    ];

    const DEFAULTS = {
      enabled: true,
      allowCidrs: ['100.64.0.0/10'],
      denyCidrs: [],
      listen: ['auto'],
      port: 0,
      maxConnections: 64,
      allowWebSocket: true,
      upstream: 'auto',
      rewriteHost: true,
      forwardClientHeaders: true,
      timeoutMs: 0,
      urlFile: '',
      printUrl: true,
      logLevel: 'info',
    };

    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      padding: '1px 4px',
      borderRadius: 3,
      background: 'rgba(127,127,127,0.18)',
    };
    const code = (text, key) => h('code', { key, style: mono }, text);
    const note = (style, ...children) =>
      h('div', { style: { lineHeight: 1.7, marginTop: 8, ...style } }, children);

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

    /** 把 Host 快照里的 value 摊成草稿（缺字段回落到本地默认值，保证表单永远可编辑） */
    function draftFrom(value) {
      const source = value && typeof value === 'object' ? value : {};
      const next = {};
      for (const field of FIELDS) next[field.key] = decode(field, source[field.key]);
      return next;
    }

    /** 保存失败时说人话：告诉用户下一步做什么，而不是抛内部状态码 */
    function failureHint(snap) {
      if (snap?.status === 'loading') return '设置还在读取，请稍等一下再保存。';
      if (snap?.status === 'unavailable') {
        return '这一行的配置现在不能在这里修改：如果是从别的设备打开的页面，请回到运行 DSH 的那台机器上改。';
      }
      return '这一行的配置暂时不可写。';
    }

    return {
      // 服务必须声明才能访问，否则属性访问会抛 "... without inject"。
      // remote / remote.settings 已不再需要：读写都走 configForms（它内部持有 remote.settings）。
      inject: ['slots', 'configForms'],
      apply(ctx) {
        // ui-settings 提供的共享表单控制器：同一个条目在浏览器里只有一个实例，
        // 生命周期归提供方，我们只订阅，不 dispose。
        const form = ctx.configForms.get(NS);
        const describe = ctx.configForms.describe();
        const reload = () => {
          try {
            return Promise.resolve(describe?.load?.());
          } catch {
            return Promise.resolve();
          }
        };

        function Panel() {
          const [snap, setSnap] = React.useState(() => form.getSnapshot());
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const revisionRef = React.useRef(snap.revision);

          // 订阅共享表单：Host 每次刷新设置文档都会推一个新快照过来
          React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), []);

          // 快照换版（首次就绪、外部改动、保存回执）→ 丢掉草稿，用新值重画
          React.useEffect(() => {
            if (revisionRef.current === snap.revision) return;
            revisionRef.current = snap.revision;
            setDraft(null);
          }, [snap.revision]);

          const current = draft ?? draftFrom(snap.value);
          const setField = (key, value) => setDraft({ ...current, [key]: value });

          const onSave = async () => {
            setBusy(true);
            setStatus('保存中…');
            try {
              const now = form.getSnapshot();
              if (now.status !== 'ready') throw new Error(failureHint(now));
              if (now.writable !== true) {
                throw new Error('这一行的配置现在不能在这里修改：如果是从别的设备打开的页面，请回到运行 DSH 的那台机器上改。');
              }
              const ops = [];
              for (const field of FIELDS) {
                const next = encode(field, current[field.key]);
                if (JSON.stringify(next) !== JSON.stringify(now.value?.[field.key])) {
                  ops.push({ op: 'set', path: [field.key], value: next });
                }
              }
              if (ops.length === 0) {
                setStatus('没有改动，未写入。');
                return;
              }
              const accepted = await form.mutate(ops, now.revision);
              if (accepted !== true) {
                throw new Error('写入被拒绝（配置可能刚被别处改过），请点「重新读取」后再试一次。');
              }
              setStatus(`已保存 ${ops.length} 项，重启 DSH 后生效。`);
            } catch (err) {
              // 细节留给开发者控制台，页面上只说人话
              try { console.error('[remote-access] 保存失败', err); } catch { /* 忽略 */ }
              setStatus(`保存失败：${err?.message ?? err}`);
            } finally {
              setBusy(false);
            }
          };

          const onReload = () => {
            setStatus('');
            setDraft(null);
            reload().then(() => setSnap(form.getSnapshot()));
          };

          const rowStyle = {
            display: 'grid',
            gridTemplateColumns: 'minmax(150px, max-content) minmax(220px, 1fr)',
            gap: '6px 12px',
            alignItems: 'center',
            marginTop: 6,
          };
          const inputStyle = {
            width: '100%',
            boxSizing: 'border-box',
            padding: '4px 6px',
            font: 'inherit',
            color: 'inherit',
            background: 'rgba(127,127,127,0.08)',
            border: '1px solid rgba(127,127,127,0.35)',
            borderRadius: 4,
          };
          const hintStyle = { gridColumn: '2', opacity: 0.65, fontSize: '0.92em' };

          const rows = FIELDS.flatMap((field) => {
            const value = current[field.key];
            let input;
            if (field.type === 'boolean') {
              input = h('input', {
                key: `${field.key}-i`,
                type: 'checkbox',
                checked: value === true,
                disabled: busy,
                onChange: (e) => setField(field.key, e.target.checked),
              });
            } else if (field.type === 'list') {
              input = h('textarea', {
                key: `${field.key}-i`,
                rows: 2,
                value: value ?? '',
                disabled: busy,
                style: { ...inputStyle, fontFamily: mono.fontFamily },
                onChange: (e) => setField(field.key, e.target.value),
              });
            } else if (field.type === 'number') {
              input = h('input', {
                key: `${field.key}-i`,
                type: 'number',
                value: value ?? 0,
                disabled: busy,
                style: inputStyle,
                onChange: (e) => setField(field.key, e.target.value),
              });
            } else {
              input = h('input', {
                key: `${field.key}-i`,
                type: 'text',
                value: value ?? '',
                disabled: busy,
                style: inputStyle,
                onChange: (e) => setField(field.key, e.target.value),
              });
            }
            return [
              h(
                'div',
                { key: `${field.key}-l`, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                code(field.key),
                h('span', null, field.label),
              ),
              input,
              h('div', { key: `${field.key}-h`, style: hintStyle }, field.hint),
            ];
          });

          const ready = snap.status === 'ready';

          return h(
            'div',
            { style: { padding: '2px 0' } },
            note(
              { marginTop: 0 },
              '把本机 DSH 的网页界面开放给指定网段：只监听该网段里属于本机的地址，网段外的对端一律 403；访问仍需 DSH 自己的令牌。带票网址写在 ',
              code(STATUS_HINT),
              '，手机打开一次后 30 天免票。',
            ),
            h('div', { style: rowStyle }, rows),
            h(
              'div',
              { style: { marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' } },
              h('button', { type: 'button', onClick: onSave, disabled: busy }, busy ? '保存中…' : '保存'),
              h('button', { type: 'button', disabled: busy, onClick: onReload }, '重新读取'),
              status ? h('span', { style: { opacity: 0.9 } }, status) : null,
            ),
            ready ? null : note({ opacity: 0.8 }, failureHint(snap)),
          );
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: NS, order: 100, label: '远程访问' }, Panel),
        );
      },
    };
  },
});
