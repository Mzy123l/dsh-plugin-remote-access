// check-config-schema.mjs —— 校验「配置只走本用户 JSON」这条契约。
// 用法: node tools/check-config-schema.mjs
//
// 历史背景：1.4.x 把参数放在 DSH 的 Config 树里（profile 的 cordis.patch.yml）。
// 多个 Windows 用户共用一份 profile 时那份配置是共享的，互相覆盖。1.5.0 起改成：
//   · 不导出 Config、不注册 DSH 配置表单；
//   · 插件不读也不写 profile 的 cordis.patch.yml / settings / configEditor；
//   · 配置只存在 `$DSH_HOME/remote-access-config.json`，设置页走 `/__remote_access__/config`。
//
// 这个脚本把这些约定钉住，防止以后又悄悄走回共享 profile。
import fs from 'node:fs';

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const patchSource = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const { Config } = await import(new URL('../index.js', import.meta.url).href);
check('index.js 不导出 Config（配置不走 DSH 配置树）', Config === undefined, Config === undefined ? '' : '导出仍在，DSH 会生成共享表单');

// 去掉注释再查：「不读 configEditor / settings」这类说明文字不该被当成代码命中
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const indexCode = stripComments(indexSource);
const clientCode = stripComments(clientSource);

check('index.js 不取 configEditor（不写 profile 配置）', !/configEditor/.test(indexCode));
check('index.js 不调 settings.describe（不读共享配置）', !/settings\s*\.\s*describe/.test(indexCode));
check('index.js 不使用 AsyncResource / runOutsideHmr 写盘绕行', !/AsyncResource|runOutsideHmr/.test(indexCode));
check(
  'index.js 只从 $DSH_HOME 读配置',
  /remote-access-config\.json/.test(indexCode) && /DSH_HOME/.test(indexCode),
);
check(
  'index.js 挂了配置端点 /__remote_access__/config',
  indexCode.includes("'/__remote_access__/config'") || indexCode.includes('"__remote_access__/config"'),
);
check('client.js 不碰 configForms / ctx.remote.settings（不读写共享 profile）', !/configForms|remote\s*\.\s*settings/.test(clientCode));
check('client.js 走插件自己的配置端点', clientCode.includes('/__remote_access__/config'));
check('client.js 的 inject 不再声明共享配置服务', /inject:\s*\[[^\]]*\]/.test(clientCode) && !/inject:[^\]]*configForms/.test(clientCode));

// bundle patch 里插件行不能带 config：那会被 DSH 当成共享配置
const rowSection = patchSource.split(/- insert:/)[1] ?? '';
const rowMatch = /- id: remote-access-cidr[\s\S]*?(?=\n\s*- id:|\s*$)/.exec(rowSection);
check('cordis.patch.yml 里找到了 remote-access-cidr 行', rowMatch !== null);
check('bundle patch 的插件行不带 config（共享 profile 不存本插件参数）', rowMatch !== null && !/^\s+config:/m.test(rowMatch[0]));

check('package.json 不再声明 @deepseek-ai/schemastery peer', manifest.peerDependencies?.['@deepseek-ai/schemastery'] === undefined);
check('engines.dsh 仍然声明', typeof manifest.engines?.dsh === 'string', manifest.engines?.dsh ?? '(缺)');

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
