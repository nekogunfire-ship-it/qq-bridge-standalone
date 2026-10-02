// reserved2 两个护栏的**接线自检**。
//
// 背景：这两条护栏（无行动兜底 / 唤醒条件防遗忘）原先只写在 DSH 的 `turn/end` 分支里，
// 由 `session/event` 事件帧触发。direct 运行时没有那些帧 —— 如果不从 direct 路径也调一次，
// 护栏就会**静默失效**：「机器人悄悄哑掉」没有任何东西会发现（2026-09-24 事故的形态）。
//
// 为什么用静态检查而不是行为测试：护栏是桥接主函数闭包里的逻辑，靠 HTTP 触发一次真实唤醒
// 需要伪造 OneBot 事件流，成本远高于收益。这里守的是**最容易复发的那一类错误** ——
// 有人重构时把调用点删掉（功能表面还在，护栏不再被触发）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const fn of ['reserved2NoActionGuard', 'reserved2WakeConfigGuard']) {
  const defs = [...SRC.matchAll(new RegExp(`function ${fn}\\(`, 'g'))].length;
  // 调用点 = 出现次数 - 定义次数
  const total = [...SRC.matchAll(new RegExp(`${fn}\\(`, 'g'))].length;
  const calls = total - defs;
  check(`${fn} 只定义一次`, defs === 1, `${defs} 次`);
  check(`${fn} 有 2 个调用点（DSH 路径 + direct 路径）`, calls === 2, `${calls} 个调用点`);
}

// 两条路都要在**回合结束后**调用它，所以必须能分别认出来。
// ⚠️ 第一版我用 `if (directRuntime) {\n      // ── 按模式决定` 当锚点，缩进一变就失配 ——
//    改用**调用本身的特征**当判据（更稳，也不依赖周围注释）：
//      · DSH 路径传 sendSucceeded: sendToolSucceededSessions.has(frame.sessionId)
//      · direct 路径传 sendSucceeded: used.send
const endedBlockIdx = SRC.indexOf('if (ended) {');
check('能在 DSH 的 ended 分支里找到护栏调用',
  endedBlockIdx >= 0 && SRC.slice(endedBlockIdx, endedBlockIdx + 3000).includes('reserved2NoActionGuard('));
check('DSH 路径的护栏调用用的是 sendToolSucceededSessions',
  /reserved2NoActionGuard\(key, \{\s*sendSucceeded: sendToolSucceededSessions\.has\(frame\.sessionId\)/.test(SRC));
check('direct 路径的护栏调用用的是本回合的工具记录（used.send）',
  /reserved2NoActionGuard\(key, \{\s*sendSucceeded: used\.send/.test(SRC));
check('direct 路径把 turnStart 传成了本回合开始时间（否则 lastActionAt 判定失效）',
  /const directTurnStart = Date\.now\(\);/.test(SRC) && /turnStart: directTurnStart/.test(SRC));

// 护栏②必须在"静默投喂回合 continue"**之后**（那种回合不该触发提醒）
const silentContinueIdx = SRC.indexOf('摘要投喂 turn 结束，静默');
const guard2AfterSilentIdx = SRC.indexOf('reserved2WakeConfigGuard(key);', silentContinueIdx);
check('护栏②在"静默回合 continue"之后被调用（静默回合不触发提醒）',
  silentContinueIdx >= 0 && guard2AfterSilentIdx > silentContinueIdx);

// direct 路径也要遵守同一条：静默回合不调护栏②
check('direct 路径对静默回合跳过护栏②',
  /if \(!isSilentTurn\) reserved2WakeConfigGuard\(key\);/.test(SRC));

// 护栏内部必须**自己**判断模式，而不是靠调用方记得判断
// （否则 direct 路径在 chat 模式下会误改唤醒配置）
check('护栏①自己判断 currentMode !== "reserved2" 就返回',
  /function reserved2NoActionGuard[\s\S]{0,600}currentMode !== 'reserved2'/.test(SRC));

// 一个反直觉但关键的断言：护栏读的状态**不是 DSH 专有的**，
// 所以 direct 的工具调用（走同一批 HTTP 端点）也会置位。如果将来有人把
// lastActionAt / wakeConfigUpdatedKeys 的写入挪进事件帧处理里，护栏就会在 direct 下失效。
check('lastActionAt 由 HTTP 处理器维护（不是事件帧）',
  /st\.lastActionAt = Date\.now\(\)/.test(SRC) && /st\.lastActionAt = now/.test(SRC));
check('wakeConfigUpdatedKeys 由 HTTP 处理器置位',
  /wakeConfigUpdatedKeys\.add\(key\)/.test(SRC));
check('markReadCalledKeys 由 HTTP 处理器置位',
  /markReadCalledKeys\.add\(key\)/.test(SRC));

// 启动日志要说清护栏已接（否则用户无法从日志判断自己有没有保护）
check('启动日志声明两个护栏已接上',
  /reserved2 的两个护栏已接上/.test(SRC));

console.log('');
console.log(failures === 0 ? '=== reserved2 护栏接线自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
