// A/B 定论测试：同一张图、同一个私聊目标，分别用 OneBot HTTP 直连与桥接端点发送，
// 并各自打印 SnowLuma 日志里的渲染结果。判定「桥接路径是否真的发不出图片」。
//
// 用法: node scripts/diag-ab-image.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SL_LOG = 'C:\\SnowLuma\\logs\\snowluma-2026-09-25.log';
const IMG = 'E:\\comfyui\\ComfyUI\\output\\QQ_draw_00021_.png';
const USER = 3108510494;
const KEY = `private:${USER}`;

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const agentToken = sv.conversations[KEY].agentToken;
const consoleToken = cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();

const b64 = fs.readFileSync(IMG).toString('base64');
console.log(`图片: ${IMG} (${(fs.statSync(IMG).size / 1024).toFixed(0)}KB)`);
console.log(`目标: ${KEY}\n`);

function logLines() {
  try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; }
}

function report(before, label, respText) {
  const added = logLines().slice(before).map((x) => x.trim()).filter(Boolean);
  const render = (added.find((l) => l.includes('[OneBot]') && l.includes('发送')) || '(无渲染行)').replace(/^.*发送：/, '');
  const upload = added.some((l) => l.includes('Highway.Image')) ? '有上传' : '无上传';
  const err = added.find((l) => l.includes('error_code') || l.includes('failed'));
  console.log(`${label}`);
  console.log(`  响应 : ${respText.replace(/\s+/g, ' ').slice(0, 130)}`);
  console.log(`  渲染 : ${render.slice(0, 90)}`);
  console.log(`  上传 : ${upload}${err ? ` | 错误: ${err.slice(0, 90)}` : ''}`);
  console.log('');
}

// A) OneBot 直连
{
  const before = logLines().length;
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: USER, message: [{ type: 'image', data: { file: 'base64://' + b64 } }] }),
    signal: AbortSignal.timeout(150000)
  });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 3000));
  report(before, 'A) OneBot HTTP 直连（单段图片）', text);
}

// B) 桥接端点
{
  const before = logLines().length;
  const res = await fetch('http://127.0.0.1:3100/api/socialV2/send-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, 'x-agent-token': agentToken },
    body: JSON.stringify({ key: KEY, path: IMG, message: '' }),
    signal: AbortSignal.timeout(150000)
  });
  const text = await res.text();
  await new Promise((r) => setTimeout(r, 3000));
  report(before, 'B) 桥接端点 /api/socialV2/send-image（单段图片）', text);
}
