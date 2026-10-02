// 验证 bridge.js 修复后的段构造：sendSegments 应收到 [image]（无空 text 段）。
// 本脚本**直接复刻修复后的构造逻辑**并通过 OneBot 发出，证明该段结构能真正送达图片。
//
// 用法: node scripts/diag-verify-fix.mjs [key]
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
const imageBuffer = fs.readFileSync(IMG);

// ── 复刻 bridge.js 修复后的构造（send-image 端点 + sendSegments）──────────
// 端点里：先按需 push reply/at，再 push image，caption 非空才 push text。
const caption = ''; // 无配文，正是出错场景
const segments = [];
segments.push({ type: 'image', data: { file: 'base64://' + imageBuffer.toString('base64') } });
if (caption) segments.push({ type: 'text', data: { text: caption } });

console.log(`图片: ${IMG} (${(imageBuffer.length / 1024).toFixed(0)}KB)`);
console.log(`段结构: ${segments.map((s) => s.type).join(' + ')}（修复后不再追空空 text 段）`);
console.log(`端点发送时 caption=${JSON.stringify(caption)}，故不 push text 段\n`);

function logLines() { try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; } }

const before = logLines().length;
const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
const res = await fetch(`${httpUrl}/${action}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(params),
  signal: AbortSignal.timeout(150000)
});
const body = await res.text();
await new Promise((r) => setTimeout(r, 3000));

const added = logLines().slice(before).map((x) => x.trim()).filter(Boolean);
const render = (added.find((l) => l.includes('[OneBot]') && l.includes('发送')) || '(无)').replace(/^.*发送：/, '');
const upload = added.some((l) => l.includes('Highway.Image')) ? '有上传' : '无上传';

console.log(`响应: ${body.replace(/\s+/g, ' ').slice(0, 140)}`);
console.log(`渲染: ${render.slice(0, 80)}`);
console.log(`上传: ${upload}`);
console.log('');
console.log(render.includes('[图片]') && upload === '有上传'
  ? '✅ 修复有效：该段结构能真正把图片送出去'
  : '❌ 仍然失败，需要继续排查');
