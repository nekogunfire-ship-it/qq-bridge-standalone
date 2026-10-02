// 按图片体积扫描：找出 SnowLuma 图片上传在多大开始失败。
// 用同一张图的多个缩放/放大版本，逐个发送并打印结果与渲染行。
//
// 用法: node scripts/diag-image-size-sweep.mjs [key] [尺寸列表，逗号分隔]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SL_LOG = 'C:\\SnowLuma\\logs\\snowluma-2026-09-25.log';

const key = process.argv[2] || 'group:837315958';
const sizes = (process.argv[3] || '256,512,768,1024,1280').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
const [kind, id] = key.split(':');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken || '';
const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 生成高熵 PNG（噪声，压不动，体积可控地大）
function makePng(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let seed = 12345;
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size * 3; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[o++] = (seed >> 16) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 1 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

function logLines() {
  try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; }
}

console.log('尺寸  体积     结果  渲染/错误');
console.log('------------------------------------------------------------');
for (const size of sizes) {
  const png = makePng(size);
  const kb = png.length / 1024;
  const before = logLines().length;
  const message = [{ type: 'image', data: { file: 'base64://' + png.toString('base64') } }];
  const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message };
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
  const render = added.find((l) => l.includes('[OneBot]') && l.includes('发送')) || '';
  const err = added.find((l) => l.includes('error_code') || l.includes('failed')) || '';
  const detail = ok ? render.replace(/^.*发送：/, '').slice(0, 60) : (err || body.replace(/\s+/g, ' ')).slice(0, 70);
  console.log(`${String(size).padEnd(6)}${(kb.toFixed(0) + 'KB').padEnd(9)}${(ok ? 'OK' : 'FAIL').padEnd(6)}${detail}`);
}
