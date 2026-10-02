// zstd 多帧解码：DSH 的 session.v4.jsonl.zstd 是「每行一个独立 zstd 帧」，
// 单次 zstdDecompressSync 只解出第一帧，所以要先按魔数切帧再逐帧解。
//
// 用法（作为库）: import { decompressAllFrames } from './lib/zstd-frames.mjs'
// 用法（命令行）: node scripts/lib/zstd-frames.mjs <文件> [关键词...]
import fs from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

/** 按 zstd 魔数切分并逐帧解压，拼成一份文本。 */
export function decompressAllFrames(buf) {
  const starts = [];
  let idx = buf.indexOf(ZSTD_MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4);
  }
  if (!starts.length) return '';
  const parts = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'));
    } catch {
      // 单帧坏掉不影响其余帧
    }
  }
  return parts.join('\n');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const file = process.argv[2];
  const keys = process.argv.slice(3);
  if (!file) {
    console.error('用法: node scripts/lib/zstd-frames.mjs <文件> [关键词...]');
    process.exit(2);
  }
  const text = decompressAllFrames(fs.readFileSync(file));
  console.log(`解出 ${text.length} 字符，${text.split('\n').length} 行`);
  for (const k of keys) {
    console.log(`  '${k}' 出现 ${text.split(k).length - 1} 次`);
  }
  if (!keys.length) console.log(text.slice(0, 1500));
}
