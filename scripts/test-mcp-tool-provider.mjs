// direct 运行时的工具层（McpToolProvider）自检。
//
// 它做的事：把仓库现有的 38 个 MCP 工具**当子进程拉起来**，转成 OpenAI function-calling 格式，
// 并代为调用。这样 direct 模式不必手写工具 schema（会与 MCP 定义漂移）。
//
// 这里打**真实的 MCP server**（不是 mock）—— 因为要验的正是"这些 server 能不能被我们拉起、
// 工具定义能不能转、调用能不能通"。其中只读工具（qq_status）正常调；写类工具一律不碰。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { McpToolProvider, planToolCallTimeout } from '../src/agent-runtime/mcp-tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const logs = [];
const provider = new McpToolProvider({ root: ROOT, log: (m) => logs.push(m) });

try {
  const snap = await provider.start();
  console.log(`=== 拉起 MCP server：${snap.servers} 个，工具 ${snap.tools} 个 ===`);
  logs.forEach((l) => console.log(`  ${l}`));
  console.log('');

  check('至少拉起 1 个 MCP server', snap.servers >= 1, `${snap.servers} 个`);
  check('工具总数 > 20（复用全套，而不是手写几个）', snap.tools > 20, `${snap.tools} 个`);
  check('无启动失败的 server', snap.failed.length === 0, snap.failed.join('; ') || '(无)');

  // ── 格式转换 ──────────────────────────────────────────────────────────────
  const openAi = provider.listOpenAiTools();
  check('listOpenAiTools 返回全部工具', openAi.length === snap.tools, `${openAi.length}/${snap.tools}`);
  check('每条都是 {type:"function", function:{name,description,parameters}}',
    openAi.every((t) => t.type === 'function' && t.function?.name && typeof t.function.description === 'string'
      && t.function.parameters?.type === 'object'));
  check('工具名符合 OpenAI 的命名约束（^[a-zA-Z0-9_-]{1,64}$）',
    openAi.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name)),
    openAi.filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name)).map((t) => t.function.name).join(', ') || '全部合格');
  check('工具名无重复（重复会让模型调到另一个工具）',
    new Set(openAi.map((t) => t.function.name)).size === openAi.length);
  check('缓存生效（第二次调用返回同一引用）', provider.listOpenAiTools() === openAi);

  // 关键几个工具必须在（它们是"机器人的手"）
  for (const must of ['qq_send_message', 'qq_get_recent_messages', 'qq_draw_image', 'qq_send_image', 'qq_mark_read']) {
    check(`核心工具存在：${must}`, provider.has(must));
  }

  // ── 调用：只读工具 ────────────────────────────────────────────────────────
  // qq_status 会去问 SnowLuma。SnowLuma 可能没开 —— 两种结果都接受，但**形状必须正确**：
  // 要么 ok:true 带文本，要么 ok:false 带可读错误（不能抛、不能返回空）。
  const st = await provider.callTool('qq_status', {});
  check('调用只读工具返回结构化结果（ok/text 或 error）',
    typeof st.ok === 'boolean' && (typeof st.text === 'string' || typeof st.error === 'string'),
    st.ok ? String(st.text).slice(0, 60) : String(st.error).slice(0, 60));
  check('调用结果里报告了图片块数量（便于如实告知而非静默丢弃）',
    typeof st.images === 'number', String(st.images));

  // ── 调用：不存在的工具 ────────────────────────────────────────────────────
  const bad = await provider.callTool('qq_不存在的工具', {});
  check('调用未知工具返回可读错误而不是抛异常',
    bad.ok === false && /未知工具/.test(bad.error), bad.error);

  // ── 超时策略（2026-09-27 事故回归）────────────────────────────────────────
  // 事故：callTool 没给 SDK 传 timeout → SDK 默认 60 秒 → 合法等 300 秒的
  // qq_wait_for_messages 每次都被掐成 `MCP error -32001: Request timed out`
  // （实测 75 次"被新等待接管"、29 次撞满工具轮数上限）。这里把策略**钉死**。
  console.log('\n=== 超时策略 ===');
  const planWait = planToolCallTimeout('qq_wait_for_messages', { timeoutMs: 300000, quietMs: 10000 });
  check('wait 工具：超时按“请求等待 + 静默 + 余量”算，而不是 60 秒',
    planWait.timeoutMs === 300000 + 10000 + 20000, `${planWait.timeoutMs}ms`);
  check('wait 工具：不传 quietMs 也留出最小静默窗口',
    planToolCallTimeout('qq_wait_for_messages', { timeoutMs: 300000 }).timeoutMs === 330000);
  check('普通工具：仍是默认 60 秒（长轮询不该拖累其它工具）',
    planToolCallTimeout('qq_status', {}).timeoutMs === 60000,
    `${planToolCallTimeout('qq_status', {}).timeoutMs}ms`);
  const over = planToolCallTimeout('qq_wait_for_messages', { timeoutMs: 600000 }, { maxMs: 570000 });
  check('★ 要得超过整轮预算：**判定为不该发** 并给出可用的 timeoutMs',
    over.refused === true && over.suggestedTimeoutMs === 540000 && /改小到 540000/.test(over.reason),
    over.reason);
  check('★ 上限内则照发（570 秒上限下 540 秒的等待正好塞得进）',
    planToolCallTimeout('qq_wait_for_messages', { timeoutMs: 540000 }, { maxMs: 570000 }).timeoutMs === 570000);

  // 行为验证（不是读源码）：给一个假 client，看**实际传下去**的 options 是什么
  const fakeCalls = [];
  const fakeClient = {
    callTool: async (params, schema, options) => {
      fakeCalls.push({ name: params?.name, args: params?.arguments, options });
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    }
  };
  const entry = { client: fakeClient, serverName: 'fake', rawName: 'qq_wait_for_messages', def: { name: 'qq_wait_for_messages' } };
  provider.byName.set('qq_wait_for_messages', entry);
  const waitOut = await provider.callTool('qq_wait_for_messages', { timeoutMs: 300000, quietMs: 10000 });
  check('★ 用假 client 证明 timeout 真的传给了 SDK（>= 300 秒，不再是 60 秒）',
    waitOut.ok === true && fakeCalls[0]?.options?.timeout >= 300000,
    `传下去的是 ${fakeCalls[0]?.options?.timeout}ms`);
  check('参数原样转发（key/quietMs 等没被动过）',
    fakeCalls[0]?.args?.timeoutMs === 300000 && fakeCalls[0]?.args?.quietMs === 10000);

  // 超上限的请求：**不该发出去**（以前发出去只会换来一句 -32001，模型不知道该改什么）
  const strict = new McpToolProvider({ root: ROOT, maxCallMs: 570000 });
  const strictCalls = [];
  strict.byName.set('qq_wait_for_messages', {
    client: { callTool: async (p, s, o) => { strictCalls.push(o); return { content: [] }; } },
    serverName: 'fake', rawName: 'qq_wait_for_messages', def: { name: 'qq_wait_for_messages' }
  });
  const refused = await strict.callTool('qq_wait_for_messages', { timeoutMs: 600000 });
  check('★ 超上限的等待：不发请求 + 报错里带可执行的改法',
    refused.ok === false && strictCalls.length === 0 && /改小到 540000/.test(refused.error),
    refused.error);

  // 桥接必须把"整轮预算 − 30 秒"传进来，否则上限会退回 725 秒（会撞整轮超时）
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('bridge.js 给 McpToolProvider 传了 maxCallMs',
    /new McpToolProvider\(\{[^}]*maxCallMs/.test(bridgeSrc));
  check('bridge.js 的上限按整轮预算算（turnTimeoutMs − 30 秒）',
    /turnBudgetMs\s*-\s*30_000/.test(bridgeSrc));

  // ── close 之后不留子进程 ──────────────────────────────────────────────────
  await provider.close();
  check('close 后工具索引被清空', provider.listOpenAiTools().length === 0);
  check('close 后 has() 一律 false', provider.has('qq_status') === false);

  // 子进程是否真的退了：给它们一点时间，然后看还有没有指向 mcp-*.js 的 node 进程
  await new Promise((r) => setTimeout(r, 500));
  const { spawnSync } = await import('node:child_process');
  const q = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*mcp-snowluma-safe*' }).Count"
  ], { encoding: 'utf8', windowsHide: true });
  const leftovers = Number(String(q.stdout ?? '0').trim()) || 0;
  // 注意：DSH 自己也会拉起同名的 MCP server，所以"还有在跑的"不代表是我们泄漏的。
  // 因此这里只做提示，不作为失败判据 —— 属于"诚实标注不确定性"而不是假装确定。
  console.log(`  （提示：当前系统里还有 ${leftovers} 个 mcp-snowluma-safe 进程；DSH 也会拉起同名 server，无法凭此断定泄漏）`);
} catch (error) {
  console.error(`❌ 未捕获错误：${error?.stack ?? error}`);
  failures += 1;
} finally {
  try { await provider.close(); } catch { /* 忽略 */ }
}

console.log('');
console.log(failures === 0 ? '=== MCP 工具层自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
