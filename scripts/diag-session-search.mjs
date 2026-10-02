// 诊断：确认会话记录的读取方式正确（对照搜索已知出现在会话里的关键词）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SESSIONS = process.env.QB_SESSIONS_DIR || 'D:\\大烧货\\dsh-home\\sessions';

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
}).slice(0, 12);

console.log(`检查最近 ${files.length} 个会话文件：\n`);

const KEYS = ['ownerQQ', 'anima-turbo', 'snowluma', 'qq-bridge', 'curl.exe'];
for (const f of files) {
  let text = '';
  let err = '';
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
  } catch (e) {
    err = String(e?.message ?? e).slice(0, 60);
  }
  const mb = (fs.statSync(f).size / 1048576).toFixed(2);
  const name = f.replace(SESSIONS, '').slice(-60);
  if (err) {
    console.log(`  [解压失败] ${mb}MB ${name} — ${err}`);
    continue;
  }
  const hits = KEYS.map((k) => `${k}:${text.split(k).length - 1}`).join('  ');
  console.log(`  ${mb}MB  行数=${text.split('\n').length}  ${hits}`);
  console.log(`        ${name}`);
}
