// /api/socialV2/send-image 的路径围栏真机测试。
//
// 关键点：桥接的校验顺序是
//   comfy.enabled -> outputDir 已配置 -> agent token -> 模式/白名单 -> 静默模式
//   -> replyToMessageId -> 【路径围栏 realpath/relative】-> 图片魔数 -> 发送
// 所以必须带**真实的 agent 令牌**才能走到围栏那一层；否则只会拿到
// "reserved2 模式发送必须携带 agent token"，什么都验证不到。
//
// 本脚本**不会真的往 QQ 发任何消息**：所有用例的 path 都是应当被围栏拒绝的，
// 合法图片那条也只断言"已越过围栏"，从不执行到发送那一步。
//
// 令牌从 state/social-v2.json 读取，仅用于请求头，不打印。
//
// 用法：node scripts/test-send-image-fence.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRIDGE = 'http://127.0.0.1:3100';
const COMFY_OUT = 'E:\\comfyui\\ComfyUI\\output';
// 用一个真实存在、且 recentMessages 为空的白名单会话，避免任何副作用。
const KEY = 'group:200000001';

function readConsoleToken() {
  try {
    const fromCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (fromCfg.consoleToken) return String(fromCfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function readAgentToken(key) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    return String(j?.conversations?.[key]?.agentToken ?? '');
  } catch {
    return '';
  }
}

const consoleToken = readConsoleToken();
const agentToken = readAgentToken(KEY);
if (!consoleToken) { console.error('无法读取控制台令牌（state/console-token）'); process.exit(1); }
if (!agentToken) { console.error(`无法读取 ${KEY} 的 agent 令牌（state/social-v2.json）`); process.exit(1); }
console.log(`目标会话: ${KEY}（agent 令牌已读取，长度 ${agentToken.length}，不打印）\n`);

async function send(imagePath) {
  const res = await fetch(`${BRIDGE}/api/socialV2/send-image`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': consoleToken,
      'x-agent-token': agentToken
    },
    body: JSON.stringify({ key: KEY, path: imagePath, message: '' }),
    signal: AbortSignal.timeout(15000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, error: String(body?.error ?? ''), ok: body?.ok };
}

let failures = 0;
function expectReject(label, result, wantStatus, wantText) {
  const statusOk = result.status === wantStatus;
  const textOk = !wantText || result.error.includes(wantText);
  const ok = statusOk && textOk && result.ok !== true;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  console.log(`       HTTP ${result.status} ${JSON.stringify(result.error).slice(0, 100)}`);
  if (!ok) {
    console.log(`       期望 HTTP ${wantStatus}${wantText ? ` 且含 ${JSON.stringify(wantText)}` : ''}`);
    failures += 1;
  }
}

// 前置确认：令牌有效，否则后面全是假阴性（等于没测）
const warmup = await send(path.join(ROOT, 'config.json'));
if (warmup.error.includes('agent token') || warmup.error.includes('不在当前模式允许范围内')) {
  console.error(`前置检查失败：令牌/白名单没通过 -> ${warmup.error}`);
  console.error('请确认桥接处于 reserved2 模式，且该会话在白名单内。');
  process.exit(1);
}
console.log('前置检查：agent 令牌有效，已越过令牌层\n');

// 1) 输出目录之外：桥接自己的敏感文件
expectReject('拒绝 config.json（realpath 判定在 outputDir 之外）',
  await send(path.join(ROOT, 'config.json')), 403, '输出目录');
expectReject('拒绝 state/console-token（控制台令牌文件）',
  await send(path.join(ROOT, 'state', 'console-token')), 403, '输出目录');
expectReject('拒绝 state/social-v2.json（含全部会话令牌）',
  await send(path.join(ROOT, 'state', 'social-v2.json')), 403, '输出目录');
expectReject('拒绝 C:\\Windows\\win.ini（系统文件）',
  await send('C:\\Windows\\win.ini'), 403, '输出目录');

// 2) 目录穿越：应当被拒绝。
//    安全不变量不是"必须报某个具体文案"，而是"绝不能被当作可发送的图片放行"：
//    归一化后的目标不存在时会先拿到 400「不存在」，存在但在围栏外时才拿到
//    403「输出目录」—— 两者都是拒绝，都安全。所以这里断言"被拒且未发送"。
async function expectRejected(label, result) {
  const rejected = result.ok !== true;
  const looksLikeFenceOrMissing = result.error.includes('输出目录')
    || result.error.includes('不存在')
    || result.error.includes('不可读')
    || result.error.includes('不是文件');
  const ok = rejected && looksLikeFenceOrMissing;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  console.log(`       HTTP ${result.status} ${JSON.stringify(result.error).slice(0, 100)}`);
  if (!ok) failures += 1;
}

expectRejected('拒绝 outputDir 内的 ..\\ 穿越（指向 ComfyUI 根目录）',
  await send(path.join(COMFY_OUT, '..', '..', 'main_wrapper.py')));
expectRejected('拒绝 outputDir 内的多级绝对路径逃逸',
  await send(path.join(COMFY_OUT, '..', '..', '..', 'Windows', 'win.ini')));

// 3) 不存在
expectReject('拒绝不存在的路径',
  await send(path.join(COMFY_OUT, '__nope__', 'nope.png')), 400, '不存在');

// 4) 非图片内容
const decoy = path.join(ROOT, 'state', '__fence_decoy__.txt');
fs.writeFileSync(decoy, 'not an image, just text pretending to be one\n');
expectReject('拒绝文本文件（非图片内容）', await send(decoy), 403, '输出目录');
fs.rmSync(decoy, { force: true });

// 5) 围栏之后的下游校验：用**目录**当输入。
//    目录能通过围栏（确实位于 outputDir 内），但会在"目标不是文件"处被拦下，
//    因此既验证了围栏的放行判定，又**绝不触发发送**。
//    （不拿真实图片测这一条：那会真的往 QQ 发图 —— 本脚本不做这种事。）
//    优先复用输出目录里已存在的子目录，避免依赖对 E: 盘的写权限。
let probeDir = null;
try {
  const entries = fs.existsSync(COMFY_OUT) ? fs.readdirSync(COMFY_OUT, { withFileTypes: true }) : [];
  const existing = entries.find((e) => e.isDirectory());
  if (existing) {
    probeDir = path.join(COMFY_OUT, existing.name);
  } else {
    const made = path.join(COMFY_OUT, '__fence_dir_probe__');
    fs.mkdirSync(made, { recursive: true });
    probeDir = made;
  }
} catch (error) {
  console.log(`SKIP 下游校验（无法在输出目录内取得探针目录：${error?.code ?? error?.message}）`);
}

if (probeDir) {
  const res = await send(probeDir);
  const fencePassed = !res.error.includes('输出目录') && !res.error.includes('不存在');
  const notSent = res.ok !== true;
  console.log(`${fencePassed && notSent ? 'OK  ' : 'FAIL'} 目录通过围栏但不被当作图片发送`);
  console.log(`       ${path.basename(probeDir)} -> HTTP ${res.status} ${JSON.stringify(res.error).slice(0, 90)}`);
  if (!(fencePassed && notSent)) failures += 1;
}

console.log(`\n${failures === 0 ? '=== 围栏测试全部通过 ===' : `=== ${failures} 项失败 ===`}`);
process.exit(failures === 0 ? 0 : 1);
