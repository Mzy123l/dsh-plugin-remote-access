/**
 * dsh-remote-access 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
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
  id: '@local/dsh-remote-access',
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
      { key: 'accessCode', type: 'password', label: '访问密码', placeholder: '6位数字' },
    ];

    const DEFAULTS = {
      enabled: true,
      allowCidrs: [],
      denyCidrs: [],
      port: 0,
      maxConnections: 0,
      logLevel: 'info',
      accessCode: '',
    };

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

    return {
      // 服务必须声明才能访问，否则属性访问会抛 "... without inject"
      inject: ['slots', 'configForms', 'remote', 'remote.settings'],
      apply(ctx) {
        // ui-settings 提供的共享表单控制器：同一个条目在浏览器里只有一个实例，
        // 生命周期归提供方，我们只订阅，不 dispose。
        const form = ctx.configForms.get(NS);
        const describe = ctx.configForms.describe();
        const settings = ctx.remote.settings;

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
            setBusy(true);
            setStatus('保存中…');
            try {
              const base = source ?? {};
              const changed = {};
              for (const field of FIELDS) {
                const next = encode(field, current[field.key]);
                if (JSON.stringify(next) !== JSON.stringify(base[field.key])) changed[field.key] = next;
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

          const rowStyle = {
            display: 'grid',
            gridTemplateColumns: 'minmax(84px, max-content) minmax(180px, 1fr)',
            gap: '8px 12px',
            alignItems: 'center',
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
            return [h('div', { key: `${field.key}-l` }, field.label), input];
          });

          return h(
            'div',
            { style: { padding: '2px 0' } },
            h('div', { style: rowStyle }, rows),
            h(
              'div',
              { style: { marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' } },
              h('button', { type: 'button', onClick: onSave, disabled: busy }, busy ? '保存中…' : '保存'),
              h('button', { type: 'button', disabled: busy, onClick: onReload }, '重新读取'),
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
