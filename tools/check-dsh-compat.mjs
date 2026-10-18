// check-dsh-compat.mjs —— 用本机 DSH 0.2.1 自己的校验器检查插件的版本声明。
//
// 为什么要有它：dshmarket 展示「此插件支持的 DSH 版本」靠 package.json 的
// `engines.dsh`；DSH 安装/启动时用的是同一套 semver 判定（含 prerelease）。
// 这里直接 import 安装目录里的 dsh-app-boot 与 dsh-plugin-market-index，
// 用**真**校验器跑一遍，而不是在测试里另写一份近似实现。
//
// 用法：node tools/check-dsh-compat.mjs
//       DSH_HARNESS="E:\Applications\DeepSeek Harness" node tools/check-dsh-compat.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** 找解包后的 DSH 运行时（app.asar 内部无法 import，遇到就 SKIP）。 */
function findRuntime() {
  const harnesses = [
    process.env.DSH_HARNESS,
    'E:\\Applications\\DeepSeek Harness',
    'C:\\Program Files\\DeepSeek Harness',
  ].filter(Boolean);
  for (const harness of harnesses) {
    const appDsh = path.join(harness, 'resources', 'app', 'dsh');
    if (fs.existsSync(path.join(appDsh, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) return appDsh;
  }
  return null;
}

const runtime = findRuntime();
if (runtime === null) {
  console.log('SKIP 找不到解包后的 DSH 运行时（DSH_HARNESS 指向安装目录；app.asar 布局不支持 import）');
  process.exit(0);
}

const appBoot = await import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
const marketIndex = await import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')).href);
const semver = (await import(pathToFileURL(path.join(runtime, 'node_modules', 'semver', 'index.js')).href)).default;

const runtimeVersion = appBoot.getDshRuntimeVersion();
const range = manifest.engines?.dsh;
check('package.json 声明了 engines.dsh', typeof range === 'string' && range.trim() !== '', String(range ?? '(缺失)'));
check('engines.dsh 是合法的 SemVer 范围', typeof range === 'string' && semver.validRange(range) !== null, String(range));
check(
  `engines.dsh 覆盖当前运行时 ${runtimeVersion}`,
  typeof range === 'string' && appBoot.evaluatePluginCompatibility(manifest) === undefined,
  JSON.stringify(appBoot.evaluatePluginCompatibility(manifest) ?? null),
);
check(
  'engines.dsh 覆盖将来的稳定版 0.2.1',
  typeof range === 'string' && semver.satisfies('0.2.1', range, { includePrerelease: true }),
  String(range),
);
check(
  'engines.dsh 明确排除 0.2.0（这一版只适配 0.2.1+）',
  typeof range === 'string' && !semver.satisfies('0.2.0-rc.2', range, { includePrerelease: true }),
  String(range),
);

// dshmarket 索引里 version 的 engines 字段由同一个校验器读；这里造一条最小的索引验证形状
let marketOk = false;
let marketExtra = '';
try {
  const doc = {
    format: 1,
    title: { en: 'compat check' },
    plugins: [
      {
        name: manifest.name,
        title: { en: manifest.meta?.title ?? manifest.name },
        versions: [
          {
            version: manifest.version,
            publishTimestamp: 1_760_000_000,
            source: { type: 'npm' },
            engines: { dsh: range },
          },
        ],
      },
    ],
  };
  const parsed = marketIndex.parseMarketIndex(doc, 'https://example.com/index.json');
  marketOk = parsed.plugins[0].versions[0].engines.dsh === range;
  marketExtra = JSON.stringify(parsed.plugins[0].versions[0].engines);
} catch (error) {
  marketExtra = String(error?.message ?? error);
}
check('dshmarket 索引格式接受这个版本声明', marketOk, marketExtra);

// 清单/资源的最低要求（0.2.1 的 plugin manager 会读这些）
check('声明了 dsh.bundle.patch', typeof manifest.dsh?.bundle?.patch === 'string', String(manifest.dsh?.bundle?.patch));
check(
  'bundle patch 文件存在',
  typeof manifest.dsh?.bundle?.patch === 'string' && fs.existsSync(path.join(root, manifest.dsh.bundle.patch)),
  String(manifest.dsh?.bundle?.patch),
);
check('声明了 web 客户端面', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform));
check('导出了 ./client', manifest.exports?.['./client'] === './client.js', String(manifest.exports?.['./client']));
check('导出了 locale/*.json', manifest.exports?.['./locale/*.json'] !== undefined, String(manifest.exports?.['./locale/*.json']));
check('存在中文/英文展示文本', ['zh', 'en'].every((lang) => fs.existsSync(path.join(root, 'locale', `${lang}.json`))));
check('存在插件图标', fs.existsSync(path.join(root, manifest.icon ?? 'icon.svg')), String(manifest.icon));

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
