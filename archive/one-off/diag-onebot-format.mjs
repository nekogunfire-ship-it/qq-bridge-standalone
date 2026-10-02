// 判定 SnowLuma 到底接受哪种 message 形式：纯文本字符串 / 结构化数组（文本段）/
// 结构化数组（图片段）/ 带 message_format 参数。每次发送后打印 SnowLuma 新增日志。
//
// 用法: node scripts/diag-onebot-format.mjs [key]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SL_LOG = 'C:\\SnowLuma\\logs\\snowluma-2026-09-25.log';

const key = process.argv[2] || 'group:837315958';
const [kind, id] = key.split(':');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken || '';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7i7D0AAAAASUVORK5CYII=';
const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';

function logLines() {
  try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; }
}

async function attempt(label, extraParams) {
  const before = logLines().length;
  const params = kind === 'private'
    ? { user_id: Number(id), ...extraParams }
    : { group_id: Number(id), ...extraParams };
  let status = 0;
  let body = '';
  try {
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60000)
    });
    status = res.status;
    body = await res.text();
  } catch (e) {
    body = `fetch 失败: ${e.message}`;
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`===== ${label} =====`);
  console.log(`  message = ${JSON.stringify(params.message).slice(0, 130)}`);
  console.log(`  HTTP ${status} | ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  for (const l of logLines().slice(before).map((x) => x.trim()).filter(Boolean).slice(0, 6)) {
    console.log(`  LOG| ${l.slice(0, 160)}`);
  }
  console.log('');
}

// 1) 纯文本字符串（基线：必须成功）
await attempt('1) message = 纯文本字符串', { message: '[诊断1] 字符串文本' });

// 2) 结构化数组 + 文本段（检验数组是否被支持）
await attempt('2) message = [{type:text}]', { message: [{ type: 'text', data: { text: '[诊断2] 数组文本段' } }] });

// 3) 结构化数组 + 文本段 + message_format=array
await attempt('3) 同 2 但 message_format=array', {
  message: [{ type: 'text', data: { text: '[诊断3] 数组文本段+format' } }],
  message_format: 'array'
});

// 4) 结构化数组 + 图片段（我目前的做法）
await attempt('4) message = [{type:image}]', {
  message: [{ type: 'image', data: { file: 'base64://' + PNG_B64 } }]
});

// 5) 单段对象（非数组）
await attempt('5) message = {type:text}（单对象）', { message: { type: 'text', data: { text: '[诊断5] 单对象' } } });
