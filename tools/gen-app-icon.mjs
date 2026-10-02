// 生成应用自己的图标 —— `assets/app-icon.png`（256）与 `assets/tray-icon.png`（32）。
//
// 为什么要自己画一个：托盘与窗口原来引用的候选是 `assets/dsh-0.1.13.ico` /
// `assets/icon.png` / `public/favicon.ico` —— **三个都不存在**，于是 Tray 拿到的是
// 空图标（`nativeImage.createEmpty()`）。而且第一个候选的名字本身就是 DSH 的图标，
// 属于"与 DSH 绑着"的残留之一。
// 仓库里现成只有 `assets/deepseek娘.png`（552×770 人物立绘）—— 缩到 16px 托盘会糊成一团，
// 不适合做图标；所以这里画一个几何图形（16px 下也能认出来）。
//
// 纯 Node，无第三方依赖：手写 PNG（zlib + CRC32）。
// 想换成自己的图：直接覆盖 `assets/app-icon.png`（256×256 PNG）即可，不用改代码。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── PNG 编码 ────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  // 10/11/12 = compression/filter/interlace = 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── 形状（归一化 0~1 坐标）──────────────────────────────────────────────────
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ACCENT_TOP = hex('#5b9dff');     // = style.css 的 --accent
const ACCENT_BOT = hex('#2f5ea8');     // = --accent-dim
const DOT = hex('#3b7fe0');

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return ((x - cx) ** 2 + (y - cy) ** 2) <= r * r;
}
function inCircle(x, y, cx, cy, r) {
  return ((x - cx) ** 2 + (y - cy) ** 2) <= r * r;
}
function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// 一个圆角方块底 + 白色对话气泡 + 三个点（16px 下依然认得出是"聊天"）
function sample(x, y) {
  // 背景圆角方块
  if (!inRoundRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.22)) return null;
  const bubble = inRoundRect(x, y, 0.22, 0.25, 0.78, 0.62, 0.11)
    || inTriangle(x, y, [0.30, 0.58], [0.30, 0.78], [0.46, 0.58]);
  if (bubble) {
    for (const dx of [0.36, 0.50, 0.64]) {
      if (inCircle(x, y, dx, 0.435, 0.045)) return { c: DOT, a: 1 };
    }
    return { c: [255, 255, 255], a: 1 };
  }
  // 底色：竖向渐变
  const t = (y - 0.06) / 0.88;
  const c = [
    Math.round(ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * t),
    Math.round(ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * t),
    Math.round(ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * t)
  ];
  return { c, a: 1 };
}

// 每像素 4×4 超采样 → 边缘平滑
function render(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const s = sample(x, y);
          if (s) { r += s.c[0]; g += s.c[1]; b += s.c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      // k = 被形状覆盖的子采样数。RGB 要按**覆盖数**归一化（取被覆盖样本的平均色），
      // 不能按 n 归一化 —— 否则每个像素都被多除 16 倍，整个图标发黑
      // （第一版就是这么错的：看着"PNG 合法、尺寸正确"，但图是黑的）。
      const k = a / 255;
      if (k > 0) {
        buf[i] = Math.round(r / k);
        buf[i + 1] = Math.round(g / k);
        buf[i + 2] = Math.round(b / k);
      }
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
}

for (const [name, size] of [['app-icon.png', 256], ['tray-icon.png', 32]]) {
  const out = path.join(ROOT, 'assets', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(render(size), size));
  console.log(`  ${name}  ${size}x${size}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}
console.log('  完成。想换成自己的图：直接覆盖 assets/app-icon.png（256×256 PNG）。');
