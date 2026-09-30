/**
 * dsh-remote-access 的浏览器半区：只在「设置」里提供一页可编辑的参数表单。
 *
 * 注册位置：settings.section（设置左侧导航的一页）。插件页那两处（plugins.row.config /
 * plugins.bundle.config）按使用要求已移除。
 *
 * 读写通道（全部带返回值检查与页面内诊断，避免"显示成功实则没写"）：
 *  读：remote.pluginManager.listPlugins()  —— 官方清单，带行与它们的实时 config
 *  写：依次尝试 ctx.configForms.get(行id).set(field, value)
 *              → remote.settings.mutate(行id, [{ op:'set', path, value }], revision)
 *      两者都失败时，把当前值按 YAML 打出来让用户粘贴（保证不会卡死）
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = '@local/dsh-remote-access';
    const ROW_ID = 'remote-access';
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

    /** 从 pluginManager.listPlugins() 的结果里抠出自己这一行的 config */
    function configFromInventory(inventory) {
      const buckets = [];
      if (Array.isArray(inventory)) buckets.push(...inventory);
      else if (inventory && typeof inventory === 'object') {
        for (const value of Object.values(inventory)) if (Array.isArray(value)) buckets.push(...value);
      }
      for (const entry of buckets) {
        if (!entry || typeof entry !== 'object') continue;
        const name = entry.name ?? entry.package ?? entry.id;
        const rowId = entry.rowId ?? entry.entryId ?? entry.id;
        if (name === PACKAGE || rowId === ROW_ID || entry.id === ROW_ID) {
          const config = entry.config ?? entry.resolvedConfig ?? entry.value;
          if (config && typeof config === 'object') return config;
        }
      }
      return undefined;
    }

    return {
      // 服务必须声明才能访问，否则属性访问会抛 "... without inject"
      inject: ['slots', 'configForms', 'remote', 'remote.pluginManager', 'remote.settings'],
      apply(ctx) {
        const diagnostics = [];
        const diag = (line) => {
          diagnostics.push(line);
          return line;
        };

        function servedNamespaces() {
          try {
            const described = ctx.configForms.describe?.();
            const snap =
              typeof described?.getSnapshot === 'function' ? described.getSnapshot() : described;
            const list =
              snap?.namespaces ?? snap?.entries ?? (snap && typeof snap === 'object' ? Object.keys(snap) : []);
            return Array.isArray(list) ? list : [];
          } catch (err) {
            diag(`describe() 失败: ${err?.message ?? err}`);
            return [];
          }
        }

        async function readFromInventory() {
          try {
            const inventory = await ctx.remote.pluginManager.listPlugins();
            const config = configFromInventory(inventory);
            if (config) diag('读：来自 remote.pluginManager.listPlugins()');
            else diag('读：清单里没找到本行的 config，退回快照/默认值');
            return config;
          } catch (err) {
            diag(`读：listPlugins() 失败 ${err?.message ?? err}`);
            return undefined;
          }
        }

        /** 返回值检查：false / 带 error 的对象都算失败 */
        function checkResult(result) {
          if (result === false) return { ok: false, why: '返回 false' };
          if (result && typeof result === 'object') {
            if (result.error) return { ok: false, why: `返回 error: ${JSON.stringify(result.error).slice(0, 200)}` };
            if (result.accepted === false || result.ok === false)
              return { ok: false, why: `返回 ${JSON.stringify(result).slice(0, 200)}` };
          }
          return { ok: true, why: result === undefined ? '无返回值（视为通过）' : `返回 ${JSON.stringify(result).slice(0, 120)}` };
        }

        async function writeAll(scope, draft) {
          const revision = (() => {
            try {
              const snap = typeof scope?.snapshot === 'function' ? scope.snapshot() : scope;
              return snap?.revision;
            } catch {
              return undefined;
            }
          })();
          const tries = [];
          for (const field of FIELDS) {
            const value = encode(field, draft[field.key]);
            let done = false;
            if (typeof scope?.set === 'function') {
              try {
                const result = await scope.set(field.key, value);
                const verdict = checkResult(result);
                tries.push(`configForms.set(${field.key}) → ${verdict.why}`);
                if (verdict.ok) done = true;
              } catch (err) {
                tries.push(`configForms.set(${field.key}) 抛错: ${err?.message ?? err}`);
              }
            }
            if (!done && typeof ctx.remote?.settings?.update === 'function') {
              for (const ns of [ROW_ID, PACKAGE]) {
                if (done) break;
                try {
                  const result = await ctx.remote.settings.update(ns, { [field.key]: value }, revision);
                  const verdict = checkResult(result);
                  tries.push(`settings.update(${ns}, ${field.key}) → ${verdict.why}`);
                  if (verdict.ok) done = true;
                } catch (err) {
                  tries.push(`settings.update(${ns}, ${field.key}) 抛错: ${err?.message ?? err}`);
                }
              }
            }
            if (!done) throw new Error(`字段 ${field.key} 没有写成功：\n${tries.join('\n')}`);
          }
          return tries;
        }

        function yamlSnippet(draft) {
          const lines = [`- id: ${ROW_ID}`, `  name: '${PACKAGE}'`, '  config:'];
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
          const [scope] = React.useState(() => {
            try {
              return { value: ctx.configForms.get(ROW_ID) };
            } catch (err) {
              return { error: String(err?.message ?? err) };
            }
          });
          const [draft, setDraft] = React.useState(null);
          const [status, setStatus] = React.useState('');
          const [tries, setTries] = React.useState([]);
          const [busy, setBusy] = React.useState(false);

          const load = React.useCallback(async () => {
            const fromInventory = await readFromInventory();
            const snapshotValue = (() => {
              try {
                const s = typeof scope.value?.snapshot === 'function' ? scope.value.snapshot() : scope.value;
                const v = s?.value ?? s?.user;
                return v && typeof v === 'object' ? v : {};
              } catch {
                return {};
              }
            })();
            const source = { ...snapshotValue, ...(fromInventory ?? {}) };
            const next = {};
            for (const field of FIELDS) next[field.key] = decode(field, source[field.key]);
            return next;
          }, [scope.value]);

          React.useEffect(() => {
            let alive = true;
            load().then((next) => {
              if (alive) setDraft(next);
            });
            return () => {
              alive = false;
            };
          }, [load]);

          if (draft === null) return h('div', null, '读取中…');

          const setField = (key, value) => setDraft({ ...draft, [key]: value });

          const onSave = async () => {
            setBusy(true);
            setStatus('保存中…');
            setTries([]);
            try {
              if (scope.error) throw new Error(`拿不到写入通道：${scope.error}`);
              const attempted = await writeAll(scope.value, draft);
              setTries(attempted.slice(-4));
              const verify = await load();
              setDraft(verify);
              const changed = FIELDS.some((f) => JSON.stringify(verify[f.key]) !== JSON.stringify(draft[f.key]));
              setStatus(changed ? '写入返回成功，但回读发现值没变 —— 说明这条路没真正落盘。' : '已保存。插件会重新挂载：端口可能变化，新网址见状态文件。');
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

          const namespaceServed = servedNamespaces().includes(ROW_ID);

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
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => {
                    setStatus('');
                    setTries([]);
                    load().then(setDraft);
                  },
                },
                '重新读取',
              ),
              status ? h('span', { style: { opacity: 0.9 } }, status) : null,
            ),
            tries.length
              ? h(
                  'div',
                  { style: { ...mono, display: 'block', marginTop: 8, whiteSpace: 'pre-wrap' } },
                  tries.join('\n'),
                )
              : null,
            note(
              { opacity: 0.8 },
              '诊断：命名空间 ',
              code(ROW_ID),
              namespaceServed ? ' 已在已服务列表中' : ' **不在**已服务列表中（这通常意味着这条路写不进去）',
              diagnostics.length ? `；${diagnostics.join('；')}` : '',
            ),
            note(
              { opacity: 0.8 },
              '如果保存失败，可以把下面这段贴进 profile 的 ',
              code('cordis.patch.yml'),
              '（把 ',
              code('- insert:'),
              ' 里那一行的 config 换成它），然后重启 DSH：',
            ),
            h('pre', { style: { ...mono, display: 'block', marginTop: 6, whiteSpace: 'pre-wrap' } }, yamlSnippet(draft)),
          );
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: ROW_ID, order: 100, label: '远程访问' }, Panel),
        );
      },
    };
  },
});
