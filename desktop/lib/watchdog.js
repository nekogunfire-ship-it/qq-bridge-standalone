// 看门狗：判断哪些关键服务掉线了，以及"这次该不该发起自动拉起"。
//
// 之所以把判定逻辑抽出来单独成模块：它埋在 main.mjs 里就没法单测，而这里恰恰有
// 三个容易写错的边界 —— 冷却时间、正在执行别的动作、以及设置里关掉了看门狗。
//
// 背景（为什么需要它）：实测到桥接会在 `SnowLuma 连接断开（code=1006）` 之后自己消失
// （进程退出、无崩溃日志），结果是机器人静默掉线、用户毫不知情。
import { probePort } from './health.js';

// 纳入看门狗的关键服务：这两个没了 = QQ 收不到消息或回不了话
export const WATCHDOG_SERVICES = [
  { key: 'bridge', label: 'QQ 桥接', port: 3100 },
  { key: 'snowluma', label: 'SnowLuma 网关', port: 3000 }
];

/** 探测哪些服务不在监听。返回掉线服务的数组（空数组 = 全部正常）。 */
export async function findDownServices(services = WATCHDOG_SERVICES, timeoutMs = 1500) {
  const down = [];
  for (const svc of services) {
    // 串行探测：并发探测在服务刚挂时容易互相干扰，而且这里对延迟不敏感
    // eslint-disable-next-line no-await-in-loop
    const up = await probePort('127.0.0.1', svc.port, timeoutMs);
    if (!up) down.push(svc);
  }
  return down;
}

/**
 * 依据设置与运行状态决定"要不要拉起"。
 * 返回 { action: 'start' | 'skip', reason, down }。
 * 纯判定，不做副作用 —— 便于测试。
 *
 * `scriptWatchdogAlive`：脚本级看门狗（state/slang-agent/bridge-watchdog.ps1）是否在跑。
 * 它比本看门狗完善得多（三态 ok/hung/dead、hung 时走 POST /api/restart 优雅重启、
 * 限流 MaxRestartsPerHour=6、状态变化写 bridge-watch.log）。因此**它在跑时本看门狗一律礼让**，
 * 避免两个看门狗同时重启同一服务、把重启次数翻倍。
 * 本看门狗只在"脚本看门狗没在跑"时兜底 —— 那才是最需要它的场景
 * （比如用户没登录、脚本看门狗被 -Stop 过、或进程崩了）。
 */
export function decideWatchdog({
  down,
  settings,
  now = Date.now(),
  lastRunAt = 0,
  busy = false,
  quitting = false,
  scriptWatchdogAlive = false
}) {
  if (quitting) return { action: 'skip', reason: '应用正在退出', down };
  if (!down.length) return { action: 'skip', reason: '服务都在线', down };
  if (!settings?.watchdogEnabled) return { action: 'skip', reason: '看门狗已在设置里关闭', down };
  if (scriptWatchdogAlive) {
    return { action: 'skip', reason: '脚本级看门狗在运行，礼让（它更精确：能识别 hung 状态）', down };
  }
  if (busy) return { action: 'skip', reason: `正在执行其他动作（${busy}），不插手`, down };

  const cooldownMs = Math.max(30, Number(settings.watchdogCooldownSeconds) || 180) * 1000;
  const elapsed = now - (lastRunAt || 0);
  if (elapsed < cooldownMs) {
    const left = Math.ceil((cooldownMs - elapsed) / 1000);
    return { action: 'skip', reason: `冷却中（还需 ${left}s）`, down };
  }
  return { action: 'start', reason: '检测到服务掉线且脚本看门狗不在，兜底拉起', down };
}

/**
 * 脚本级看门狗是否在运行：读它的 pid 文件并确认进程还活着。
 * 故意做成"读文件 + 判进程存在"，不依赖 CIM（在本机受限环境下 CIM 查询有时被拒）。
 */
export function isScriptWatchdogAlive(root, fsModule, pidFilePath = null) {
  try {
    const pidFile = pidFilePath ?? `${root}/state/slang-agent/bridge-watch.pid`;
    const pid = Number(String(fsModule.readFileSync(pidFile, 'utf8')).trim());
    if (!pid) return false;
    // signal 0 = 只探测进程是否存在，不真的发信号
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
