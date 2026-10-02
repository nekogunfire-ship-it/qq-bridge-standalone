// 三元状态判定：重启是否已经发生。
//   1) /api/socialV2/send-image 是否存在（桥接是否加载了新代码）
//   2) qq-activity.log 是否在推进（桥接是否在正常处理 QQ 消息）
//   3) 输出结论，供人/agent 判断下一步
const B = 'http://127.0.0.1:3100';
const fs = await import('node:fs');
const ROOT = 'C:/Users/ExampleUser/Documents/deepseek-harness/\u9ed8\u8ba4\u5de5\u4f5c\u533a/qq-bridge';

let token = '';
try { token = fs.readFileSync(`${ROOT}/state/console-token`, 'utf8').trim(); } catch {}

// 1) 新路由
let routeVerdict = '?';
try {
  const r = await fetch(`${B}/api/socialV2/send-image`, {
    method: 'POST',
    headers: { 'x-console-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'group:0', path: '' }),
    signal: AbortSignal.timeout(8000)
  });
  routeVerdict = r.status === 404 ? '未加载(旧代码)' : `已加载(HTTP ${r.status})`;
} catch (e) { routeVerdict = `探测失败: ${e.message}`; }

// 2) 消息处理活性
const logPath = `${ROOT}/state/qq-activity.log`;
const t1 = fs.statSync(logPath).mtimeMs;
await new Promise((r) => setTimeout(r, 12000));
const t2 = fs.statSync(logPath).mtimeMs;
const ageMin = ((Date.now() - t2) / 60000).toFixed(1);

// 3) DSH 端口是否变化（重启会换端口）
let dsh = '?';
try {
  const r = await fetch(`${B}/api/status`, { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(8000) });
  const o = await r.json();
  dsh = `dshReady=${o.dshReady} mode=${o.mode}`;
} catch (e) { dsh = `status 失败: ${e.message}`; }

console.log(`桥接新路由      : ${routeVerdict}`);
console.log(`活动日志最后写入: ${new Date(t2).toLocaleString('zh-CN')}（${ageMin} 分钟前）`);
console.log(`12 秒内是否推进 : ${t2 > t1 ? '是（正在处理消息）' : '否（未处理消息）'}`);
console.log(`DSH 侧          : ${dsh}`);
console.log('');
const restarted = routeVerdict.startsWith('已加载');
const alive = t2 > t1;
console.log(`结论: ${restarted ? '桥接已加载新代码' : '桥接仍是旧代码'}；${alive ? '消息处理正常' : '消息处理停滞'}`);
process.exit(restarted ? 0 : 1);
