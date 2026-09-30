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
 *   Host 侧落到 profile 的 patch 层（cordis.patch.yml），并按 Loader 正常路径重新挂载插件。
 *
 * 注意：configForms 在「命名空间没被 Host 服务」时只会静默返回 false，
 * 所以这里把 status / writable / mode / revision 与已服务命名空间一并摆在页面上，
 * 失败必须看得见（同 AGENTS.md 的硬约定）。
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

    /** status 不是 ready 时说清「为什么写不进去」 */
    function whyNotReady(snap) {
      if (snap?.status === 'loading') return '设置文档还在读取，稍等一下再保存。';
      if (snap?.status === 'unavailable') {
        return '这一行没有被 Host 服务：要么插件的 Config 里没有 volatile 字段，要么当前页面不是回环地址（DSH 规定非回环页面不写 Host 设置，只留在浏览器内存里）。';
      }
      return `当前 status=${snap?.status ?? '(未知)'}。`;
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

        /** 已服务的命名空间（Host 侧设置文档的快照）——写不进时的第一手线索 */
        function servedNamespaces() {
          try {
            const snap = describe?.getSnapshot?.();
            const list = snap?.view?.namespaces;
            return Array.isArray(list) ? list.map((row) => row.ns) : [];
          } catch {
            return [];
          }
        }

        function yamlSnippet(draft) {
          const lines = [`- id: ${NS}`, "  name: '@local/dsh-remote-access'", '  config:'];
          for (const field of FIELDS) {
            const value = encode(field, draft[field.key]);
            if (field.type === 'list') {
              lines.push(`    ${field.key}:`);
              for (const item of value) lines.push(`      - ${item}`);
            } else {
              lines.push(`    ${field.key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
            }
          }
          return lines.join('\n');
        }

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
              if (now.status !== 'ready') throw new Error(`这一行现在不可写。${whyNotReady(now)}`);
              if (now.writable !== true) {
                throw new Error(`Host 现在不接受设置写入（writable=${String(now.writable)}，mode=${now.mode ?? '?'}）。`);
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
                throw new Error(
                  `Host 拒绝了这次写入（返回 ${String(accepted)}）——通常是 revision 冲突或命名空间已停止服务；页面已重读，请对照后重试。`,
                );
              }
              setStatus(
                `已写入 ${ops.length} 个字段，落在 profile 的 patch 层。插件随即重新挂载：端口可能变化，新的带票网址见 ${STATUS_HINT}`,
              );
            } catch (err) {
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

          const served = servedNamespaces();
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
            note(
              { opacity: 0.8 },
              '诊断：命名空间 ',
              code(NS),
              ` → status=${snap.status ?? '?'}，revision=${snap.revision ?? '?'}，writable=${String(snap.writable)}，mode=${snap.mode ?? '?'}；Host 已服务的命名空间：`,
              served.length ? served.join(', ') : '（还没有）',
            ),
            ready
              ? null
              : note({ opacity: 0.8 }, whyNotReady(snap)),
            note(
              { opacity: 0.8 },
              '保存会写进 profile 的 ',
              code('cordis.patch.yml'),
              '（那一行的 ',
              code('config'),
              '），所以重启也不会丢；写完插件立即重新挂载。',
            ),
            note(
              { opacity: 0.8 },
              '如果保存一直失败（例如在手机的非回环页面上打开本页——DSH 不允许那种页面写 Host 设置），可以把下面这段贴进 profile 的 ',
              code('cordis.patch.yml'),
              '（替换 ',
              code('- insert:'),
              ' 里那一行的 config），然后重启 DSH：',
            ),
            h('pre', { style: { ...mono, display: 'block', marginTop: 6, whiteSpace: 'pre-wrap' } }, yamlSnippet(current)),
          );
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: NS, order: 100, label: '远程访问' }, Panel),
        );
      },
    };
  },
});
