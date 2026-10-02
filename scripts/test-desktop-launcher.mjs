// launcher 封装的**生命周期回归测试**。
//
// 专治一个复发过的坑：用管道 stdio 抓 launcher 的输出时，launcher 内部用
// Start-Process 拉起的常驻进程会继承管道句柄，管道永不 EOF → node 的 'close'
// 不触发 → 报「launcher 超时（90s）」，而实际上操作早就成功了
// （实测：时间线报失败 91.8s，但桥接 PID 已变、日志有新的「桥接已启动」）。
//
// 因此本测试的核心断言是：**生命周期动作必须在远小于超时的时间内返回**。
// 若有人改回管道实现，这里会立刻变红。
//
// 注意：本测试会真的启动桥接（stop 掉再启回来），仅用于开发环境。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launcherStatus,
  runLauncher,
  launcherRestartBridgeOnly
} from '../desktop/lib/launcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const t0 = Date.now();
const st = await launcherStatus(ROOT);
const statusMs = Date.now() - t0;
check('launcherStatus 能取到结果', st.ok, `exit=${st.exitCode}`);
check('launcherStatus 返回 JSON payload', st.payload != null,
  st.payload ? Object.keys(st.payload).slice(0, 6).join(',') : 'null');
check('launcherStatus 在 30 秒内返回', statusMs < 30_000, `${(statusMs / 1000).toFixed(1)}s`);

// 关键回归：只重启桥接，必须在 60 秒内返回（实测正常约 10~15 秒）。
// 若退化成管道实现，这里会等到 120 秒超时后失败。
const t1 = Date.now();
const restart = await launcherRestartBridgeOnly(ROOT);
const restartMs = Date.now() - t1;
check('restartBridgeOnly 成功返回', restart.ok,
  restart.ok ? '' : `error=${restart.error ?? '-'}`);
check('restartBridgeOnly 在 60 秒内返回（管道句柄回归检查）', restartMs < 60_000,
  `实测 ${(restartMs / 1000).toFixed(1)}s`);
check('restartBridgeOnly 未走超时分支', restart.timedOut !== true);
check('restartBridgeOnly 记录了分步耗时',
  Array.isArray(restart.steps) && restart.steps.length === 2,
  (restart.steps ?? []).map((s) => `${s.step}=${(s.ms / 1000).toFixed(1)}s`).join(' '));

// 重启后桥接应该又起来了。
//
// ⚠️ 这里有个"假失败"陷阱：launcher 判定 running 靠的是**进程枚举**
// （Get-CimInstance Win32_Process 匹配命令行），而桥接是**提权运行**的 ——
// 从非提权上下文枚举不到它的命令行，于是 running 会被误判成 false。
// 所以：检测到"枚举不到任何服务进程"时按 SKIP 处理，而不是判失败。
// 判据：端口在监听（TcpClient 探测，不受权限影响）但 launcher 说没在跑。
const after = await launcherStatus(ROOT);
const launcherSaysUp = after.payload?.services?.bridge?.running === true
  || after.payload?.health === 'healthy';

async function portListening(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(1200);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}
const portUp = await portListening(3100);

if (launcherSaysUp) {
  check('重启后桥接处于运行状态', true,
    `allRunning=${after.payload?.allRunning} health=${after.payload?.health}`);
} else if (portUp) {
  console.log('SKIP 重启后桥接处于运行状态 — 端口 3100 在监听，但 launcher 枚举不到进程');
  console.log('     （桥接提权运行，非提权上下文看不到它的命令行；这是权限限制，不是故障）');
} else {
  check('重启后桥接处于运行状态', false,
    `端口未监听且 launcher 说没在跑：allRunning=${after.payload?.allRunning} health=${after.payload?.health}`);
}

// 结果文件不应残留（readOutFile 读完即删）
const leftovers = (await import('node:fs')).readdirSync(path.join(ROOT, 'state'))
  .filter((f) => f.startsWith('launcher-out-'));
check('launcher 结果文件未残留', leftovers.length === 0,
  leftovers.length ? leftovers.join(', ') : '干净');

// 顺带验证 status 的 payload 形状没变（UI 依赖它）
check('payload 含 services.bridge', Boolean(after.payload?.services?.bridge));

console.log('');
console.log(failures === 0 ? '=== launcher 生命周期回归测试通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
