// 从会话记录里定向找回 config.json 的完整内容。
//
// 背景：做卸载功能的沙箱测试时，因核心脚本的 ROOT 按自身位置计算、测试跑了**真实仓库**，
// 删掉了 node_modules 与 config.json（后者被 gitignore、不在 git 里）。
// 但本会话早前读过 config.json，内容留在会话记录里 —— 本脚本把它捞回来。
//
// 做法：先定位到本会话文件（按关键词密度判断），再在解出的文本里找「像完整配置」的 JSON 字面量。
// 策略：找到 "ownerQQ" 出现处，向前回溯到最近的 '{'、向后做括号配对，取最大且能解析成功的那份。
//
// 用法: node scripts/recover-config-from-sessions.mjs [--write] [--show]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decompressAllFrames } from './lib/zstd-frames.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = process.env.QB_SESSIONS_DIR || 'D:\\大烧货\\dsh-home\\sessions';
const doWrite = process.argv.includes('--write');
const doShow = process.argv.includes('--show');

function walk(dir, files = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.jsonl\.zstd$/.test(e.name)) files.push(p);
  }
  return files;
}

const NEEDS = ['ownerQQ', 'snowluma', 'comfy', 'allow'];

/** 从文本里抽出所有"看起来是完整 config"的 JSON 对象 */
function extractCandidates(text) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('"ownerQQ"', from);
    if (at === -1) break;
    from = at + 8;

    // 向后做括号配对（考虑字符串与转义）
    let start = text.lastIndexOf('{', at);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < text.length && i < start + 200_000; i += 1) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) continue;

    // 会话里的 JSON 常被转义成 \" 形式 —— 两种都试
    for (const raw of [text.slice(start, end), text.slice(start, end).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')]) {
      try {
        const obj = JSON.parse(raw);
        if (NEEDS.every((k) => k in obj)) out.push(obj);
        break;
      } catch { /* 换下一种 */ }
    }
  }
  return out;
}

const files = walk(SESSIONS).sort((a, b) => {
  try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
});

let best = null;
let bestWhere = '';
for (const f of files) {
  let text = '';
  try { text = decompressAllFrames(fs.readFileSync(f)); } catch { continue; }
  if (!text.includes('"ownerQQ"')) continue;
  const cands = extractCandidates(text);
  for (const c of cands) {
    const size = JSON.stringify(c).length;
    if (!best || size > best.size) {
      best = c;
      bestWhere = f.replace(SESSIONS, '');
    }
  }
  if (cands.length) {
    console.log(`  ${f.replace(SESSIONS, '').slice(-58)} → ${cands.length} 个候选`);
  }
}

if (!best) {
  console.error('\n❌ 没抽出可解析的完整配置。');
  process.exit(1);
}

console.log(`\n找到最完整的一份（${JSON.stringify(best).length} 字节），来自：${bestWhere}`);
console.log(`  顶层键 ${Object.keys(best).length} 个: ${Object.keys(best).join(', ')}`);

if (doShow) {
  console.log('\n=== 全文 ===');
  console.log(JSON.stringify(best, null, 2));
}

if (doWrite) {
  const target = path.join(ROOT, 'config.json');
  if (fs.existsSync(target)) {
    console.error(`\n❌ ${target} 已存在，拒绝覆盖（先备份再手动处理）。`);
    process.exit(2);
  }
  fs.writeFileSync(target, JSON.stringify(best, null, 2) + '\n', 'utf8');
  console.log(`\n✅ 已写入 ${target}`);
  console.log('   ⚠️ 这是从会话记录恢复的版本，请核对 ownerQQ / 令牌 / 白名单 / 模型文件名。');
} else {
  console.log('\n（未写入；加 --write 才会生成 config.json，加 --show 可看全文）');
}
