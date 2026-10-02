// **端到端**验证 MCP 客户端的超时链路（2026-09-27 事故回归）。
//
// 与 scripts/test-mcp-tool-provider.mjs 的区别：那边用假 client 证明"timeout 传下去了"，
// 这里**真的连一个慢 MCP server**（scripts/fixtures/slow-mcp-server.mjs），
// 让工具真的睡 70 秒 —— 只有这样才能证明"SDK 确实按我们给的预算等"，而不是只证明我们传了参数。
// （教训：超时/长尾这类问题 mock 立刻返回，永远验证不到"等 5 分钟会怎样"。）
//
// ⚠️ 它要跑约 2 分钟，所以**不进默认测试套件**；需要时手动跑：
//     node scripts/test-mcp-long-poll-timeout.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpToolProvider, planToolCallTimeout } from '../src/agent-runtime/mcp-tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS = [{ name: 'slow-fixture', script: 'scripts/fixtures/slow-mcp-server.mjs' }];
const SLEEP_MS = 70_000;          // 刻意刚过 SDK 的 60 秒默认线
const QUIET_MS = 10_000;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const logs = [];
const provider = new McpToolProvider({
  root: ROOT,
  servers: SERVERS,
  maxCallMs: 570_000,            // 与桥接实际传进去的值一致（整轮 600 秒 − 30 秒）
  log: (m) => logs.push(m)
});

try {
  const snap = await provider.start();
  logs.forEach((l) => console.log(`  ${l}`));
  check('夹具 server 起来了', snap.servers === 1 && snap.tools === 2, `${snap.servers} server / ${snap.tools} tool`);
  check('夹具工具拿到了"按请求时长算"的预算（不再是 60 秒）',
    planToolCallTimeout('qq_wait_for_messages', { timeoutMs: SLEEP_MS, quietMs: QUIET_MS }, { maxMs: 570_000 })
      .timeoutMs === SLEEP_MS + QUIET_MS + 20_000);

  // ── ① 长轮询工具：必须活过 60 秒 ───────────────────────────────────────────
  console.log(`\n① 调 qq_wait_for_messages(timeoutMs=${SLEEP_MS}) —— 真的要等 70 秒…`);
  const t0 = Date.now();
  const waited = await provider.callTool('qq_wait_for_messages', { timeoutMs: SLEEP_MS, quietMs: QUIET_MS });
  const waitedMs = Date.now() - t0;
  check('★ 70 秒的等待没被 60 秒默认超时掐掉（这正是 -32001 的形态）',
    waited.ok === true && waitedMs >= SLEEP_MS - 2_000 && waitedMs < SLEEP_MS + 10_000,
    `ok=${waited.ok} 实等 ${Math.round(waitedMs / 1000)} 秒${waited.error ? ` / ${waited.error}` : ''}`);
  check('返回内容确实是夹具的（没被当成失败吞掉）',
    /"fixture"\s*:\s*"wait"/.test(String(waited.text ?? '')), String(waited.text ?? '').slice(0, 60));

  // ── ② 同名不同类：普通工具拿 60 秒预算 → 必须复现老错误 ─────────────────────
  // 这一步是**反证**：如果它也"活下来了"，说明这个测试根本没在测超时。
  console.log(`\n② 反证：普通工具 slow_probe(ms=${SLEEP_MS}) 只该拿 60 秒预算 —— 应该被掐…`);
  const t1 = Date.now();
  const probe = await provider.callTool('slow_probe', { ms: SLEEP_MS });
  const probeMs = Date.now() - t1;
  check('★ 普通工具超预算时如期失败（证明这个测试真的能抓到那类 bug）',
    probe.ok === false && probeMs >= 55_000 && probeMs < 70_000,
    `ok=${probe.ok} 实等 ${Math.round(probeMs / 1000)} 秒`);
  check('失败措辞里带着 SDK 的 -32001 原文',
    /-32001|timed out/i.test(String(probe.error ?? '')), String(probe.error ?? '').slice(0, 120));
  check('★ 措辞里还会附上"本次给它的预算"（排查时不用再猜）',
    /预算是 60 秒/.test(String(probe.error ?? '')), String(probe.error ?? '').slice(0, 160));
} catch (error) {
  console.error(`❌ 未捕获错误：${error?.stack ?? error}`);
  failures += 1;
} finally {
  try { await provider.close(); } catch { /* 忽略 */ }
}

console.log('');
console.log(failures === 0
  ? '=== MCP 客户端超时链路：端到端通过 ==='
  : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
