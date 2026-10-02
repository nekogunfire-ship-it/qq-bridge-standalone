// 验证核心假设：SnowLuma 对「图片 + 空文本段」这种组合是否整条渲染坏。
// 对照四种组合，确认空 text 段是不是元凶。
//
// 用法: node scripts/diag-empty-text.mjs [key]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SL_LOG = 'C:\\SnowLuma\\logs\\snowluma-2026-09-25.log';
const IMG = 'E:\\comfyui\\ComfyUI\\output\\QQ_draw_00021_.png';

const key = process.argv[2] || 'private:3108510494';
const [kind, id] = key.split(':');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
const b64 = fs.readFileSync(IMG).toString('base64');

function logLines() { try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; } }

async function attempt(label, message) {
  const before = logLines().length;
  const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message };
  let body = '';
  try {
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params), signal: AbortSignal.timeout(120000)
    });
    body = await res.text();
  } catch (e) { body = `失败: ${e.message}`; }
  await new Promise((r) => setTimeout(r, 2500));
  const added = logLines().slice(before).map((x) => x.trim()).filter(Boolean);
  const render = (added.find((l) => l.includes('[OneBot]') && l.includes('发送')) || '(无)').replace(/^.*发送：/, '');
  const upload = added.some((l) => l.includes('Highway.Image')) ? '有上传' : '无上传';
  const ok = body.includes('"status":"ok"');
  console.log(`${(ok ? 'OK  ' : 'FAIL')} ${label}`);
  console.log(`      渲染: ${render.slice(0, 70)} | ${upload}`);
  console.log('');
}

const img = { type: 'image', data: { file: 'base64://' + b64 } };

await attempt('1) [图片]  单段', [img]);
await attempt('2) [图片, 空文本]  ← 桥接原来发出的结构', [img, { type: 'text', data: { text: '' } }]);
await attempt('3) [图片, 文本]', [img, { type: 'text', data: { text: '配文' } }]);
await attempt('4) [空文本, 图片]', [{ type: 'text', data: { text: '' } }, img]);
