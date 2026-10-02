// direct 运行时的**上线前预检**。
//
// 为什么需要它：把 direct 接上真实 AI 时，最容易出问题的是**外部那一段** ——
// key 不对、模型名拼错、端点少写或多写 `/v1`、余额不足、模型不支持工具调用。
// 这些如果只从桥接日志里看，会和"桥接代码的问题"混在一起，来回试很久。
// 这个工具把那一段**单独拎出来先验**。
//
// 三级检查（逐级加深，都不打印密钥）：
//   node tools/check-direct-runtime.mjs             只查配置形状（离线，不发请求）
//   node tools/check-direct-runtime.mjs --live      真发一次最小对话请求（验 key 与模型名）
//   node tools/check-direct-runtime.mjs --tools     带工具发一轮，看**模型会不会调工具**
//                                                   （这是最容易被忽略、也最致命的一环：
//                                                    代码全对但模型不会用工具，机器人照样是哑的）
//
// 可选：--root <路径>（默认仓库根）、--model <名字>（临时覆盖，不写回配置）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectRuntime, describeDirectConfig } from '../src/agent-runtime/direct.js';
import { McpToolProvider } from '../src/agent-runtime/mcp-tools.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (n) => process.argv.includes(n);

const ROOT = path.resolve(argValue('--root') ?? REPO);
const CFG = path.join(ROOT, 'config.json');

let failures = 0;
const ok = (name, detail = '') => console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail = '') => { failures += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); };
const warn = (name, detail = '') => console.log(`⚠️  ${name}${detail ? ` — ${detail}` : ''}`);
const info = (name, detail = '') => console.log(`   ${name}${detail ? ` — ${detail}` : ''}`);

console.log('=== direct 运行时预检 ===');
console.log(`  仓库根：${ROOT}`);
console.log('');

// ── 1. 读配置 ───────────────────────────────────────────────────────────────
// ⚠️ 必须**和桥接一样剥掉 BOM**。桥接的 readJsonSafe 第 73 行就是这么做的
//    （`if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)`）。
//    我第一版这里直接 JSON.parse → 一个带 BOM 的 config.json 会被报成"无效 JSON"，
//    而桥接其实能正常读 —— **诊断工具的假警报比不报还糟**（用户会去改一个没坏的文件）。
//    顺带：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 就会写出带 BOM 的文件，
//    某些 Windows 编辑器也会 —— 所以这不是假想情况。
let cfg;
let hadBom = false;
try {
  let text = fs.readFileSync(CFG, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) { hadBom = true; text = text.slice(1); }
  cfg = JSON.parse(text);
} catch (e) {
  bad('读取 config.json', `${CFG}：${e?.message ?? e}`);
  process.exit(1);
}
if (hadBom) {
  warn('config.json 带 UTF-8 BOM', '桥接能正常读（会自动剥掉），不影响使用；'
    + '但如果用别的工具处理它，建议改存为"无 BOM 的 UTF-8"');
}
const rt = cfg.runtime ?? {};
const hasRuntime = cfg.runtime && typeof cfg.runtime === 'object';
info('配置里的 runtime 段', hasRuntime
  ? JSON.stringify({ ...rt, ...(rt.apiKey ? { apiKey: '***' } : {}) })
  : '（未配置）');

if (String(rt.type ?? 'dsh').toLowerCase() !== 'direct') {
  warn('runtime.type 不是 "direct"',
    `当前是 "${rt.type ?? '(未设，默认 dsh)'}" —— 桥接会走 DSH，不测 direct`);
  console.log('');
  console.log('  要试 direct，请把 config.json 的 runtime.type 改成 "direct"。');
  console.log('  （不测也没关系，本工具仍会按下面的值去验外部那一段）');
  console.log('');
}

// ── 2. 配置形状 ─────────────────────────────────────────────────────────────
if (!hasRuntime) {
  // 一次说清，而不是连报好几个 ❌ —— 用户此刻需要的是"我还没配"，不是"我配错了"
  bad('config.json 里还没有 runtime 段', '要试 direct 请加上（见下方模板）');
  console.log('');
  console.log('  把这段加到 config.json（顶层，与 dsh / allow 平级）：');
  console.log('  {');
  console.log('    "runtime": {');
  console.log('      "type": "direct",');
  console.log('      "baseUrl": "https://api.deepseek.com/v1",');
  console.log('      "apiKey": "你的key",');
  console.log('      "model": "deepseek-chat"');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('  加完再跑：node tools/check-direct-runtime.mjs --tools');
  process.exit(1);
}

if (!rt.baseUrl) bad('缺 runtime.baseUrl', '例如 https://api.deepseek.com/v1');
else if (!/^https?:\/\//.test(rt.baseUrl)) bad('baseUrl 必须是 http(s) 开头', String(rt.baseUrl));
else if (/\/chat\/completions\/?$/.test(rt.baseUrl)) {
  bad('baseUrl 不要带 /chat/completions', `现在：${rt.baseUrl}；应写到 /v1 为止`);
} else if (!/\/v\d+\/?$/.test(String(rt.baseUrl))) {
  warn('baseUrl 结尾不像 /v1', `${rt.baseUrl} —— 大多数 OpenAI 兼容服务是 https://host/v1，请确认`);
} else ok('baseUrl 形状正确', String(rt.baseUrl));

const model = argValue('--model') ?? rt.model;
if (!model) bad('缺 runtime.model', '例如 deepseek-chat');
else ok('model 已填', String(model));

if (!rt.apiKey) {
  warn('runtime.apiKey 为空', '本地 Ollama 之类不需要 key；云端服务需要在 config.json 里填');
} else {
  ok('apiKey 已填', `${String(rt.apiKey).slice(0, 4)}…（${String(rt.apiKey).length} 字符，按设计不打印明文）`);
}

if (failures > 0) {
  console.log('');
  console.log(`❌ 有 ${failures} 项配置问题，先修好再往下测。`);
  process.exit(1);
}
if (!has('--live') && !has('--tools')) {
  console.log('');
  console.log('配置形状没问题。想继续验外部那一段，加参数再跑：');
  console.log('  --live    真发一次最小对话请求（验 key 与模型名）');
  console.log('  --tools   带工具发一轮，看模型会不会调工具');
  process.exit(0);
}

const runtime = new DirectRuntime({
  baseUrl: rt.baseUrl,
  apiKey: rt.apiKey,
  model,
  timeoutMs: Number(rt.timeoutMs) > 0 ? Number(rt.timeoutMs) : 120_000,
  systemPrompt: '你是连通性测试用的助手。',
  log: () => {}
});
console.log('');
info('实际使用的配置', describeDirectConfig(runtime));
console.log('');

// ── 先判断"接下来的失败是不是预期内的" ──────────────────────────────────────
// 实测教训（2026-09-26）：用户第一次跑这个工具时看到**两个 ❌**，其中一个是
// "HTTP 401"（因为 apiKey 还没填）—— 那是**预期**，不是缺陷。
// 但工具把它与真正的证书错误并列报成 ❌，用户根本分不清哪个该管。
// ⇒ 诊断工具必须把"预期的失败"和"要修的问题"**在视觉上分开**，否则等于制造噪音。
const keyMissing = !rt.apiKey;
const isLocalEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/i.test(String(rt.baseUrl));
const expectAuthFail = keyMissing && !isLocalEndpoint;
if (expectAuthFail) {
  console.log('⏭️  接下来的请求会因"还没填 apiKey"而被拒 —— 这是**预期**的，不是问题。');
  console.log('   要真正验证，请先在 config.json 的 runtime.apiKey 里填上 key，再重跑本工具。');
  console.log('');
}

// ── 3. --live：最小对话 ─────────────────────────────────────────────────────
if (has('--live') || has('--tools')) {
  const t0 = Date.now();
  const r = await runtime.send({ key: '__preflight__', text: '回复两个字：收到' });
  const ms = Date.now() - t0;
  const authFail = !r.ok && (r.status === 401 || r.status === 403
    || /Authentication Fails|Invalid API key|Unauthorized/i.test(String(r.error)));
  if (!r.ok && authFail && expectAuthFail) {
    // 预期的 401：明说"这不是要你修的东西"，且**不计入失败数**
    console.log(`⏭️  请求被拒（${r.status ?? '认证失败'}）—— 如上面所说，因为还没填 apiKey。**这一项不算问题。**`);
    console.log('   填好 key 后重跑，这里会变成 ✅。');
  } else if (!r.ok) {
    bad('最小对话请求失败', r.error);
    if (r.hint) console.log('  修复提示：' + r.hint.split('\n').map((l, i) => (i ? '            ' : '') + l).join('\n'));
    console.log('');
    console.log('  常见原因对照：');
    console.log('   · HTTP 401 / Invalid API key  → key 不对或没填');
    console.log('   · HTTP 404 / model not found  → 模型名拼错，或 baseUrl 少了/多了 /v1');
    console.log('   · HTTP 402 / Insufficient     → 余额不足');
    console.log('   · 请求超时                     → 网络不通或需要代理（config.json 里可调大 timeoutMs）');
  } else {
    ok('最小对话请求成功', `${ms}ms · 模型回复「${String(r.text).slice(0, 40)}」`);
    info('延迟参考', `${ms}ms（桥接默认超时 120000ms，够用${ms > 30000 ? '，但偏慢' : ''}）`);
    if (r.usage) info('用量', JSON.stringify(r.usage));
  }
}

// ── 4. --tools：模型会不会调工具（最容易被忽略、也最致命的一环）──────────────
if (has('--tools')) {
  console.log('');
  console.log('=== 工具调用能力测试 ===');
  if (expectAuthFail) {
    // 没 key 时测这个必然 401，测不出任何信息 —— 虚报一个 ❌ 只会制造困惑
    console.log('⏭️  跳过：还没填 apiKey，此时测"模型会不会调工具"必然失败、得不到有用信息。');
    console.log('   填好 key 后重跑 `--tools`，那一步才是真正要看的。');
  } else {
  const tools = new McpToolProvider({ root: ROOT, log: (m) => info('[tools]', m) });
  let snap;
  try {
    snap = await tools.start();
  } catch (e) {
    bad('工具层起不来', String(e?.message ?? e));
  }
  if (snap && snap.tools > 0) {
    const effective = tools.listOpenAiTools();
    ok('工具层就绪', `${snap.tools} 个工具，交给模型 ${effective.length} 个`);

    // 让模型做一个"必然需要工具"的动作：查机器人登录状态。
    // 它没有其他途径知道答案 —— 如果它不调工具，就说明工具调用不可用。
    const calls = [];
    const t0 = Date.now();
    const r2 = await runtime.send({
      key: '__preflight_tools__',
      text: '请用工具查一下这个 QQ 机器人的登录状态（账号、昵称、是否在线），然后用一句话告诉我。',
      tools: effective,
      toolRunner: async (name, args) => {
        calls.push(name);
        return tools.callTool(name, args);
      },
      maxToolRounds: 3
    });
    const ms = Date.now() - t0;
    if (!r2.ok) {
      bad('带工具的请求失败', r2.error);
    } else if (calls.length === 0) {
      bad('模型**没有调用任何工具**', '它直接回答了 —— 说明这个模型可能不支持 function calling，'
        + '或工具定义没被接受。机器人会变成"只会说话、不会做事"');
      info('模型的回答', String(r2.text).slice(0, 120));
    } else {
      ok('模型成功调用了工具', `${calls.join(', ')} · ${ms}ms · 共 ${r2.toolCalls} 次调用`);
      info('最终回答', String(r2.text).slice(0, 160));
      if (r2.usage) info('用量', JSON.stringify(r2.usage));
    }
  }
  await tools.close();
  }
}

console.log('');
if (failures === 0) {
  if (expectAuthFail) {
    console.log('=== 预检通过（能验的部分都通过了）===');
    console.log('   ⏭️  但还没填 apiKey，所以"真实调用"这一环没验 —— 填好 key 后重跑本工具。');
  } else {
    console.log('=== 预检通过 —— 外部那一段是通的，可以去改 config.json 试真实聊天了 ===');
  }
} else {
  console.log(`=== ${failures} 项失败 —— 先解决上面标 ❌ 的问题 ===`);
}
process.exit(failures === 0 ? 0 : 1);
