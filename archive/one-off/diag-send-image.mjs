// 诊断用：直接调用桥接的 /api/socialV2/send-image 发送一张真实图片到指定会话，
// 打印响应，便于与 SnowLuma 日志对照定位「图片变成 [object Object]」的问题。
//
// 用法: node scripts/diag-send-image.mjs <key> [图片路径] [配文]
//   例: node scripts/diag-send-image.mjs group:837315958 "" "测试配文"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const key = process.argv[2] || 'group:837315958';
const caption = process.argv[4] ?? '';

function pickImage() {
  const given = process.argv[3];
  if (given) return given;
  const out = 'E:\\comfyui\\ComfyUI\\output';
  const pngs = fs.existsSync(out)
    ? fs.readdirSync(out).filter((f) => f.startsWith('QQ_draw') && f.endsWith('.png')).sort()
    : [];
  if (!pngs.length) throw new Error('输出目录里没有 QQ_draw*.png，请先跑 qq_draw_image 或传路径');
  return path.join(out, pngs[pngs.length - 1]);
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const agentToken = sv?.conversations?.[key]?.agentToken;
if (!agentToken) throw new Error(`拿不到 ${key} 的 agent 令牌`);
const consoleToken = cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();

const img = pickImage();
const stat = fs.statSync(img);
console.log(`会话   : ${key}`);
console.log(`图片   : ${img} (${(stat.size / 1024).toFixed(0)}KB)`);
console.log(`配文   : ${caption ? JSON.stringify(caption) : '(无，只发图片单段)'}`);

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:3100/api/socialV2/send-image', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-console-token': consoleToken,
    'x-agent-token': agentToken
  },
  body: JSON.stringify({ key, path: img, message: caption }),
  signal: AbortSignal.timeout(180000)
});
const text = await res.text();
console.log(`\nHTTP ${res.status} （耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
console.log(text);
