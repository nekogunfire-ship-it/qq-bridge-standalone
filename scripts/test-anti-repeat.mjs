// 防"AI 把同一件事回两遍"的接线自检（2026-09-27）。
//
// 事故形态（群 200000001 实测）：管理员 @ 问"你不是多模态吗"，AI 在 00:26 正常回了两条；
// 之后的回合里它反复 qq_wait_for_messages 把 12 轮工具预算打满 → 收尾请求结束本轮 →
// 因为没设唤醒条件，护栏②投递【提醒】开了**新的一轮对话** → 提醒回合里它一读未读，
// 那条早回过的 @ 还在未读里（**发消息不清未读**），而它的上下文里没有任何"我已经回过"的证据
// （direct 的历史只存 assistant 最终文本，而工具发言时那是空串）→ 00:32 又回了一遍。
//
// 三处修复各自守一件事：
//   ① prompt：唤醒/提醒 prompt 必须带上【你最近发过的消息】；
//   ② 硬护栏：收尾提醒回合按回合禁用发送类工具（且**不能**动 provider 全局 exclude）；
//   ③ 判据：未读接口要给"上次发言之前就到的消息"打 repliedBefore 标记。
//
// 静态检查守"接线别被重构删掉"，另外用真的 McpToolProvider 跑一遍按回合排除的行为。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpToolProvider } from '../src/agent-runtime/mcp-tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const TOOLS = fs.readFileSync(path.join(ROOT, 'src', 'agent-runtime', 'mcp-tools.js'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── ① prompt 里必须有【你最近发过的消息】 ────────────────────────────────
check('定义了 formatRecentSelfV2（自己说过的话的唯一来源）',
  /function formatRecentSelfV2\(st, limit = 3\)/.test(SRC));
check('唤醒 prompt 拼进了 selfLine', /\+ triggerLine \+ selfLine \+ wakeLine/.test(SRC));
check('收尾提醒 prompt 也拼进了 selfLine',
  /function buildWakeReminderPromptV2[\s\S]{0,1200}const selfLine = formatRecentSelfV2\(st\)/.test(SRC));
check('提醒文案说清"这不是新消息"', /这只是一次收尾提醒，\*\*不是新消息\*\*/.test(SRC));
check('提醒文案说清"本回合不给发送类工具"', /不提供发送类工具/.test(SRC));
check('时间格式只有一个实现（fmtClockOf），不再各写一份',
  (SRC.match(/const fmtClock = \(t\) =>/g) ?? []).length === 0 && /function fmtClockOf\(t\)/.test(SRC));

// ── ② 收尾提醒回合按回合禁发送类工具 ─────────────────────────────────────
check('护栏②投递提醒时带 noSend 标记',
  /deliverPrompt\(key, buildWakeReminderPromptV2\(key\), \{ noSend: true \}\)/.test(SRC));
check('deliverPromptNow 用 extraExclude 实现（不是 setExclude）',
  /listOpenAiTools\(noSendTurn \? \{ extraExclude: DIRECT_SEND_TOOLS \} : \{\}\)/.test(SRC));
check('工具执行层还有第二道保险（模型硬调也拒绝）',
  /if \(noSendTurn && DIRECT_SEND_TOOL_SET\.has\(name\)\)/.test(SRC));
check('McpToolProvider.listOpenAiTools 支持 extraExclude 参数',
  /listOpenAiTools\(opts = \{\}\)/.test(TOOLS) && /_baseOpenAiTools\(\)/.test(TOOLS));

// ── ③ 未读接口要标出"上次发言之前就到的"消息 ─────────────────────────────
check('未读接口给旧消息打 repliedBefore 标记',
  /repliedBefore: true/.test(SRC) && /repliedHint:/.test(SRC));
check('未读接口一并给出 lastAiReplyAt 与说明', /lastAiReplyAt: lastReplyAt \|\| null/.test(SRC));

// ── ④ D：等待工具要记"请求多久 vs 实等多久"（排查反复短等待靠它） ──────────
check('等待结束时有参数/结果日志',
  /qq_wait_for_messages 结束：请求 timeoutMs=\$\{timeoutMs\} quietMs=\$\{quietMs\}/.test(SRC));

// ── ⑤ 回归：superseded / preSleepWaitSatisfied 必须在 finishWait() **之前**求值 ──
// finishWait() 会把本次等待从 activeWaits 里删掉，删完再问"我是不是被接管了"永远得 true：
// 于是响应里 superseded 恒 true、preSleepWaitSatisfied 恒 false —— 而这俩正是 AI 判断
// "收尾还是再等一轮"的依据，害它把工具轮数耗光（2026-09-27 线上日志实锤）。
const supersededAt = SRC.indexOf('const supersededNow = isSuperseded();');
const bookkeepingAt = SRC.indexOf('const book = preSleepBookkeeping({', supersededAt);
const finishWaitAt = SRC.indexOf('finishWait();', bookkeepingAt);
check('superseded 在 finishWait() 之前取值（否则恒为 true）',
  supersededAt >= 0 && bookkeepingAt > supersededAt && finishWaitAt > bookkeepingAt
  && /superseded: supersededNow,/.test(SRC)
  && /preSleepWaitSatisfied: book\.satisfiedNow,/.test(SRC));
check('两处都不再直接调 isSuperseded() 写响应',
  !/superseded: isSuperseded\(\),/.test(SRC) && !/preSleepWaitSatisfied: [^,]*isSuperseded\(\),/.test(SRC));

// ── 行为测试：按回合排除真的只影响这一次调用 ─────────────────────────────
const provider = new McpToolProvider({ root: ROOT });
const fakeTools = ['qq_send_message', 'qq_reply', 'qq_send_sticker', 'qq_wait_for_messages', 'qq_mark_read', 'qq_set_wake_config'];
provider.byName = new Map(fakeTools.map((n) => [n, { client: null, serverName: 'fake', rawName: n, def: { name: n, description: '', inputSchema: { type: 'object', properties: {} } } }]));

const all = provider.listOpenAiTools();
const names = (list) => list.map((t) => t.function.name);
check('不带 extraExclude 时返回全部工具', names(all).length === fakeTools.length, names(all).join(','));
check('不带 extraExclude 时返回的是缓存引用', provider.listOpenAiTools() === all);
const trimmed = provider.listOpenAiTools({ extraExclude: ['qq_send_message', 'qq_reply', 'qq_send_sticker'] });
check('extraExclude 生效：发送类工具被拿掉',
  !names(trimmed).some((n) => ['qq_send_message', 'qq_reply', 'qq_send_sticker'].includes(n)), names(trimmed).join(','));
check('extraExclude 不误伤非发送类工具',
  names(trimmed).includes('qq_wait_for_messages') && names(trimmed).includes('qq_mark_read') && names(trimmed).includes('qq_set_wake_config'));
check('extraExclude 是**按回合**的：不污染下一次调用', names(provider.listOpenAiTools()).length === fakeTools.length);
check('extraExclude 不写进全局 exclude（并发会话不受影响）', provider.exclude.size === 0);

console.log('');
console.log(failures === 0 ? '=== 防重复回复接线自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
