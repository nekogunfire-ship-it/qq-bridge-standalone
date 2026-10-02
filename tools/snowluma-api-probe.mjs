// Probe SnowLuma WebUI API: login, then enumerate client bundle routes and try hook/account endpoints.
// Usage: node tools/snowluma-api-probe.mjs [port] [password]
const PORT = Number(process.argv[2] || 5099);
const PASSWORD = process.argv[3] || 'sl-rmxPS25t7kCZ-A7';
const BASE = `http://127.0.0.1:${PORT}`;

async function req(path, opts = {}, ms = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE + path, { ...opts, signal: ac.signal });
    const text = await r.text();
    return { status: r.status, json: safeJson(text), text, headers: r.headers };
  } catch (e) {
    return { status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}
function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const login = await req('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const token = login.json?.token;
console.log('login:', login.status, token ? `token ${token.slice(0, 12)}...` : login.text.slice(0, 200));
if (!token) process.exit(1);
const auth = { authorization: `Bearer ${token}` };

// 1) enumerate client bundle for /api routes
const html = (await req('/')).text || '';
const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]);
console.log('\nscripts:', scripts.join(', ') || '(none inline SPA?)');
const apiRoutes = new Set();
for (const s of scripts) {
  const p = s.startsWith('http') ? s : s.startsWith('/') ? s : `/${s}`;
  const r = await req(p, {}, 15000);
  const body = r.text || '';
  for (const m of body.matchAll(/["'`](\/api\/[A-Za-z0-9_:./-]+)["'`]/g)) apiRoutes.add(m[1]);
  console.log(`  ${p} -> ${r.status} ${body.length} chars`);
}
console.log('\n== /api routes found in client bundle ==');
console.log([...apiRoutes].sort().join('\n'));

// 2) try likely hook/account endpoints with auth
const candidates = [
  ['GET', '/api/runtime'],
  ['GET', '/api/status'],
  ['GET', '/api/accounts'],
  ['GET', '/api/hook'],
  ['GET', '/api/hooks'],
  ['GET', '/api/hook/status'],
  ['GET', '/api/hook/processes'],
  ['GET', '/api/processes'],
  ['GET', '/api/qq/processes'],
  ['GET', '/api/instance'],
  ['GET', '/api/system'],
];
console.log('\n== authenticated endpoint probes ==');
for (const [method, path] of candidates) {
  const r = await req(path, { method, headers: auth });
  const out = r.status === 0 ? `ERR ${r.error}` : `HTTP ${r.status} ${(r.text || '').slice(0, 400)}`;
  console.log(`${method} ${path} -> ${out}`);
}
