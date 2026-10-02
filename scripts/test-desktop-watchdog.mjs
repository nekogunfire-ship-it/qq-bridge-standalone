// 看门狗自检：守住三个容易写错的边界 —— 冷却、正在执行动作、设置里关掉。
//
// 这三条都是"错了也不会报错、但会让功能形同虚设或反过来骚扰用户"的类型：
//   · 没有冷却 → 服务起不来时每 30 秒重试一次，日志与启动器被打爆；
//   · 不看 busy → 用户正在点「重启全部」时看门狗插一脚，两个动作打架；
//   · 不看开关 → 用户在设置里关掉了它却还在后台拉起服务。
import { decideWatchdog, findDownServices, isScriptWatchdogAlive, WATCHDOG_SERVICES } from '../desktop/lib/watchdog.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const ON = { watchdogEnabled: true, watchdogCooldownSeconds: 180 };
const downBridge = [{ key: 'bridge', label: 'QQ 桥接', port: 3100 }];
const none = [];

// 1) 都在线 → 不动作
let v = decideWatchdog({ down: none, settings: ON });
check('服务都在线时不拉起', v.action === 'skip', v.reason);

// 2) 有掉线 + 启用 + 无冷却 → 拉起
v = decideWatchdog({ down: downBridge, settings: ON, lastRunAt: 0, now: 1_000_000 });
check('检测到掉线且未冷却时拉起', v.action === 'start', v.reason);
check('返回掉线的服务列表（供日志用）', v.down.length === 1 && v.down[0].key === 'bridge');

// 3) 冷却期内 → 不重复拉起
v = decideWatchdog({ down: downBridge, settings: ON, lastRunAt: 1_000_000, now: 1_000_000 + 60_000 });
check('冷却期内不重复拉起', v.action === 'skip' && /冷却中/.test(v.reason), v.reason);
check('冷却提示里带上剩余秒数', /还需 120s/.test(v.reason), v.reason);

// 4) 冷却刚过 → 可以拉起
v = decideWatchdog({ down: downBridge, settings: ON, lastRunAt: 1_000_000, now: 1_000_000 + 181_000 });
check('冷却结束后可以再次拉起', v.action === 'start', v.reason);

// 5) 正在执行其他动作 → 不插手
v = decideWatchdog({ down: downBridge, settings: ON, busy: 'restartAll', now: 1_000_000, lastRunAt: 0 });
check('正在执行其他动作时不插手', v.action === 'skip' && /不插手/.test(v.reason), v.reason);

// 6) 设置里关掉 → 不动作
v = decideWatchdog({ down: downBridge, settings: { ...ON, watchdogEnabled: false }, now: 1_000_000, lastRunAt: 0 });
check('看门狗关闭时不拉起', v.action === 'skip' && /关闭/.test(v.reason), v.reason);

// 7) 应用正在退出 → 不动作（否则退出过程中还会去启动服务）
v = decideWatchdog({ down: downBridge, settings: ON, quitting: true, now: 1_000_000, lastRunAt: 0 });
check('应用退出时不拉起', v.action === 'skip' && /退出/.test(v.reason), v.reason);

// 8) 冷却时间被设成异常值（0 / 负数 / 非数字）时不应变成"每 30 秒重试"
const weird = [0, -5, 'abc', null];
let allFloor = true;
for (const c of weird) {
  const r = decideWatchdog({ down: downBridge, settings: { watchdogEnabled: true, watchdogCooldownSeconds: c }, lastRunAt: 1_000_000, now: 1_000_050 });
  if (r.action !== 'skip') allFloor = false;
}
check('冷却时间异常时仍保底（不会变成高频重试）', allFloor, `测试值 ${weird.join(', ')}`);

// 9) 脚本级看门狗（bridge-watchdog.ps1）在跑时 → 一律礼让
//    它比本看门狗完善（三态 ok/hung/dead、hung 时 POST /api/restart、限流 6 次/小时），
//    两个看门狗同时重启同一服务会把重启次数翻倍，所以有它时本看门狗不插手。
v = decideWatchdog({ down: downBridge, settings: ON, now: 1_000_000, lastRunAt: 0, scriptWatchdogAlive: true });
check('脚本看门狗在跑时礼让（不重复重启）',
  v.action === 'skip' && /礼让/.test(v.reason), v.reason);
check('礼让优先于冷却判断（即便未冷却也不动）',
  decideWatchdog({ down: downBridge, settings: ON, now: 9_999_999, lastRunAt: 0, scriptWatchdogAlive: true }).action === 'skip');
check('脚本看门狗不在时才兜底拉起',
  decideWatchdog({ down: downBridge, settings: ON, now: 1_000_000, lastRunAt: 0, scriptWatchdogAlive: false }).action === 'start');

// 10) isScriptWatchdogAlive：pid 文件缺失/内容非法/进程不存在 都应返回 false（不抛错）
import fs from 'node:fs';
import os from 'node:os';
import path2 from 'node:path';
const tmpPid = path2.join(os.tmpdir(), `qb-watchdog-pid-${process.pid}`);
check('pid 文件不存在 → false', isScriptWatchdogAlive('.', fs, tmpPid) === false);
fs.writeFileSync(tmpPid, 'not-a-number', 'utf8');
check('pid 文件内容非法 → false（不抛错）', isScriptWatchdogAlive('.', fs, tmpPid) === false);
fs.writeFileSync(tmpPid, '999999999', 'utf8');
check('pid 指向不存在的进程 → false', isScriptWatchdogAlive('.', fs, tmpPid) === false);
fs.writeFileSync(tmpPid, String(process.pid), 'utf8');
check('pid 指向真实进程（自己）→ true', isScriptWatchdogAlive('.', fs, tmpPid) === true);
try { fs.rmSync(tmpPid, { force: true }); } catch {}

// 11) 真实探测：当前环境下桥接大概率在线 —— 结果类型正确即可
const realDown = await findDownServices(WATCHDOG_SERVICES, 1200);
check('真实探测返回数组且元素含 key/label/port',
  Array.isArray(realDown) && realDown.every((d) => d.key && d.label && d.port),
  realDown.length ? `检测到掉线：${realDown.map((d) => d.label).join(', ')}` : '全部在线');

check('服务清单包含桥接与 SnowLuma',
  WATCHDOG_SERVICES.some((s) => s.port === 3100) && WATCHDOG_SERVICES.some((s) => s.port === 3000));

console.log('');
console.log(failures === 0 ? '=== 看门狗自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
