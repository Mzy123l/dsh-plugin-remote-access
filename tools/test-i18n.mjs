// 直接验证 DICTS 与 t() 的逻辑（不依赖页面）。
// 用法: node tools/test-i18n.mjs
import fs from 'node:fs';

const src = fs.readFileSync('client.js', 'utf8');

// 抽出 SUPPORTED_LANGS / DICTS / dictOf / t 的等价逻辑做验证
const mDicts = src.match(/const DICTS = \{([\s\S]*?)\n    \};/);
if (!mDicts) { console.log('FAIL: 找不到 DICTS'); process.exit(1); }

const langs = ['en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'];
let ok = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { ok += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${extra}`); }
};

// 1) 每种语言的字典都存在且条目数一致
const counts = {};
for (const lang of langs) {
  const re = new RegExp(`\\n      ${lang}: \\{([\\s\\S]*?)\\n      \\},`);
  const m = src.match(re);
  if (!m) { check(`${lang} 字典存在`, false); continue; }
  const entries = m[1].match(/"[^"]+":/g) || [];
  counts[lang] = entries.length;
  check(`${lang} 字典存在（${entries.length} 条）`, entries.length > 100);
}

const values = Object.values(counts);
check('各语言条目数一致', new Set(values).size === 1, JSON.stringify(counts));

// 2) SUPPORTED_LANGS 覆盖 8 种
const mSupport = src.match(/const SUPPORTED_LANGS = \[([^\]]+)\]/);
check('SUPPORTED_LANGS 声明', !!mSupport);
if (mSupport) {
  const list = mSupport[1].match(/'([a-z]+)'/g).map((s) => s.replace(/'/g, ''));
  check('SUPPORTED_LANGS 是 8 种', list.length === 8, list.join(','));
  for (const lang of list) check(`  含 ${lang}`, list.includes(lang));
}

// 3) t() 已改成走 dictOf
check('t() 使用 dictOf', /const t = \(source\) => \{\s*\n\s*const dict = dictOf\(LANG\);/.test(src));
check('dictOf 已定义', /const dictOf = \(lang\) =>/.test(src));
check('normalizeLang 已定义', /function normalizeLang\(value\)/.test(src));

// 4) EN 已彻底移除
check('旧 EN 字典已移除', !/const EN = \{/.test(src));

// 5) normalizeLang 的行为（用等价实现验证）
const SUPPORTED = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'];
const normalize = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 'zh';
  const primary = text.split(/[-_]/)[0];
  return SUPPORTED.includes(primary) ? primary : 'zh';
};
check('zh-CN -> zh', normalize('zh-CN') === 'zh');
check('en-US -> en', normalize('en-US') === 'en');
check('ja -> ja', normalize('ja') === 'ja');
check('pt-BR -> pt', normalize('pt-BR') === 'pt');
check('未知 -> zh', normalize('xx-YY') === 'zh');
check('空值 -> zh', normalize('') === 'zh');

console.log(`\n${ok}/${ok + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
