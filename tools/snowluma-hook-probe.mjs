// Discover SnowLuma hook/inject RPC surface: /api/debug/actions, /api/connections, /api/qq-list,
// then grep the server bundle for the method names.
// Usage: node tools/snowluma-hook-probe.mjs [port] [password]
import fs from 'node:fs';
const PORT = Number(process.argv[2] || 5099);
const PASSWORD = process.argv[3] || 'sl-rmxPS25t7kCZ-A7';
const BASE = `http://127.0.0.1:${PORT}`;

async function req(path, opts = {}, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE + path, { ...opts, signal: ac.signal });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } catch (e) {
    return { status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

const login = await req('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const token = login.json?.token;
if (!token) {
  console.log('login failed:', login.status, login.text?.slice(0, 200));
  process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };
console.log('login ok, token', token.slice(0, 12) + '...');

for (const path of ['/api/connections', '/api/qq-list', '/api/debug/actions', '/api/global-config', '/api/ui']) {
  const r = await req(path, { headers: auth });
  console.log(`\n== GET ${path} -> HTTP ${r.status}`);
  console.log((r.text || r.error || '').slice(0, 2500));
}

// grep the server bundle for inject/hook method names
const bundle = fs.readFileSync('C:/SnowLuma/server-D1_OR83N.js', 'utf8');
console.log('\n== method-ish identifiers in server bundle ==');
const names = new Set();
for (const m of bundle.matchAll(/["'`]([a-z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*|[a-z][A-Za-z0-9_]{4,40})["'`]\s*[:(]/g)) {
  const id = m[1];
  if (/inject|hook|load|attach|process|account|login|qr|uin/i.test(id)) names.add(id);
}
console.log([...names].sort().join('\n').slice(0, 4000));
