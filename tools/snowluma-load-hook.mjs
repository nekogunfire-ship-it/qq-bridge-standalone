// Attach the SnowLuma hook to the running QQ process via the WebUI API, then verify.
// Usage: node tools/snowluma-load-hook.mjs [port] [password] [pid]
const PORT = Number(process.argv[2] || 5099);
const PASSWORD = process.argv[3] || 'sl-rmxPS25t7kCZ-A7';
const WANT_PID = process.argv[4] ? Number(process.argv[4]) : null;
const BASE = `http://127.0.0.1:${PORT}`;

async function req(path, opts = {}, ms = 30000) {
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

async function snapshot(label) {
  const procs = await req('/api/processes', { headers: auth });
  const conns = await req('/api/connections', { headers: auth });
  const qq = await req('/api/qq-list', { headers: auth });
  console.log(`\n== ${label} ==`);
  console.log('processes:', JSON.stringify(procs.json?.list ?? procs.text ?? procs.error));
  console.log('connections:', JSON.stringify(conns.json?.list ?? conns.text ?? conns.error));
  console.log('qq-list:', JSON.stringify(qq.json?.list ?? qq.text ?? qq.error));
  return procs.json?.list ?? [];
}

const before = await snapshot('before load');
const target = WANT_PID ?? before.find((p) => !p.injected)?.pid ?? before[0]?.pid;
if (!target) {
  console.log('\nno QQ process found - is QQ running?');
  process.exit(2);
}
console.log(`\n-> POST /api/processes/${target}/load`);
const load = await req(`/api/processes/${target}/load`, { method: 'POST', headers: auth }, 60000);
console.log(`load -> HTTP ${load.status} ${(load.text || load.error || '').slice(0, 600)}`);

for (let i = 1; i <= 6; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const list = await snapshot(`after load +${i * 3}s`);
  if (list.some((p) => p.injected && (p.status === 'online' || p.loggedIn))) break;
}

const info = await req(`/api/processes/${target}/probe-login`, { headers: auth }, 15000);
console.log('\nprobe-login:', JSON.stringify(info.json ?? info.text ?? info.error));
