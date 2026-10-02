// 把 .vbs 文件写成 VBScript 正确的编码：UTF-16 LE + BOM，CRLF 换行。
//
// 为什么需要：VBScript 宿主（wscript/cscript）**默认按 ANSI 读取 .vbs**。
// 若文件是 UTF-8（尤其无 BOM），中文会变成乱码，而且**行结构会被破坏** ——
// 实测一个 UTF-8 的 VBS 报错 `(17, 65) 未终止的字符串常量`，因为中文字符被
// 误解码后把相邻两行"粘"在了一起。
//
// 正确做法：UTF-16 LE + BOM（FF FE）。VBScript 支持它，中文与换行都能正确解析。
//
// 用法：
//   node tools/write-vbs-utf16.mjs <文件>            # 就地转码（.vbs）
//   node tools/write-vbs-utf16.mjs <文件> --check    # 只检查，不改
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!file) {
  console.error('用法: node tools/write-vbs-utf16.mjs <文件.vbs> [--check]');
  process.exit(2);
}

const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
  console.error(`文件不存在：${abs}`);
  process.exit(1);
}

const buf = fs.readFileSync(abs);
const hasBom = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
const utf16 = hasBom ? buf.slice(2).toString('utf16le') : buf.toString('utf8');
const normalized = utf16.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// 快速健全性检查：字符串字面量必须成对（奇数个双引号说明行结构可能已损坏）
const quoteCount = (normalized.match(/"/g) ?? []).length;

if (checkOnly) {
  const crlf = (normalized.match(/\n/g) ?? []).length;
  console.log(`文件: ${path.basename(abs)}`);
  console.log(`  UTF-16 LE BOM: ${hasBom ? '有 ✓' : '无 ✗'}`);
  console.log(`  换行数: ${crlf}`);
  console.log(`  双引号数: ${quoteCount}（应为偶数）`);
  console.log(`  含中文: ${/[\u4e00-\u9fa5]/.test(normalized) ? '是' : '否'}`);
  process.exit(hasBom && quoteCount % 2 === 0 ? 0 : 1);
}

// 写成 UTF-16 LE + BOM，CRLF
const out = normalized.replace(/\n/g, '\r\n');
const body = Buffer.from(out, 'utf16le');
const withBom = Buffer.concat([Buffer.from([0xFF, 0xFE]), body]);
fs.writeFileSync(abs, withBom);

const nonAscii = [...out].filter((c) => c.codePointAt(0) > 0x7F).length;
console.log(`已写入 ${path.basename(abs)}`);
console.log(`  编码: UTF-16 LE + BOM | 字节 ${withBom.length} | 非 ASCII 字符 ${nonAscii}`);
console.log(`  换行: ${(out.match(/\r\n/g) ?? []).length} 个 CRLF`);
console.log(`  双引号: ${quoteCount} 个（${quoteCount % 2 === 0 ? '成对 ✓' : '奇数 ✗ 可能损坏'}）`);
