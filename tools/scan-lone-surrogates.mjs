// 扫描“孤立代理项”（半个 emoji），可扫 DSH 会话日志、桥接 state 文件、任意文本。
//
// 为什么需要它：QQ 消息里的 emoji 在 UTF-16 里是两个码元。按码元截断（slice(0,N)/slice(-N)）
// 可能切出孤立代理项；这种文本一进 prompt，DeepSeek 解析 JSON 就 400，而且那条历史会永久
// 污染该会话（详见 docs/incident-2026-09-25-lone-surrogate-400.md）。
//
// 用法：
//   node tools/scan-lone-surrogates.mjs <file...>              # 扫普通文本/JSON 文件
//   node tools/scan-lone-surrogates.mjs --session <file.zstd>  # 扫 DSH 会话日志（多帧 zstd）
import fs from 'node:fs';
import zlib from 'node:zlib';

const LONE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// JSON 里的孤立代理项通常以“落单转义”形式存在：`\ud83d` 后面没跟 `\udc07` 这类低位转义。
// DeepSeek 的 JSON 解析器就是被这种写法噎住的，所以两种写法都要扫。
function scanEscapes(text) {
  const hits = [];
  const high = /\\u([dD][89abAB][0-9a-fA-F]{2})/g;
  let match;
  while ((match = high.exec(text)) !== null) {
    const after = text.slice(high.lastIndex, high.lastIndex + 6);
    if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(after)) {
      hits.push({ at: match.index, kind: `落单高位转义 \\u${match[1]}`, context: text.slice(Math.max(0, match.index - 40), match.index + 40) });
    }
  }
  const low = /\\u([dD][c-fC-F][0-9a-fA-F]{2})/g;
  while ((match = low.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 6), match.index);
    if (!/\\u[dD][89abAB][0-9a-fA-F]{2}$/.test(before)) {
      hits.push({ at: match.index, kind: `落单低位转义 \\u${match[1]}`, context: text.slice(Math.max(0, match.index - 40), match.index + 40) });
    }
  }
  return hits;
}

function readSessionFrames(file) {
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
    } catch {}
  }
  return parts.join('').split('\n').filter((line) => line.trim());
}

function scanText(label, text) {
  const hits = scanEscapes(text).map((hit) => ({ at: hit.at, code: hit.kind, context: hit.context }));
  let match;
  LONE_RE.lastIndex = 0;
  while ((match = LONE_RE.exec(text)) !== null) {
    const at = match.index;
    hits.push({ at, code: `原始 U+${text.codePointAt(at).toString(16).toUpperCase()}`, context: text.slice(Math.max(0, at - 40), at + 40) });
    if (hits.length >= 20) break;
  }
  return hits;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node tools/scan-lone-surrogates.mjs [--session] <file...>');
  process.exit(1);
}

let total = 0;
for (let i = 0; i < args.length; i++) {
  const isSession = args[i] === '--session';
  const file = isSession ? args[++i] : args[i];
  if (!file) continue;
  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${file}（不存在）`);
    continue;
  }
  let lines;
  if (isSession) lines = readSessionFrames(file);
  else lines = fs.readFileSync(file, 'utf8').split('\n');
  let fileHits = 0;
  for (let n = 0; n < lines.length; n++) {
    const hits = scanText(file, lines[n]);
    if (hits.length === 0) continue;
    fileHits += hits.length;
    for (const hit of hits) {
      console.log(`HIT  ${file} 行 ${n + 1} 位置 ${hit.at} ${hit.code}`);
      console.log(`     …${JSON.stringify(hit.context)}…`);
    }
  }
  total += fileHits;
  console.log(`${fileHits === 0 ? 'OK  ' : 'WARN'} ${file}：${fileHits} 处孤立代理项`);
}
console.log(total === 0 ? '\n未发现孤立代理项' : `\n共发现 ${total} 处（需要清理，见 docs/incident-2026-09-25-lone-surrogate-400.md）`);
process.exit(total === 0 ? 0 : 2);
