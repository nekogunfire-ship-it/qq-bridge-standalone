// OneBot 请求记录代理：监听本地端口，把请求原样转发到真实 SnowLuma，
// 并把「桥接实际发出的 body」写进日志文件。
// 用途：定位桥接发出的 payload 与手动调用有何差异。
//
// 用法: node scripts/diag-onebot-proxy.mjs [监听端口] [上游地址]
//   例: node scripts/diag-onebot-proxy.mjs 3010 http://127.0.0.1:3000
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 3010);
const UPSTREAM = (process.argv[3] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const LOG = path.join(ROOT, 'state', 'diag-onebot-proxy.log');

fs.writeFileSync(LOG, `# proxy started ${new Date().toISOString()} → ${UPSTREAM}\n`);

function summarize(body) {
  // 只描述结构，绝不把 base64 全量写进日志
  try {
    const j = JSON.parse(body);
    const m = j.message;
    const shape = (seg) => {
      if (typeof seg === 'string') return { type: 'string', len: seg.length };
      if (Array.isArray(seg)) {
        return seg.map((s) => {
          const t = s && typeof s === 'object' ? String(s.type) : typeof s;
          const d = s && typeof s === 'object' && s.data && typeof s.data === 'object' ? s.data : {};
          const fields = {};
          for (const [k, v] of Object.entries(d)) {
            fields[k] = typeof v === 'string' ? `${typeof v}(len=${v.length}${v.startsWith('base64://') ? ',base64' : ''})` : `${typeof v}:${JSON.stringify(v)}`;
          }
          return { type: t, dataFieldTypes: fields };
        });
      }
      if (seg && typeof seg === 'object') return { type: 'object', dataFieldTypes: Object.keys(seg.data ?? {}) };
      return { type: typeof seg };
    };
    return { keys: Object.keys(j), messageShape: shape(m), messageType: Array.isArray(m) ? 'array' : typeof m };
  } catch (e) {
    return { parseError: String(e.message), rawPrefix: body.slice(0, 200) };
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');

  const entry = {
    time: new Date().toISOString(),
    path: req.url,
    contentLength: String(req.headers['content-length'] ?? ''),
    summary: summarize(body)
  };
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  console.log(`[proxy] ${req.url} len=${body.length} -> ${JSON.stringify(entry.summary).slice(0, 300)}`);

  try {
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: body || undefined,
      signal: AbortSignal.timeout(180000)
    });
    const text = await up.text();
    fs.appendFileSync(LOG, `  response ${up.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}\n`);
    console.log(`[proxy] response ${up.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    res.writeHead(up.status, { 'content-type': 'application/json' });
    res.end(text);
  } catch (e) {
    fs.appendFileSync(LOG, `  ERROR: ${e.message}\n`);
    console.log(`[proxy] ERROR ${e.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: -1, wording: `proxy error: ${e.message}` }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] listening http://127.0.0.1:${PORT} → ${UPSTREAM}`);
  console.log(`[proxy] 日志: ${LOG}`);
  console.log('[proxy] 把桥接 config.json 的 snowluma.httpUrl 指到本端口即可记录它的真实 payload');
});
