// 绕开桥接，直接用 OneBot HTTP 给 SnowLuma 发一张极小的 PNG，
// 对照「base64://」与「本地文件路径」两种 file 来源，判断哪一种能真正发出图片。
// 每发一次就打印 SnowLuma 日志新增行，便于判定。
//
// 用法: node scripts/diag-onebot-image.mjs <key> <base64|path|both>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SL_LOG = 'C:\\SnowLuma\\logs\\snowluma-2026-09-25.log';

const key = process.argv[2] || 'group:837315958';
const mode = process.argv[3] || 'both';
const [kind, id] = key.split(':');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken || '';

// 2x2 红色 PNG（最小可用图片）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7i7D0AAAAASUVORK5CYII=';
const TMP_PNG = path.join(ROOT, 'state', '__diag_tiny.png');
fs.writeFileSync(TMP_PNG, Buffer.from(PNG_B64, 'base64'));
console.log(`临时图片: ${TMP_PNG} (${fs.statSync(TMP_PNG).size} 字节)`);
console.log(`SnowLuma: ${httpUrl} | 目标: ${key}\n`);

function logLineCount() {
  try { return fs.readFileSync(SL_LOG, 'utf8').split('\n').length; } catch { return 0; }
}
function newLogLines(before) {
  try {
    const lines = fs.readFileSync(SL_LOG, 'utf8').split('\n');
    return lines.slice(before).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

async function sendOne(label, segments) {
  const before = logLineCount();
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const params = kind === 'private'
    ? { user_id: Number(id), message: segments }
    : { group_id: Number(id), message: segments };
  const t0 = Date.now();
  let httpStatus = 0;
  let body = '';
  try {
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60000)
    });
    httpStatus = res.status;
    body = await res.text();
  } catch (e) {
    body = `fetch 失败: ${e.message}`;
  }
  await new Promise((r) => setTimeout(r, 1200));
  console.log(`===== ${label} =====`);
  console.log(`  请求段: ${JSON.stringify(segments).slice(0, 150)}`);
  console.log(`  HTTP ${httpStatus} （${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  console.log(`  响应: ${body.replace(/\s+/g, ' ').slice(0, 260)}`);
  const lines = newLogLines(before);
  for (const l of lines.slice(0, 8)) console.log(`  LOG| ${l.slice(0, 170)}`);
  console.log('');
}

// A) 老式 CQ 码字符串
if (mode === 'both' || mode === 'cq') {
  await sendOne('A) file 用 base64:// （我目前的做法，结构化数组）', [
    { type: 'image', data: { file: 'base64://' + PNG_B64 } }
  ]);
}

// B) 本地文件路径
if (mode === 'both' || mode === 'path') {
  await sendOne('B) file 用本地绝对路径（SnowLuma 自己读盘上传）', [
    { type: 'image', data: { file: TMP_PNG } }
  ]);
}

// C) CQ 码字符串形式
if (mode === 'both' || mode === 'cq') {
  const before = logLineCount();
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const params = kind === 'private'
    ? { user_id: Number(id), message: `[CQ:image,file=base64://${PNG_B64}]` }
    : { group_id: Number(id), message: `[CQ:image,file=base64://${PNG_B64}]` };
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000)
  });
  const body = await res.text();
  await new Promise((r) => setTimeout(r, 1200));
  console.log('===== C) CQ 码字符串 [CQ:image,file=base64://...] =====');
  console.log(`  HTTP ${res.status}`);
  console.log(`  响应: ${body.replace(/\s+/g, ' ').slice(0, 260)}`);
  for (const l of newLogLines(before).slice(0, 8)) console.log(`  LOG| ${l.slice(0, 170)}`);
  console.log('');
}

fs.rmSync(TMP_PNG, { force: true });
