// 防"AI 重复回复"的**端到端**验证（2026-09-27）。
//
// 复现的真实事故（群 200000001）：AI 回完一条消息后，回合里反复 qq_wait_for_messages 打满
// 12 轮工具预算 → 收尾请求结束本轮 → 因为没设置唤醒条件，护栏②投递【提醒】**开了一轮新对话** →
// 提醒回合里它一读未读，那条早回过的 @ 还在未读里（发消息不清未读），于是又答了一遍。
//
// 这个测试在**沙箱副本**里跑真桥接（不碰用户仓库与真实 QQ/DSH，做法见 test-bridge-direct-mode.mjs）：
//   ① 假 AI（mock-openai-server）第一轮调 qq_get_unread_messages，然后故意**不**设置唤醒条件；
//   ② 桥接的护栏②于是投递收尾提醒 —— 这就是出事的那一轮；
//   ③ 断言三件事：
//      · 唤醒/提醒 prompt 里都带【你最近发过的消息】（A：给它"我已经回过"的证据）
//      · 未读工具返回里，上次发言之前就到的消息带 repliedBefore（C：判据送到模型眼前）
//      · **提醒回合交给模型的工具表里没有任何发送类工具**（B：硬护栏）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockOpenAI } from './mock-openai-server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), `qb-anti-repeat-${process.pid}`);
const SRC = path.join(SANDBOX, 'app');
const GROUP = '100000001';
const KEY = `group:${GROUP}`;
const AGENT_TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';
const SELF_TEXT = '图我能看，视频画面我真拿不到，多模态也没用';
const INCOMING_TEXT = '@蓝色大肥鱼 你不是多模态吗';
const SEND_TOOLS = ['qq_send_message', 'qq_reply', 'qq_send_sticker', 'qq_send_poke'];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const EXCLUDE = new Set(['node_modules', 'state', 'archive', 'dist', '.git', '__pycache__']);
function copySource() {
  let n = 0;
  const walk = (rel) => {
    const abs = path.join(REPO, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name)) continue;
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const from = path.join(REPO, childRel);
      const to = path.join(SRC, childRel);
      if (e.isDirectory()) { fs.mkdirSync(to, { recursive: true }); walk(childRel); continue; }
      if (!e.isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      n += 1;
    }
  };
  fs.mkdirSync(SRC, { recursive: true });
  walk('');
  return n;
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}
async function waitPort(port, maxSec) {
  for (let i = 0; i < maxSec; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portOpen(port)) return true;
  }
  return false;
}
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 忽略 */ } }
}
/** 一条请求里最后一条 user 消息的文本（唤醒 prompt 就是它） */
function lastUserText(req) {
  const msgs = req?.body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const c = msgs[i]?.content;
    if (msgs[i]?.role !== 'user') continue;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.find((p) => p?.type === 'text')?.text;
      if (typeof t === 'string') return t;
    }
  }
  return '';
}
const toolNames = (req) => (req?.body?.tools ?? []).map((t) => t?.function?.name ?? '');

const mock = await startMockOpenAI({ reply: '（默认回复）' });
let bridge = null;
let logText = '';
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const copied = copySource();
  check('① 源码已复制到沙箱', copied > 100, `${copied} 个文件`);

  const npm = spawnSync('cmd.exe', ['/c', 'npm install --no-audit --no-fund'], { cwd: SRC, windowsHide: true, encoding: 'utf8' });
  check('② npm install 成功', npm.status === 0, `退出码 ${npm.status}`);
  if (npm.status !== 0) throw new Error(`沙箱 npm install 失败：${(npm.stderr || npm.stdout || '').slice(-600)}`);

  // ── ③ 沙箱配置：direct + reserved2，外部依赖全部指向死端口 ────────────────
  const consolePort = await freePort();
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
  cfg.ownerQQ = '10001';
  cfg.allow = { private: ['10001'], groups: [GROUP] };
  cfg.consolePort = consolePort;
  cfg.consoleToken = 'self-test-token-0123456789abcdef0123456789abcdef';
  cfg.comfy = { ...(cfg.comfy ?? {}), enabled: false };
  cfg.snowluma = { ...(cfg.snowluma ?? {}), wsUrl: 'ws://127.0.0.1:39999' };
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: 'http://127.0.0.1:39998' };
  cfg.runtime = { type: 'direct', baseUrl: mock.baseUrl, apiKey: 'sk-selftest', model: 'mock-model', maxTurns: 5 };
  fs.writeFileSync(path.join(SRC, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  fs.mkdirSync(path.join(SRC, 'state'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }, null, 2), 'utf8');

  // 种子状态：库里"已经回过"一条消息（未读里还躺着它 + 之后又来了 0 条）——这正是事故现场
  const tIncoming = Date.now() - 10 * 60 * 1000;
  const tReplied = Date.now() - 9 * 60 * 1000;
  const incoming = {
    seq: 1, messageId: '9001', sender: '各有各的月亮.', userId: '9001',
    text: INCOMING_TEXT, plain: INCOMING_TEXT, tail: INCOMING_TEXT,
    quoteTargetIsSelf: false, isOwner: false, ownerLabel: '', isSelf: false,
    media: [], hasMedia: false, forwardIds: [], hasForward: false, time: tIncoming
  };
  const selfMsg = {
    sender: '我', text: SELF_TEXT, plain: SELF_TEXT, quoteTargetIsSelf: false,
    isOwner: true, ownerLabel: '我', isSelf: true, time: tReplied
  };
  fs.writeFileSync(path.join(SRC, 'state', 'social-v2.json'), JSON.stringify({
    conversations: {
      [KEY]: {
        agentToken: AGENT_TOKEN,
        bootstrapSent: true,
        lastAiReplyAt: tReplied,
        lastActionAt: tReplied,
        lastIncomingAt: tIncoming,
        lastUnreadSeq: 1,
        unread: [incoming],
        recentMessages: [incoming, selfMsg]
      }
    }
  }, null, 2), 'utf8');
  check('③ 沙箱配置与种子状态已写好', true, `key=${KEY}`);

  // 假 AI 脚本：第 1 轮调未读工具（用真 token，能拿到真结果）→ 第 2 轮直接收尾且**不设置唤醒条件**
  mock.setSequence([
    { toolCalls: [{ name: 'qq_get_unread_messages', arguments: { key: KEY, token: AGENT_TOKEN, limit: 30 } }] },
    { reply: '（本轮故意不设置唤醒条件）' },
    { reply: '（提醒回合的收尾）' }
  ]);

  bridge = spawn(process.execPath, ['src/bridge.js'], { cwd: SRC, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.stdout.on('data', (d) => { logText += d.toString('utf8'); });
  bridge.stderr.on('data', (d) => { logText += d.toString('utf8'); });
  const up = await waitPort(consolePort, 25);
  check('④ 沙箱桥接已起来（控制台端口可连）', up, `端口 ${consolePort}`);
  check('④ 模式是 reserved2', /模式取自 state\/mode\.json：reserved2/.test(logText));

  // ── ⑤ 手动唤醒：这就是"AI 开一轮" ─────────────────────────────────────────
  const baseline = mock.requests.length;
  await new Promise((r) => setTimeout(r, 1500));
  const baseline2 = mock.requests.length;
  const wakeRes = await fetch(`http://127.0.0.1:${consolePort}/api/socialV2/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': cfg.consoleToken },
    body: JSON.stringify({ key: KEY, reason: 'admin' }),
    signal: AbortSignal.timeout(10000)
  }).then((r) => r.json()).catch((e) => ({ error: String(e?.message ?? e) }));
  check('⑤ 手动唤醒接口返回 ok', wakeRes.ok === true, JSON.stringify(wakeRes).slice(0, 120));

  // 等提醒回合的请求到达假 AI（第 1 轮 2 次请求 + 提醒 1 次）
  for (let i = 0; i < 60; i += 1) {
    if (mock.requests.length - baseline2 >= 3) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const reqs = mock.requests.slice(baseline2);
  check('⑤ 桥接真的跑了两轮（首轮 + 收尾提醒）', reqs.length >= 3, `收到 ${reqs.length} 个请求`);

  const firstReq = reqs[0];
  const reminderReq = reqs.find((r) => lastUserText(r).includes('本回合只做收尾'));
  check('⑤ 日志出现"未设置唤醒条件，发送提醒"', /未设置唤醒条件，发送提醒 \(1\/2\)/.test(logText),
    (logText.match(/\[reserved2\].*发送提醒.*/) ?? ['(未找到)'])[0].slice(0, 100));

  // ── A：两轮 prompt 都要带【你最近发过的消息】 ─────────────────────────────
  check('A 首轮 prompt 带【你最近发过的消息】', lastUserText(firstReq).includes('【你最近发过的消息】'));
  check('A 首轮 prompt 里能看到自己刚说过的那句', lastUserText(firstReq).includes(SELF_TEXT));
  check('A 首轮 prompt 里能看到对方那条 @（上下文对照）', lastUserText(firstReq).includes('你不是多模态吗'));
  check('A 提醒 prompt 带【你最近发过的消息】',
    !!reminderReq && lastUserText(reminderReq).includes('【你最近发过的消息】'),
    reminderReq ? '' : '没找到提醒回合的请求');
  check('A 提醒文案说清"这不是新消息"',
    !!reminderReq && /不是新消息/.test(lastUserText(reminderReq)));

  // ── B：提醒回合交给模型的工具表里不能有发送类工具 ─────────────────────────
  check('B 首轮（正常回合）**保留**发送类工具',
    SEND_TOOLS.every((n) => toolNames(firstReq).includes(n)),
    `首轮工具数 ${toolNames(firstReq).length}`);
  const reminderTools = reminderReq ? toolNames(reminderReq) : [];
  check('B 提醒回合的工具表**不含**任何发送类工具',
    reminderTools.length > 0 && !SEND_TOOLS.some((n) => reminderTools.includes(n)),
    `提醒回合工具数 ${reminderTools.length}`);
  check('B 提醒回合仍保留收尾必需的工具',
    ['qq_set_wake_config', 'qq_mark_read', 'qq_wait_for_messages'].every((n) => reminderTools.includes(n)),
    reminderTools.filter((n) => ['qq_set_wake_config', 'qq_mark_read', 'qq_wait_for_messages'].includes(n)).join(','));
  check('B 日志说明了本回合按回合禁用发送类工具',
    /本回合为收尾提醒：已按回合禁用 \d+ 个发送类工具/.test(logText),
    (logText.match(/.*本回合为收尾提醒.*/) ?? ['(未找到)'])[0].slice(0, 110));

  // ── C：未读工具返回里，旧消息要带 repliedBefore（模型能看到） ────────────
  // ⚠️ 工具结果**不在**发起工具调用的那个请求里，而在同一回合的下一个请求里
  //    （OpenAI 协议：assistant(tool_calls) → tool 结果 → 下一次请求带上它）。
  //    第一版我就是在 firstReq 里找，永远找不到 —— 断言写错比功能写错更常见，别赖实现。
  const turnReqs = reminderReq ? reqs.slice(0, reqs.indexOf(reminderReq)) : reqs;
  const toolMsg = turnReqs
    .flatMap((r) => (r?.body?.messages ?? []))
    .find((m) => m.role === 'tool' && String(m.content ?? '').includes('unreadCount'));
  const toolText = String(toolMsg?.content ?? '');
  check('C 未读工具返回里带 repliedBefore 标记', /"repliedBefore":\s*true/.test(toolText),
    toolText.slice(0, 160).replace(/\s+/g, ' '));
  check('C 未读工具返回里给出 lastAiReplyAt 与说明',
    /"lastAiReplyAt":/.test(toolText) && /大概率已经回过/.test(toolText));

  // ── 收尾：提醒回合之后不应再无限开新轮 ────────────────────────────────────
  await new Promise((r) => setTimeout(r, 2000));
  const afterCount = mock.requests.length - baseline2;
  check('⑥ 提醒之后没有继续硬开新回合（护栏进入退避/默认配置）',
    afterCount <= 5, `共 ${afterCount} 个请求`);
  check('⑥ 没有真的往 QQ 发东西（沙箱里 SnowLuma 是死端口）',
    !/工具统一发送|\[send\]/.test(logText));

  if (failures > 0) {
    console.log('\n--- 首轮 prompt 摘要 ---\n' + lastUserText(firstReq).slice(-1500));
    console.log('\n--- 提醒 prompt 全文 ---\n' + (reminderReq ? lastUserText(reminderReq) : '(无)'));
    console.log('\n--- 未读工具返回（模型看到的原文） ---\n' + (toolText || '(没找到 tool 消息)'));
    console.log('\n--- 桥接日志尾部 ---\n' + logText.slice(-1500));
  }
} catch (error) {
  console.log(`FAIL 测试自身异常：${error?.message ?? error}`);
  failures += 1;
} finally {
  killTree(bridge);
  await new Promise((r) => setTimeout(r, 500));
  try { await mock.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); console.log('沙箱已清理：true'); } catch { /* 忽略 */ }
}

console.log('');
console.log(failures === 0 ? '=== 防重复回复端到端验证通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
