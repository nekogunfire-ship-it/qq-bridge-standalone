// 读取 DSH 会话日志（session.v4.jsonl.zstd）。
//
// 为什么需要它：DSH 的会话日志是**多帧 zstd** —— 每次追加都会写一个新的 zstd frame，
// 所以 `zlib.zstdDecompressSync(file)` 只能解出第一帧（通常只有一行 session 头），
// 必须按 magic `28 B5 2F FD` 切帧逐段解压才能拿到完整历史。
//
// 用法：
//   node tools/read-dsh-session-log.mjs <session.v4.jsonl.zstd> [tailLines]
//   node tools/read-dsh-session-log.mjs <file> 0 > session.jsonl     # 全量导出
//
// 拿到 JSONL 后常看的字段：
//   turn/end      → reason.kind = completed | error | aborted（error 里带 message/code）
//   assistant/attempt → 每次模型请求的结果（含 stream 里的 finish.reason）
//   request/header / request/context → 工具面、模型、上下文窗口等请求头快照
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const tail = process.argv[3] ? Number(process.argv[3]) : 0;
if (!file) {
  console.error('用法：node tools/read-dsh-session-log.mjs <session.v4.jsonl.zstd> [tailLines]');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let cursor = 0;
while (true) {
  const at = buf.indexOf(MAGIC, cursor);
  if (at < 0) break;
  offsets.push(at);
  cursor = at + 1;
}

const parts = [];
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString());
  } catch (error) {
    console.error(`[frame ${i} @${start}..${end}] ${error.message}`);
  }
}

const lines = parts.join('').split('\n').filter((line) => line.trim());
console.error(`[info] 帧数 ${offsets.length}，日志行 ${lines.length}，文件 ${buf.length} 字节`);
for (const line of tail > 0 ? lines.slice(-tail) : lines) console.log(line);
