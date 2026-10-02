// 给 tools\*.ps1 补齐 UTF-8 BOM。
//
// 为什么必须补：Windows PowerShell 5.1 用系统 ANSI 代码页（本机 cp936/GB2312）
// 解码**无 BOM** 的 .ps1 文件，文件里的中文会被解成乱码（甚至破坏语法）。
// 项目里 qq-bridge-launcher.ps1 的注释已明确这条规则，其做法是"ps1 保持纯 ASCII，
// 中文放 messages.json"；我们要在 ps1 里直接输出中文，就必须带 BOM。
//
// 用法：node tools/ensure-ps1-bom.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes('--check');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// 扫描哪些目录：原先只看 tools/（脚本自己所在目录），结果 scripts/ 下的 .ps1
// 就不在保护范围内 —— 我新写的 scripts/probe-ui.ps1 正因此缺 BOM，
// 而**缺 BOM 会让 PowerShell 5.1 把中文注释按 ANSI 解码**，直接报出
// "The Try statement is missing its Catch or Finally block" 这种莫名其妙的语法错
// （实际是注释里的字节被拆坏了）。现在把两个目录都覆盖。
const SCAN_DIRS = [
  __dirname,                                   // tools/
  path.join(path.resolve(__dirname, '..'), 'scripts'),
  path.join(path.resolve(__dirname, '..'), 'desktop')
];

const targets = [];
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.toLowerCase().endsWith('.ps1')) targets.push({ dir, name });
  }
}
targets.sort((a, b) => (a.dir + a.name).localeCompare(b.dir + b.name));

let changed = 0;
let ok = 0;
const problems = [];

for (const { dir, name } of targets) {
  const label = path.relative(path.resolve(__dirname, '..'), path.join(dir, name)).replace(/\\/g, '/');
  const full = path.join(dir, name);
  const bytes = fs.readFileSync(full);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  // 统计非 ASCII 字节，判断是否真的需要 BOM
  let nonAscii = 0;
  for (const b of bytes) if (b > 127) nonAscii++;

  if (hasBom) {
    console.log(`OK      ${label}  (BOM 已在，非 ASCII 字节 ${nonAscii})`);
    ok++;
    continue;
  }
  if (nonAscii === 0) {
    console.log(`ASCII   ${label}  (纯 ASCII，无需 BOM)`);
    ok++;
    continue;
  }
  if (checkOnly) {
    console.log(`NEEDBOM ${label}  (${nonAscii} 个非 ASCII 字节但缺 BOM —— 5.1 会解码成乱码)`);
    problems.push(label);
    continue;
  }
  fs.writeFileSync(full, Buffer.concat([BOM, bytes]));
  console.log(`FIXED   ${name}  (已补 BOM，非 ASCII 字节 ${nonAscii})`);
  changed++;
}

console.log('');
if (checkOnly) {
  console.log(problems.length ? `=== ${problems.length} 个文件需要补 BOM ===` : '=== 全部合规 ===');
  process.exit(problems.length ? 1 : 0);
}
console.log(`=== 补 BOM ${changed} 个，合规 ${ok} 个 ===`);
