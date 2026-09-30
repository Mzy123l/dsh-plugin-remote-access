// asar-extract.mjs — 无依赖从 app.asar 里取文件/列目录
// 用法: node asar-extract.mjs <app.asar> <内部路径> [输出文件]
//   内部路径为空或指向目录时 -> 打印该目录的条目
import fs from 'node:fs';

const [, , asarPath, inner = '', outPath] = process.argv;
if (!asarPath) { console.error('用法: node asar-extract.mjs <app.asar> <内部路径> [输出文件]'); process.exit(1); }

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const u32 = (o) => head.readUInt32LE(o);
const jsonLen = u32(12);
const jbuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jbuf, 0, jsonLen, 16);
const header = JSON.parse(jbuf.toString('utf8'));

const candidates = [16 + jsonLen, 8 + u32(4)];
// 用 dsh/package.json 探测数据段起点
let dataStart = candidates[0];
for (const c of candidates) {
    try {
        const probe = Buffer.alloc(1);
        // 找 header 里第一个真实文件来做探测
        let n = header;
        for (const p of 'dsh/package.json'.split('/')) n = n.files?.[p];
        if (n && n.size) {
            fs.readSync(fd, probe, 0, 1, c + Number(n.offset));
            if (probe.toString('utf8') === '{') { dataStart = c; break; }
        }
    } catch { /* 试下一个 */ }
}

let node = header;
for (const part of inner.split('/').filter(Boolean)) {
    if (!node) break;
    node = node.files?.[part];
}
if (!node) { console.error(`找不到: ${inner}`); process.exit(2); }

if (node.files) {
    console.log(`# 目录 ${inner || '/'} 下的条目:`);
    for (const [name, child] of Object.entries(node.files)) {
        const kind = child.files ? 'DIR ' : 'FILE';
        const size = child.size !== undefined ? String(child.size) : '';
        console.log(`${kind}  ${size.padStart(9)}  ${name}`);
    }
    process.exit(0);
}

const offset = dataStart + Number(node.offset);
const len = Number(node.size);
const buf = Buffer.alloc(len);
fs.readSync(fd, buf, 0, len, offset);
if (outPath) { fs.writeFileSync(outPath, buf); console.log(`已写出 ${outPath} (${len} bytes)`); }
else process.stdout.write(buf.toString('utf8'));
