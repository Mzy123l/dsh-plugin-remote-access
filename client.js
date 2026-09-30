/**
 * dsh-remote-access 的浏览器半区。
 *
 * 三处注册（都是 DSH 自己声明的槽位）：
 *  1. settings.section      → 在「设置」左侧导航里多一页「远程访问」（可改参数）
 *  2. plugins.row.config    key = <包名>#<行 id> → 给 remote-access 这一行加「配置」控件
 *  3. plugins.bundle.config key = <包名>        → 组合包详情页里也放同一张表单
 *
 * 写参数的通道：这一行（Host 条目 id = remote-access）本身就是设置命名空间，
 * 用 ctx.configForms.get(entryId) 拿到写入队列，scope.set(field, value) 提交。
 * 保存后 Host 半区会重新挂载：关掉旧端口、按新参数重开，状态文件随之更新。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = '@local/dsh-remote-access';
    const ROW_ID = 'remote-access';
    const STATUS_HINT = 'DSH 家目录\\remote-access-url.txt';

    /** 与 Host 半区 Config 对齐的字段表 */
    const FIELDS = [
      { key: 'enabled', type: 'boolean', label: '启用', hint: '关掉即停止监听，不必卸载插件' },
      { key: 'allowCidrs', type: 'list', label: '允许的网段', hint: '唯一的安全边界；也是自动选择监听地址的依据。一行一个或用逗号分隔，例如 100.64.0.0/10' },
      { key: 'denyCidrs', type: 'list', label: '排除的网段', hint: '白名单内的例外黑名单，可留空' },
      { key: 'listen', type: 'list', label: '监听地址', hint: '留空或 auto = 只监听允许网段里属于本机的地址' },
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

    const listToText = (v) =>
      Array.isArray(v) ? v.join('\n') : v === undefined || v === null ? '' : String(v);
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

    return {
      inject: ['slots'],
      apply(ctx) {
        /** 读当前生效值：优先 scope.get(field)，退化为快照里的 value */
        function readCurrent(scope) {
          let snapshotValue = {};
          try {
            const snap = typeof scope?.snapshot === 'function' ? scope.snapshot() : scope;
            const v = snap?.value ?? snap?.user ?? {};
            if (v && typeof v === 'object') snapshotValue = v;
          } catch { /* 忽略 */ }
          const out = {};
          for (const field of FIELDS) {
            let v;
            try {
              if (typeof scope?.get === 'function') v = scope.get(field.key);
            } catch { /* 忽略 */ }
            if (v === undefined) v = snapshotValue[field.key];
            out[field.key] = decode(field, v);
          }
          return out;
        }

        /** 提交全部字段：优先 scope.set(field, value)，退化到 mutate(ops, revision) */
        async function submit(scope, draft) {
          let revision;
          try {
            const snap = typeof scope?.snapshot === 'function' ? scope.snapshot() : scope;
            revision = snap?.revision;
          } catch { /* 忽略 */ }
          for (const field of FIELDS) {
            const value = encode(field, draft[field.key]);
            if (typeof scope?.set === 'function') {
              await scope.set(field.key, value);
            } else if (typeof scope?.mutate === 'function') {
              await scope.mutate([{ op: 'set', path: field.key, value }], revision);
            } else {
              throw new Error('当前 DSH 没有暴露可写接口（scope.set / scope.mutate 都不可用）');
            }
          }
        }

        function Panel() {
          const scope = React.useMemo(() => {
            try {
              return ctx.configForms.get(ROW_ID);
            } catch {
              return undefined;
            }
          }, []);
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('');
          const [busy, setBusy] = React.useState(false);

          React.useEffect(() => {
            if (draft === null && scope) setDraft(readCurrent(scope));
          }, [scope, draft]);

          if (!scope) {
            return h('div', { style: { lineHeight: 1.7 } }, '这台 DSH 没有提供设置写入通道（ctx.configForms 不可用）。');
          }
          if (draft === null) return h('div', null, '读取中…');

          const setField = (key, value) => setDraft({ ...draft, [key]: value });

          const onSave = async () => {
            setBusy(true);
            setStatus('保存中…');
            try {
              await submit(scope, draft);
              setStatus('已保存。插件会重新挂载：端口可能变化，新网址见状态文件。');
            } catch (err) {
              setStatus(`保存失败：${err?.message ?? err}`);
            } finally {
              setBusy(false);
            }
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
            const value = draft[field.key];
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
              h('button', { type: 'button', onClick: () => setDraft(readCurrent(scope)), disabled: busy }, '重新读取'),
              status ? h('span', { style: { opacity: 0.85 } }, status) : null,
            ),
            note(
              { opacity: 0.8 },
              '保存写入 profile 的 patch 层（等同手改 ',
              code('cordis.patch.yml'),
              '）；',
              code('allowCidrs'),
              ' 是唯一的安全边界，写宽了等于把本机命令执行权限放开。自测：',
              code('node tools/test-remote-access.mjs'),
              '。',
            ),
          );
        }

        // 1) 设置左侧导航里的一页
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: ROW_ID, order: 100, label: '远程访问' }, Panel),
        );
        // 2) remote-access 这一行的「配置」控件（key = 包名#行 id）
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ROW_ID}`, order: 100 }, Panel),
        );
        // 3) 组合包详情页里的配置区（key = 包名）
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, order: 100 }, Panel),
        );
      },
    };
  },
});
