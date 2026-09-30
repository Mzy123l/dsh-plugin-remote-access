// check-config-schema.mjs —— 用 DSH 安装包里的「真」Schemastery 校验本插件的 Config。
// 用法: node tools/check-config-schema.mjs   （找不到安装包时打印 SKIP 并以 0 退出）
//
// 为什么需要它：设置页能不能写盘，完全取决于 Host 认不认这一行的 Config——
//   1) 必须是原生 Schemastery schema（Symbol.for('schemastery')）；
//      否则 Config.listConfigs 里这一行是 absent/unsupported；
//   2) 必须含 volatile 字段（Host 的设置文档由 volatileForm / isVolatilePath 过滤），
//      否则命名空间根本不出现，ctx.configForms.set 只会静默返回 false。
// 两者都是「装进 DSH 才发现」的坑，所以这里把安装包里的 schemastery 与其唯一依赖
// cosmokit 铺进一个临时 node_modules，再原样拷一份 index.js 进去加载——
// 与 DSH 的解析结果等价，不需要重启 DSH 就能验证。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAsarBuffer } from './asar-extract.mjs';

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

const SCHEMA_PKG = 'dsh/node_modules/@deepseek-ai/schemastery';
const COSMO_PKG = 'dsh/node_modules/@deepseek-ai/cosmokit';

function findAsar() {
  const candidates = [
    process.env.DSH_ASAR,
    'E:\\Applications\\DeepSeek Harness\\resources\\app.asar',
    'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar',
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
}

/** DSH 的 volatileForm/isVolatilePath 判据：路径上最近的 volatile 祖先即视为可写 */
const isVolatilePath = (schema, [key, ...rest]) => {
  if (schema?.meta?.volatile) return true;
  if (key === undefined) return false;
  return isVolatilePath(schema.dict?.[key], rest);
};

/** 从 client.js 抠出表单字段（key + 控件类型），用来和 schema 对表 */
function formFields(clientSource) {
  const found = [];
  const re = /\{\s*key:\s*'([^']+)',\s*type:\s*'([^']+)'/g;
  for (let m = re.exec(clientSource); m; m = re.exec(clientSource)) found.push({ key: m[1], type: m[2] });
  return found;
}

const EXPECTED_TYPE = { boolean: 'boolean', number: 'number', string: 'string', list: 'array' };

const asarPath = findAsar();
if (!asarPath) {
  console.log('SKIP  找不到 DSH 安装包（app.asar）——设 DSH_ASAR 环境变量后可校验 Config');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-schema-'));
try {
  const put = (inner, rel) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readAsarBuffer(asarPath, inner));
  };
  put(`${SCHEMA_PKG}/package.json`, 'node_modules/@deepseek-ai/schemastery/package.json');
  put(`${SCHEMA_PKG}/lib/index.mjs`, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs');
  put(`${COSMO_PKG}/package.json`, 'node_modules/@deepseek-ai/cosmokit/package.json');
  put(`${COSMO_PKG}/lib/index.js`, 'node_modules/@deepseek-ai/cosmokit/lib/index.js');
  fs.copyFileSync(new URL('../index.js', import.meta.url), path.join(root, 'index.js'));

  const { Config } = await import(pathToFileURL(path.join(root, 'index.js')).href);

  check('index.js 导出了 Config', Config !== undefined && Config !== null, Config === undefined ? '导出是 undefined —— 设置页必然写不进去' : '');

  // 逐字对照 @deepseek-ai/dsh-app-boot 的 isNativeConfigSchema：
  // schema 实例是函数（Schema.prototype = Object.create(Function.prototype)），所以
  // 「既不是 object 也不是 function」才算不合格，别写成 typeof === 'object'。
  const native = !(Config === null || (typeof Config !== 'object' && typeof Config !== 'function'))
    && Reflect.get(Config, Symbol.for('schemastery')) === true
    && typeof Reflect.get(Config, 'type') === 'string'
    && Reflect.get(Config, 'meta') !== null && typeof Reflect.get(Config, 'meta') === 'object';
  check('Config 是原生 Schemastery schema', native, native ? '' : 'DSH 会记为 unsupported/absent，命名空间不会被服务');

  const dict = Config?.dict && typeof Config.dict === 'object' ? Config.dict : {};
  const keys = Object.keys(dict);
  check('Config 声明了字段', keys.length > 0, `${keys.length} 个: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}`);

  const notVolatile = keys.filter((key) => !isVolatilePath(Config, [key]));
  check('每个字段都标了 .volatile()', keys.length > 0 && notVolatile.length === 0,
    notVolatile.length ? `没标的: ${notVolatile.join(', ')}（Host 不会服务这些字段所在的条目）` : '');

  // 走 DSH 的同一套校验：schema 解出的默认配置
  let resolved;
  try {
    resolved = Config({});
  } catch (err) {
    check('Config({}) 能解出默认配置', false, String(err?.message ?? err));
  }
  if (resolved !== undefined) {
    const resolvedKeys = Object.keys(resolved);
    check('Config({}) 能解出默认配置', true, `${resolvedKeys.length} 个字段`);
    check('解出的字段与声明一致', resolvedKeys.length === keys.length && keys.every((k) => resolvedKeys.includes(k)),
      `声明 ${keys.length} / 解出 ${resolvedKeys.length}`);
  }

  const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const fields = formFields(clientSource);
  check('能从 client.js 读出表单字段', fields.length > 0, `${fields.length} 个`);

  const missingInSchema = fields.filter((f) => !keys.includes(f.key)).map((f) => f.key);
  check('表单字段都在 Config 里', missingInSchema.length === 0, missingInSchema.length ? `缺: ${missingInSchema.join(', ')}` : '');

  const missingInForm = keys.filter((k) => !fields.some((f) => f.key === k));
  check('Config 字段都在表单里', missingInForm.length === 0, missingInForm.length ? `缺: ${missingInForm.join(', ')}` : '');

  const mismatched = fields
    .filter((f) => dict[f.key] !== undefined)
    .filter((f) => dict[f.key].type !== EXPECTED_TYPE[f.type])
    .map((f) => `${f.key}: 表单 ${f.type} ↔ schema ${dict[f.key].type}`);
  check('表单控件类型与 schema 类型一致', mismatched.length === 0, mismatched.join('；'));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
