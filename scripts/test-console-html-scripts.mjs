// 校验 public/console.html 里的内联 <script> 语法。
//
// 为什么需要：控制台是单文件页面（约 2370 行），脚本全内联。一旦语法出错，
// **整个页面白屏**（而且和在 iframe 里被安全策略拦掉的表现一模一样，极易误判）。
// 这个页面又被桌面版内嵌使用，改坏了会同时影响浏览器与桌面两条路径。
//
// 做法：抽出每个 <script>…</script> 块 → 写到临时文件 → `node --check` 逐个验证。
// 注意：内联脚本里可能出现顶层 await，所以按 module 解析（.mjs）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'public', 'console.html');

const html = fs.readFileSync(FILE, 'utf8');
// 只要没有 src 属性的内联脚本块
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

if (!blocks.length) {
  console.error('没有找到内联 <script> 块 —— 页面结构可能变了，请人工检查。');
  process.exit(1);
}

let failures = 0;
console.log(`发现 ${blocks.length} 个内联脚本块（共 ${blocks.reduce((a, b) => a + b.length, 0)} 字符）`);
console.log('');

blocks.forEach((code, i) => {
  const tmp = path.join(os.tmpdir(), `qb-console-script-${process.pid}-${i}.mjs`);
  fs.writeFileSync(tmp, code, 'utf8');
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) {
    failures += 1;
    console.log(`FAIL 第 ${i + 1} 个脚本块语法错误：`);
    console.log((r.stderr || '').split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n'));
  } else {
    console.log(`OK   第 ${i + 1} 个脚本块语法正常（${code.split('\n').length} 行）`);
  }
  try { fs.rmSync(tmp, { force: true }); } catch {}
});

// 顺带守住"令牌存储必须容错"这条边界：不允许出现**未被 try 保护**的裸 localStorage 调用。
// （iframe 里 localStorage 可能抛 SecurityError；裸调用若在最前面的 IIFE 里会让整页脚本停摆）
function findBareLocalStorage(source) {
  const lines = source.split('\n');
  const found = [];
  let depth = 0;
  const tryDepthStack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 进入 try 时记下当时的括号深度
    if (/\btry\s*\{/.test(line)) tryDepthStack.push(depth + 1);
    if (/\blocalStorage\.(setItem|getItem|removeItem)\s*\(/.test(line)) {
      const guarded = tryDepthStack.length > 0;
      if (!guarded) found.push({ line: i + 1, text: line.trim() });
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    // 当深度掉回 try 之前时，认为该 try 块结束
    while (tryDepthStack.length && depth < tryDepthStack[tryDepthStack.length - 1]) tryDepthStack.pop();
  }
  return found;
}

const bare = findBareLocalStorage(html);
console.log('');
console.log(bare.length === 0
  ? 'OK   未发现未被 try 保护的 localStorage 调用（令牌存储是容错的）'
  : `FAIL 发现 ${bare.length} 处未被 try 保护的 localStorage 调用 —— iframe 里一旦抛异常会让整页白屏`);
if (bare.length) {
  failures += 1;
  bare.slice(0, 5).forEach((b) => console.log(`      行${b.line}: ${b.text}`));
}

console.log('');
console.log(failures === 0 ? '=== 控制台内联脚本检查通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
