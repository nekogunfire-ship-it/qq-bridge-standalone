// 对照测试：image 段只用 file / 只用 url / 两者都给 / 用 data: URL，
// 找出 SnowLuma 实际接受哪种来源字段。
// 用小图（约 4KB 的真实 PNG），避免尺寸因素干扰。
//
// 用法: node scripts/diag-image-source-field.mjs [key]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SL_LOG = 'C:\\SnowLuma\\logs\\snowluma-2026-09-25.log';

const key = process.argv[2] || 'group:837315958';
const [kind, id] = key.split(':');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.accessToken || '';
const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';

// 生成一张有噪声的 256x256 PNG（约几十 KB，远大于最小尺寸，又不是大文件）
function makePng(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter
    for (let x = 0; x < size; x++) {
      raw[o++] = (x * 7 + y * 13) & 0xff;
      raw[o++] = (x * 31 + y * 3) & 0xff;
      raw[o++] = ((x ^ y) * 17) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}
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

const png = makePng(256);
const b64 = png.toString('base64');
const tmp = path.join(ROOT, 'state', '__diag_256.png');
fs.writeFileSync(tmp, png);
console.log(`测试图: ${tmp} (${(png.length / 1024).toFixed(1)}KB, 256x256)\n`);

function logLines() {
  try { return fs.readFileSync(SL_LOG, 'utf8').split('\n'); } catch { return []; }
}

async function attempt(label, message) {
  const before = logLines().length;
  const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message };
  let status = 0; let body = '';
  try {
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params), signal: AbortSignal.timeout(90000)
    });
    status = res.status; body = await res.text();
  } catch (e) { body = `fetch 失败: ${e.message}`; }
  await new Promise((r) => setTimeout(r, 2500));
  const verdict = body.includes('"status":"ok"') ? 'OK  ' : 'FAIL';
  console.log(`${verdict} ${label}`);
  console.log(`     HTTP ${status} | ${body.replace(/\s+/g, ' ').slice(0, 170)}`);
  const added = logLines().slice(before).map((x) => x.trim()).filter(Boolean);
  const renderLine = added.find((l) => l.includes('[OneBot]') && l.includes('发送'));
  if (renderLine) console.log(`     渲染: ${renderLine.slice(0, 120)}`);
  const errLine = added.find((l) => l.includes('failed') || l.includes('error_code'));
  if (errLine) console.log(`     错误: ${errLine.slice(0, 140)}`);
  console.log('');
}

await attempt('A) data:{file: base64://}', [{ type: 'image', data: { file: 'base64://' + b64 } }]);
await attempt('B) data:{url:  base64://}', [{ type: 'image', data: { url: 'base64://' + b64 } }]);
await attempt('C) data:{file, url} 都给', [{ type: 'image', data: { file: 'base64://' + b64, url: 'base64://' + b64 } }]);
await attempt('D) data:{file: 本地路径}', [{ type: 'image', data: { file: tmp } }]);
await attempt('E) CQ 码字符串 base64', `[CQ:image,file=base64://${b64}]`);

fs.rmSync(tmp, { force: true });
