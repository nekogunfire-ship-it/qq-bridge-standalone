// 内嵌放行头的回归测试。
//
// 背景：桥接对控制台响应默认发 `X-Frame-Options: DENY`（防点击劫持），
// 这会让桌面版的内嵌 iframe 内容被浏览器丢弃（表现为"状态已加载但一片空白"）。
// 修法是给内嵌场景一条**显式通道**：只对带 `?embed=1` 的请求放宽为 SAMEORIGIN。
//
// 本测试要守住的关键边界：
//   ① 带 embed=1  → SAMEORIGIN（桌面版能嵌入）
//   ② 不带 embed  → DENY（外部网页依旧无法嵌入）
//   ③ API 端点    → DENY（不能因为这次改动把整站都放开）
//
// 桥接未运行时跳过（返回码 2），不当作失败 —— 它需要真实运行中的桥接。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 3100;

function readToken() {
  for (const p of [path.join(ROOT, 'state', 'console-token')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return cfg?.consoleToken ?? '';
  } catch { return ''; }
}

function head(pathname, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: pathname, method: 'GET', headers: extraHeaders }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const token = readToken();
const qs = token ? `&token=${encodeURIComponent(token)}` : '';

let base;
try {
  base = await head('/api/status', token ? { 'x-console-token': token } : {});
} catch (error) {
  console.log(`SKIP  桥接未运行（${error?.message ?? error}），本测试需要真实桥接`);
  process.exit(2);
}
check('桥接可达', base.status > 0, `HTTP ${base.status}`);

const withEmbed = await head(`/?embed=1${qs}`);
check('带 embed=1 时放行同源嵌入',
  String(withEmbed.headers['x-frame-options'] ?? '').toUpperCase() === 'SAMEORIGIN',
  `X-Frame-Options=${withEmbed.headers['x-frame-options']}`);

const withoutEmbed = await head(`/${token ? `?token=${encodeURIComponent(token)}` : ''}`);
check('不带 embed 时仍禁止嵌入（外部网页无法嵌入）',
  String(withoutEmbed.headers['x-frame-options'] ?? '').toUpperCase() === 'DENY',
  `X-Frame-Options=${withoutEmbed.headers['x-frame-options']}`);

check('API 端点仍禁止嵌入（改动没有放开整站）',
  String(base.headers['x-frame-options'] ?? '').toUpperCase() === 'DENY',
  `X-Frame-Options=${base.headers['x-frame-options']}`);

check('控制台仍带 nosniff 与 no-store（其它安全头未被削弱）',
  String(withEmbed.headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff'
  && String(withEmbed.headers['cache-control'] ?? '').includes('no-store'),
  `nosniff=${withEmbed.headers['x-content-type-options']} cache=${withEmbed.headers['cache-control']}`);

console.log('');
console.log(failures === 0 ? '=== 内嵌放行头测试通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
