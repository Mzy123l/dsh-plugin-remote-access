/**
 * dsh-remote-access 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
 *
 * 注册位置：settings.section（设置左侧导航的一页）。
 *
 * 两条读写通道，按页面所在位置自动选：
 *   1. 本机（回环）页面 —— 官方通道 ctx.configForms.get('remote-access')：
 *      读 form.getSnapshot() → { status, value, revision, writable, mode }，
 *      写 form.mutate([{ op:'set', path:[字段], value }], revision) → Promise<boolean>。
 *   2. 手机等远程页面 —— DSH 规定非回环页面不写 Host 设置（configForms 恒为 unavailable），
 *      所以走 Host 半区自己的端点 POST /__remote_access__/config（此时页面正经过本插件的监听），
 *      由 Host 用官方的 configEditor.edit() 落盘到 profile 的 patch 层。两条路写的是同一个地方。
 *
 * 页面上只说人话：失败给一句「下一步做什么」，内部状态只写开发者控制台。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'remote-access';
    const RW_PATH = '/__remote_access__/config';
    const SAVED_HINT = '已保存';

    // 表单字段（与 index.js 的 FORM_KEYS 保持一致，check-config-schema.mjs 会断言）
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
    const display = (field, value) => {
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

    /** 远程页面（手机）读配置：走 Host 半区的端点 */
    async function readRemote() {
      const res = await fetch(RW_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body?.ok !== true) throw new Error(body?.error ?? '读取失败');
      return body.config ?? {};
    }

    /** 远程页面写配置：Host 半区用 configEditor.edit() 落盘，与设置页同一个地方 */
    async function writeRemote(patch) {
      const res = await fetch(RW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body.config ?? {};
    }

    return {
      // 服务必须声明才能访问，否则属性访问会抛 "... without inject"
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
          const [remote, setRemote] = React.useState(null);
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const revisionRef = React.useRef(snap.revision);

          // 回环页面用 configForms（官方通道）；拿不到就退到 Host 端点（远程页面）
          const viaForms = snap.status === 'ready' && snap.writable === true;
          const source = viaForms ? snap.value : remote;

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
            readRemote()
              .then((config) => { if (alive) setRemote(config); })
              .catch((err) => {
                try { console.error('[remote-access] 读远端配置失败', err); } catch { /* 忽略 */ }
                if (alive) setRemote({});
              });
            return () => { alive = false; };
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
                setRemote(await writeRemote(changed));
              }
              setDraft(null);
              setStatus(`${SAVED_HINT} ${count} 项。`);
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
              reload().then(() => setSnap(form.getSnapshot()));
              return;
            }
            readRemote()
              .then((config) => setRemote(config))
              .catch(() => setRemote({}));
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
            const value = display(field, current[field.key]);
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
            return [
              h('div', { key: `${field.key}-l` }, field.label),
              input,
            ];
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
