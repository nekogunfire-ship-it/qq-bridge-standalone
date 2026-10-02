// Read-only probe: which SnowLuma WebUI instances are alive, and is the QQ hook loaded?
// Usage: node tools/snowluma-startup-probe.mjs
const PASSWORD = process.argv[2] || 'sl-rmxPS25t7kCZ-A7';
const PORTS = [5099, 5100, 5101, 5102];
const HOOK_PORTS = [3000, 3001];

async function tryFetch(url, opts = {}, ms = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    return { ok: true, status: r.status, headers: r.headers, text };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

console.log('== OneBot ports ==');
for (const p of HOOK_PORTS) {
  const r = await tryFetch(`http://127.0.0.1:${p}/get_login_info`, {}, 2500);
  console.log(`  :${p} -> ${r.ok ? `HTTP ${r.status} ${r.text.slice(0, 200)}` : `DOWN (${r.error})`}`);
}

for (const port of PORTS) {
  console.log(`\n== WebUI :${port} ==`);
  const home = await tryFetch(`http://127.0.0.1:${port}/`, {}, 3000);
  if (!home.ok) {
    console.log(`  DOWN (${home.error})`);
    continue;
  }
  console.log(`  GET / -> HTTP ${home.status}, ${home.text.length} chars`);
  const setCookie = home.headers.get('set-cookie');
  if (setCookie) console.log(`  set-cookie: ${setCookie.slice(0, 80)}`);

  for (const path of ['/api/status', '/api/runtime', '/api/state', '/api/hook/status', '/api/accounts']) {
    const r = await tryFetch(`http://127.0.0.1:${port}${path}`, {}, 2500);
    if (r.ok) {
      console.log(`  GET ${path} -> HTTP ${r.status} ${r.status === 404 ? '' : r.text.slice(0, 300)}`);
    } else {
      console.log(`  GET ${path} -> ERR ${r.error}`);
    }
  }

  const login = await tryFetch(
    `http://127.0.0.1:${port}/api/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    },
    4000,
  );
  console.log(`  POST /api/login -> ${login.ok ? `HTTP ${login.status} ${login.text.slice(0, 200)}` : `ERR ${login.error}`}`);
  if (login.ok) {
    const sc = login.headers.get('set-cookie');
    if (sc) console.log(`  login set-cookie: ${sc.slice(0, 120)}`);
  }
}
