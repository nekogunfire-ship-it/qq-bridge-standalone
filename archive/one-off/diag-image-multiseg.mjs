// 判定「图片段 + 文字段」的多段数组是否就是失败原因（桥接走的是这条路）。
// 对照：单段图片 / 图片+文字 / 文字+图片。
//
// 用法: node scripts/diag-image-multiseg.mjs [key]
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
const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';

// 用桥接实际发过的那张图（1003KB），与失败场景完全一致
const imgPath = 'E:\\comfyui\\ComfyUI\\output\\QQ_draw_00021_.png';
const b64 = fs.readFileSync(imgPath).toString('base64');
console.log(`图片: ${imgPath} (${(fs.statSync(imgPath).size / 1024).toFixed(0)}KB) → base64 ${(b64.length / 1024).toFixed(0)}KB\n`);

function logLines() {
  try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; }
}

async function attempt(label, message) {
  const before = logLines().length;
  const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message };
  const segDesc = Array.isArray(message)
    ? message.map((s) => s.type).join('+') + ` (${message.length} 段)`
    : 'CQ字符串';
  let body = '';
  try {
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params), signal: AbortSignal.timeout(120000)
    });
    body = await res.text();
  } catch (e) { body = `fetch 失败: ${e.message}`; }
  await new Promise((r) => setTimeout(r, 2500));
  const ok = body.includes('"status":"ok"');
  const added = logLines().slice(before).map((x) => x.trim()).filter(Boolean);
  const render = (added.find((l) => l.includes('[OneBot]') && l.includes('发送')) || '').replace(/^.*发送：/, '');
  const upload = added.find((l) => l.includes('Highway.Image')) ? '有上传' : '无上传';
  console.log(`${(ok ? 'OK  ' : 'FAIL')} ${label}`);
  console.log(`      段结构: ${segDesc} | 渲染: ${render.slice(0, 90)} | ${upload}`);
  if (!ok) console.log(`      错误: ${body.replace(/\s+/g, ' ').slice(0, 140)}`);
  console.log('');
}

const imgSeg = { type: 'image', data: { file: 'base64://' + b64 } };
const txtSeg = { type: 'text', data: { text: '配文测试' } };

await attempt('1) 单段图片', [imgSeg]);
await attempt('2) 图片 + 文字（桥接当前的顺序）', [imgSeg, txtSeg]);
await attempt('3) 文字 + 图片', [txtSeg, imgSeg]);
