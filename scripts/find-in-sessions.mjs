// 在会话记录里搜关键词（用多帧解码）。
// 用法: node scripts/find-in-sessions.mjs <关键词> [关键词2 ...]
import fs from 'node:fs';
import path from 'node:path';
import { decompressAllFrames } from './lib/zstd-frames.mjs';

const SESSIONS = process.env.QB_SESSIONS_DIR || 'D:\\大烧货\\dsh-home\\sessions';
const keys = process.argv.slice(2);
if (!keys.length) {
  console.error('用法: node scripts/find-in-sessions.mjs <关键词> [...]');
  process.exit(2);
}

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

const files = walk(SESSIONS).sort((a, b) => {
  try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
});

console.log(`搜索 ${files.length} 个会话文件，关键词：${keys.join(', ')}\n`);
let anyHit = false;
for (const f of files) {
  let text = '';
  try { text = decompressAllFrames(fs.readFileSync(f)); } catch { continue; }
  const counts = keys.map((k) => ({ k, n: text.split(k).length - 1 }));
  const hit = counts.filter((c) => c.n > 0);
  if (!hit.length) continue;
  anyHit = true;
  const mb = (fs.statSync(f).size / 1048576).toFixed(2);
  console.log(`  ${mb}MB  ${f.replace(SESSIONS, '')}`);
  console.log(`      ${hit.map((c) => `${c.k}×${c.n}`).join('  ')}   文本 ${text.length} 字符`);
}
if (!anyHit) console.log('  （没有任何文件命中）');
