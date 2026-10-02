// 诊断：打印会话记录里 "ownerQQ" 周围的实际文本，搞清楚它是以什么形式存的。
import fs from 'node:fs';
import path from 'node:path';
import { decompressAllFrames } from './lib/zstd-frames.mjs';

const SESSIONS = process.env.QB_SESSIONS_DIR || 'D:\\大烧货\\dsh-home\\sessions';
const file = path.join(SESSIONS, '--C-Users-ExampleUser-Documents--', 'session-21d3b259-816b-463c-9e50-67a147819b81', 'session.v4.jsonl.zstd');
if (!fs.existsSync(file)) { console.error('找不到会话文件'); process.exit(1); }

const text = decompressAllFrames(fs.readFileSync(file));
console.log(`解出 ${text.length} 字符`);

const needle = process.argv[2] || '"ownerQQ"';
const positions = [];
let from = 0;
for (;;) {
  const at = text.indexOf(needle, from);
  if (at === -1) break;
  positions.push(at);
  from = at + needle.length;
  if (positions.length >= 400) break;
}
console.log(`'${needle}' 出现 ${positions.length} 次（最多看 400）\n`);

// 打印前 3 处与最后 3 处的上下文
const show = [...positions.slice(0, 3), ...positions.slice(-3)];
show.forEach((at, i) => {
  const s = Math.max(0, at - 220);
  const e = Math.min(text.length, at + 260);
  console.log(`--- #${i + 1} @${at} ---`);
  console.log(JSON.stringify(text.slice(s, e)));
  console.log('');
});
