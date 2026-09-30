// asar-extract.mjs — 无依赖从 app.asar 里取文件/列目录
// 用法: node asar-extract.mjs <app.asar> <内部路径> [输出文件]
//   内部路径为空或指向目录时 -> 打印该目录的条目
// 同时作为模块导出，供 tools/check-config-schema.mjs 复用（那里的用法是读 Buffer）。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 读 asar 头，定位数据段起点（用 dsh/package.json 探测，兼容两种头部布局） */
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const u32 = (o) => head.readUInt32LE(o);
  const jsonLen = u32(12);
  const jbuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jbuf, 0, jsonLen, 16);
  const header = JSON.parse(jbuf.toString('utf8'));

  const candidates = [16 + jsonLen, 8 + u32(4)];
  let dataStart = candidates[0];
  for (const c of candidates) {
    try {
      const probe = Buffer.alloc(1);
      let n = header;
      for (const p of 'dsh/package.json'.split('/')) n = n.files?.[p];
      if (n && n.size) {
        fs.readSync(fd, probe, 0, 1, c + Number(n.offset));
        if (probe.toString('utf8') === '{') { dataStart = c; break; }
      }
    } catch { /* 试下一个 */ }
  }
  return { fd, header, dataStart };
}

/** 按内部路径找到 asar 里的节点（目录或文件） */
function nodeOf(header, inner) {
  let node = header;
  for (const part of String(inner).split('/').filter(Boolean)) {
    if (!node) break;
    node = node.files?.[part];
  }
  return node;
}

/** 取一个文件的完整内容（Buffer）。找不到或指向目录时抛错。 */
export function readAsarBuffer(asarPath, inner) {
  const { fd, header, dataStart } = openAsar(asarPath);
  try {
    const node = nodeOf(header, inner);
    if (!node || node.files) throw new Error(`不是文件: ${inner}`);
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, buf.length, dataStart + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** 列一个目录 [{ kind: 'DIR'|'FILE', size, name }] */
export function listAsarDir(asarPath, inner = '') {
  const { fd, header } = openAsar(asarPath);
  try {
    const node = nodeOf(header, inner);
    if (!node) throw new Error(`找不到: ${inner}`);
    if (!node.files) throw new Error(`不是目录: ${inner}`);
    return Object.entries(node.files).map(([name, child]) => ({
      kind: child.files ? 'DIR' : 'FILE',
      size: child.size,
      name,
    }));
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  const [, , asarPath, inner = '', outPath] = process.argv;
  if (!asarPath) { console.error('用法: node asar-extract.mjs <app.asar> <内部路径> [输出文件]'); process.exit(1); }

  const node = nodeOf(openAsar(asarPath).header, inner);
  if (!node) { console.error(`找不到: ${inner}`); process.exit(2); }

  if (node.files) {
    console.log(`# 目录 ${inner || '/'} 下的条目:`);
    for (const { kind, size, name } of listAsarDir(asarPath, inner)) {
      console.log(`${kind}  ${size !== undefined ? String(size).padStart(9) : ''}  ${name}`);
    }
    process.exit(0);
  }

  const buf = readAsarBuffer(asarPath, inner);
  if (outPath) { fs.writeFileSync(outPath, buf); console.log(`已写出 ${outPath} (${buf.length} bytes)`); }
  else process.stdout.write(buf.toString('utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
