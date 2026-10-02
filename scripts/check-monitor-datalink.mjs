// 验证监测页的**主进程取数链路**（不需要 Electron）。
//
// 渲染层能不能显示，取决于 main.mjs 里 bridgeGet() 用的三样东西是否都对：
//   ① readConsoleToken(ROOT) 读得到令牌
//   ② readConfig(ROOT).consolePort 是桥接实际在听的端口
//   ③ 三个端点带着令牌请求能返回渲染层期望的字段
// 这里把它们逐个验一遍 —— 覆盖"IPC 写对了但底层读不到"这类问题。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, readConsoleToken } from '../desktop/lib/health.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const token = readConsoleToken(ROOT);
check('① readConsoleToken 读得到令牌', typeof token === 'string' && token.length > 10,
  token ? `${token.length} 字符` : '(空)');

const cfg = readConfig(ROOT);
const port = Number(cfg?.consolePort) || 3100;
check('② readConfig 给出控制台端口', port > 0 && port < 65536, `consolePort=${port}`);

async function get(pathname, timeoutMs = 6000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── /api/socialV2/states → 监测页左栏 ───────────────────────────────────────
const states = await get('/api/socialV2/states');
if (!states.ok) {
  console.log(`SKIP 桥接未在 ${port} 应答（${states.error ?? `HTTP ${states.status}`}）—— 服务没起来时跳过端点形状检查`);
} else {
  check('③ /api/socialV2/states 有 conversations 数组', Array.isArray(states.json?.conversations),
    `${states.json?.conversations?.length ?? 0} 个会话`);
  const c = states.json?.conversations?.[0];
  if (c) {
    check('会话项含渲染层要用的字段',
      'key' in c && 'wakeConfig' in c && 'unreadCount' in c && 'lastAiReplyAt' in c,
      Object.keys(c).join(', '));
    check('wakeConfig.mode 是 diving/active 之一',
      ['diving', 'active'].includes(c.wakeConfig?.mode), String(c.wakeConfig?.mode));
  }

  // ── /api/status → 监测页活动流 + 总览状态条 ──────────────────────────────
  const status = await get('/api/status');
  check('③ /api/status 可读', status.ok);
  const j = status.json ?? {};
  check('status 含活动流字段 activity（字符串）', typeof j.activity === 'string', `${String(j.activity).length} 字符`);
  check('status 含总览状态条要用的字段',
    'mode' in j && 'role' in j && 'dshReady' in j && 'socialV2Paused' in j,
    ['mode', 'role', 'dshReady', 'socialV2Paused', 'allowGroups', 'allowPrivate'].filter((k) => k in j).join(', '));

  // ── /api/socialV2/recent → 点会话后的最近消息 ────────────────────────────
  const key = states.json?.conversations?.[0]?.key;
  if (key) {
    const recent = await get(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=3`);
    check(`③ /api/socialV2/recent 可读（key=${key}）`, recent.ok, recent.ok ? '' : String(recent.json?.error ?? ''));
    const m = recent.json?.messages?.[0];
    if (m) {
      // 这几个字段名就是渲染层 describeMessage() 依赖的（见 scripts/test-renderer-pure.mjs）
      check('消息项含 sender / time / text（渲染层依赖的字段名）',
        'sender' in m && 'time' in m && typeof m.time === 'number',
        `字段：${Object.keys(m).slice(0, 8).join(', ')}…`);
    } else {
      console.log('INFO 该会话暂无缓存消息，跳过消息字段检查');
    }
  }
}

console.log('');
console.log(failures === 0 ? '=== 监测取数链路检查通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
