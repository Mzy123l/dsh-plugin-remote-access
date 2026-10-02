import fs from "node:fs";
const f = "C:/Users/Assistant/projects/dsh-remote-access-cidr/client.js";
let s = fs.readFileSync(f, "utf8");
const lines = s.split("\n");
const start = lines.findIndex((l) => l.includes("const PHONE_CSS = `"));
const end = lines.findIndex((l, i) => i > start && l === "`;");
if (start < 0 || end < 0) { console.error("NOT FOUND template bounds", start, end); process.exit(1); }
const rule = [
  "",
  "/* 抽屉的实底：**不覆盖 DSH 的表面元素**（那条 background !important 覆盖表面会让左侧栏整列不再绘制，",
  "   已在 d92a572 删除并验证），改为在抽屉背后垫一层自己的底色 —— 伪元素 + z-index:-1，",
  "   正好夹在父层背景与内容之间。这样即使内层面板仍带着壁纸引擎调出来的半透明底色，合成结果也不透明。",
  "   只在手机档的抽屉上生效，本机与电脑档不注入。 */",
  'html[data-ra-layout="phone"][data-ra-drawer] [data-ra-sidebar]::before {',
  '  content: "" !important;',
  "  position: absolute !important;",
  "  inset: 0 !important;",
  "  z-index: -1 !important;",
  "  background: var(--dsw-alias-bg-base, #101a36) !important; /*strong*/",
  "}",
];
lines.splice(end, 0, ...rule);
fs.writeFileSync(f, lines.join("\n"));
console.log("inserted inside template before line", end + 1);
