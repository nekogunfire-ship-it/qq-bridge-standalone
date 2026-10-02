// 二代“对面没说完 / 结束前等待”逻辑测试。
// 验证：
// 1. looksLikeUnfinished 能识别常见“话说一半”的结尾；
// 2. 已说完的句子不会被误判；
// 3. 配置允许 5~10 分钟的长等待（maxMs >= 600000）；
// 4. 提供了可用的催话短句。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksLikeUnfinished,
  UNFINISHED_PROMPT_REPLIES,
  END_ROUND_WAIT_MIN_MS,
  END_ROUND_WAIT_MAX_MS,
  preSleepBookkeeping
} from '../src/v2-wait.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failed = 1;
  }
}

// 1. 未说完特征
const unfinishedCases = [
  '你知道',
  '等一下',
  '我跟你讲',
  '但是',
  '所以说',
  '然后',
  '那个',
  '就是',
  '我想说',
  '对了',
  '等我',
  '等等',
  '我看看',
  '还有',
  '再说',
  '主要是',
  '回头说',
  '待会',
  '再说吧',
  '你听我说，'
];
for (const text of unfinishedCases) {
  assert(looksLikeUnfinished(text) === true, `未说完判定 true: ${JSON.stringify(text)}`);
}

// 2. 已说完/普通消息不应误判
const finishedCases = [
  '',
  '好的',
  '今天好累',
  'B站搜猫踩奶视频 解压一绝',
  '那去看跳伞第一视角视频',
  '你再说一遍试试',
  '？',
  '哦牛批',
  '这么刺激',
  '你说完了。'
];
for (const text of finishedCases) {
  assert(looksLikeUnfinished(text) === false, `已说完/普通判定 false: ${JSON.stringify(text)}`);
}

// 3. 配置允许长等待
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const maxMs = Number(cfg.socialV2?.wait?.maxMs) || 0;
  assert(maxMs >= END_ROUND_WAIT_MAX_MS, `wait.maxMs=${maxMs} >= 600000`);
} catch (error) {
  console.error('❌ 读取 config.json 失败:', error.message);
  failed = 1;
}

// 4. 催话短句
assert(Array.isArray(UNFINISHED_PROMPT_REPLIES) && UNFINISHED_PROMPT_REPLIES.length > 0, '提供催话短句');
assert(END_ROUND_WAIT_MIN_MS >= 5 * 60 * 1000 && END_ROUND_WAIT_MAX_MS >= END_ROUND_WAIT_MIN_MS, '结束前等待 5~10 分钟常量正确');

// 5. 沉睡前观察的记账（2026-09-27 事故回归）
// 事故：客户端 60 秒超时放弃、桥接的等待却跑满 300 秒并置位"已满足" ——
// 日志写「满足沉睡前观察」，模型手里是 `MCP error -32001`。**没人收的等待不算数**。
const WINDOW = 300000;
const deliveredFull = preSleepBookkeeping({
  delivered: true, arrived: false, quiet: false, waitedSinceLastNewMs: WINDOW,
  waitedMs: WINDOW, preSleepWaitMs: WINDOW, preSleepAttempt: true
});
assert(deliveredFull.satisfiedNow === true, '等满窗口且结果送得出去 → 记为已满足');
const undeliveredFull = preSleepBookkeeping({
  delivered: false, arrived: false, quiet: false, waitedSinceLastNewMs: WINDOW,
  waitedMs: WINDOW, preSleepWaitMs: WINDOW, preSleepAttempt: true
});
assert(undeliveredFull.satisfiedNow === false, '★ 等满窗口但结果没人收（客户端已放弃/被接管）→ 不置位');
assert(undeliveredFull.rawSatisfied === true, '★ 但原始判据仍如实返回（便于日志区分两种情况）');
const shortWait = preSleepBookkeeping({
  delivered: true, arrived: false, quiet: false, waitedSinceLastNewMs: 60000,
  waitedMs: 60000, preSleepWaitMs: WINDOW, preSleepAttempt: false
});
assert(shortWait.satisfiedNow === false && shortWait.rawSatisfied === false, '短等待（60 秒）不算满足沉睡前观察');
const arrivedThenQuiet = preSleepBookkeeping({
  delivered: true, arrived: true, quiet: true, waitedSinceLastNewMs: WINDOW,
  waitedMs: 40000, preSleepWaitMs: WINDOW, preSleepAttempt: true
});
assert(arrivedThenQuiet.satisfiedNow === true, '等到新消息、且最后一条之后安静满窗口 → 记为已满足');
const arrivedNotQuiet = preSleepBookkeeping({
  delivered: true, arrived: true, quiet: false, waitedSinceLastNewMs: 5000,
  waitedMs: 40000, preSleepWaitMs: WINDOW, preSleepAttempt: true
});
assert(arrivedNotQuiet.satisfiedNow === false && arrivedNotQuiet.observedNow === true,
  '等到新消息但还没安静够 → 只记“已观察”，不记“已满足”');
const arrivedObservedUndelivered = preSleepBookkeeping({
  delivered: false, arrived: true, quiet: false, waitedSinceLastNewMs: 5000,
  waitedMs: 40000, preSleepWaitMs: WINDOW, preSleepAttempt: true
});
assert(arrivedObservedUndelivered.observedNow === false, '★ 结果没人收时“已观察”也不该置位');

// 6. 桥接真的用了这个记账函数（否则上面的单测只是测了个没人用的函数）
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
assert(/preSleepBookkeeping\(/.test(bridgeSrc), 'bridge.js 调用了 preSleepBookkeeping');
assert(/delivered:\s*!aborted\s*&&\s*!supersededNow/.test(bridgeSrc),
  'bridge.js 把“结果送得出去”作为条件（!aborted && !superseded）');

// 7. 日志/活动流时间戳用本机时区（以前是 UTC，本地看差 8 小时）
assert(/function localStamp\(/.test(bridgeSrc), 'bridge.js 有 localStamp（本机时区）');
assert(!/toISOString\(\)\.slice\(11, 19\)/.test(bridgeSrc),
  '★ 日志/活动流不再用 toISOString（UTC）当时间戳');

if (failed) {
  console.error('\n❌ 测试失败');
  process.exit(1);
}
console.log('\n🎉 二代等待/结束回合逻辑测试通过');
