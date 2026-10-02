// 把一份 .bat/.cmd 转成 cmd.exe 能正确解析的形态：
//   * 全部换行统一为 CRLF
//   * 硬校验只剩 ASCII（含中文会因 cp936 解码而吃掉下一个字符）
//
// 背景：E:\comfyui\run_DSH.bat 曾同时具备两个致命问题 —— 无 BOM 的 UTF-8 中文
// **和纯 LF 换行**。cmd.exe 解析批处理必须依赖 CRLF，纯 LF 会把多行并成一行读，
// 于是整份脚本被撕碎，报出一堆 "'xxx' 不是内部或外部命令"，ComfyUI 根本起不来。
//
// 用法：
//   node tools/fix-bat-line-endings.mjs <源文件> [目标路径]
//   node tools/fix-bat-line-endings.mjs --check <文件...>
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
const files = checkOnly ? args.slice(1) : args;

if (files.length === 0) {
  console.error('用法: node tools/fix-bat-line-endings.mjs [--check] <源文件> [目标路径]');
  process.exit(2);
}

let failures = 0;

function inspect(label, bytes) {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let nonAscii = 0;
  for (const b of bytes) if (b > 127) nonAscii++;
  const text = bytes.toString('latin1');
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  console.log(label);
  console.log(`  字节=${bytes.length} 非ASCII=${nonAscii} BOM=${hasBom} CRLF=${crlf} 裸LF=${bareLf}`);
  return { nonAscii, bareLf, crlf };
}

if (checkOnly) {
  for (const f of files) {
    if (!fs.existsSync(f)) { console.log(`MISS    ${f}`); failures++; continue; }
    const info = inspect(`检查 ${f}`, fs.readFileSync(f));
    if (info.nonAscii === 0 && info.bareLf === 0) {
      console.log('   -> 合格（纯 ASCII + 全 CRLF）');
    } else {
      console.log(`   -> 不合格：${info.nonAscii ? `含 ${info.nonAscii} 个非 ASCII 字节 ` : ''}${info.bareLf ? `有 ${info.bareLf} 处裸 LF` : ''}`);
      failures++;
    }
  }
  process.exit(failures ? 1 : 0);
}

const [src, dest] = files;
const target = dest || src;

let text = fs.readFileSync(src, 'utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');

// 关键：用 'latin1' 编码检测越界字符。Node 会把 >U+00FF 的字符截断成低字节而
// **不报错**，所以必须先显式校验，否则中文会被静默写坏 —— 那正是本脚本要防的事。
const offenders = [];
for (const ch of text) {
  const cp = ch.codePointAt(0);
  if (cp > 0x7f) offenders.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(ch)}`);
  if (offenders.length >= 8) break;
}
if (offenders.length) {
  console.error(`!! ${src} 含非 ASCII 字符（cmd.exe 会用 cp936 解码并吃掉后续字符）：`);
  console.error(`   ${offenders.join('  ')}`);
  console.error('   请先把中文说明移出 .bat（放到 .ps1 或 tools\\messages.json），再重跑本脚本。');
  process.exit(1);
}

const bytes = Buffer.from(text, 'latin1');
inspect(`写入 ${target}`, bytes);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, bytes);
console.log('');
console.log(`OK 已写入 ${target}`);
console.log('   -> 纯 ASCII + CRLF，cmd.exe 可正确解析');
