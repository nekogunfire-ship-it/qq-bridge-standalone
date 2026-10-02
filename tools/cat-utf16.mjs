// 打印 UTF-16 LE 文本文件的内容（read 工具把 UTF-16 视为二进制，VBS 又是 VBScript 必需的编码）。
// 用法: node tools/cat-utf16.mjs <文件> [起始行] [行数]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/cat-utf16.mjs <文件> [起始行] [行数]');
  process.exit(2);
}
const abs = path.resolve(file);
const buf = fs.readFileSync(abs);
const hasBom = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
const text = (hasBom ? buf.slice(2) : buf).toString(hasBom ? 'utf16le' : 'utf8');
const lines = text.replace(/\r\n/g, '\n').split('\n');

const from = Math.max(1, Number(process.argv[3]) || 1);
const count = Number(process.argv[4]) || lines.length;
console.log(`${path.basename(abs)}  (UTF-16 LE BOM: ${hasBom ? '有' : '无'}, 共 ${lines.length} 行)`);
console.log('');
lines.slice(from - 1, from - 1 + count).forEach((line, i) => {
  console.log(`  ${String(from + i).padStart(3)}: ${line}`);
});
