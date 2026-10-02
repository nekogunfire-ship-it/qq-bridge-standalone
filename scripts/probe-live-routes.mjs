// 探测运行中的旧桥接进程里哪些 socialV2 路由存在。
// 判定：返回业务错误码（400/403）= 路由存在；返回 404 = 路由未注册（旧代码）。
const B = 'http://127.0.0.1:3100';
const fs = await import('node:fs');
const path = await import('node:path');

const tokenFile = 'C:/Users/ExampleUser/Documents/deepseek-harness/\u9ed8\u8ba4\u5de5\u4f5c\u533a/qq-bridge/state/console-token';
let token = '';
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { console.log('读 token 失败:', e.message); }

const routes = [
  ['/api/socialV2/send-image', { key: 'group:0', path: '' }],
  ['/api/socialV2/send-message', { key: 'group:0', messages: [''] }],
  ['/api/socialV2/send-sticker', { key: 'group:0', stickerId: '' }],
  ['/api/socialV2/check-send', { key: 'group:0' }],
  ['/api/socialV2/sticker-list', null],
  ['/api/socialV2/__bogus__', {}]
];

for (const [p, body] of routes) {
  const init = {
    method: body === null ? 'GET' : 'POST',
    headers: { 'x-console-token': token, ...(body === null ? {} : { 'content-type': 'application/json' }) },
    signal: AbortSignal.timeout(8000)
  };
  if (body !== null) init.body = JSON.stringify(body);
  try {
    const r = await fetch(B + p, init);
    let t = ''; try { t = await r.text(); } catch {}
    let err = '';
    try { err = JSON.parse(t)?.error ?? ''; } catch {}
    const verdict = r.status === 404 ? '路由未注册(旧代码)' : '路由存在';
    console.log(`${String(r.status).padEnd(4)} ${verdict.padEnd(20)} ${p}${err ? '  | ' + err.slice(0, 60) : ''}`);
  } catch (e) {
    console.log(`ERR  ${p} -> ${e.message}`);
  }
}
