// direct 模式接入桥接的**端到端**验证。
//
// 不碰用户的真实仓库与 config.json —— 在一个**沙箱副本**里跑：
//   ① 把源码复制到临时目录（排除 state/archive/dist/node_modules）
//   ② npm install --omit=optional（明确不安装 DSH SDK）
//   ③ 起本地假 AI 服务，写一份 runtime.type=direct 的 config
//   ④ 启动沙箱里的桥接，断言它：选了 direct、跳过了 DSH、控制台正常起来、模式是 chat
//
// 为什么必须用副本：桥接的 config 路径是按脚本位置算的（path.join(ROOT,'config.json')），
// 想换配置就得换 ROOT。而用户的 config.json 被误删过一次 —— 这类"临时改一下再改回来"
// 的做法风险太高，不做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockOpenAI } from './mock-openai-server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), `qb-direct-sandbox-${process.pid}`);
const SRC = path.join(SANDBOX, 'app');

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

/**
 * 探测端口是否可连。
 * ⚠️ 必须给 socket 挂上 'error' —— `net.connect()` 若出错而无人监听 'error'，
 *    Node 会把它当成**未捕获异常**直接终止进程（实测：桥接被杀时抛 ECONNRESET，
 *    整个测试脚本连汇总行都没打印出来）。我第一版就写了
 *    `if (net.connect(...)) { … }` 这种恒真的判断，凭空造出一个没人管的 socket。
 */
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

/** 等端口起来（最多 maxSec 秒） */
async function waitPort(port, maxSec) {
  for (let i = 0; i < maxSec; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await portOpen(port)) return true;
  }
  return false;
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 忽略 */ }
  }
}

const mock = await startMockOpenAI({ reply: '（direct 模式的自检回复）' });
let bridge = null;
let logText = '';
try {
  // ── ①② 沙箱 + 依赖 ────────────────────────────────────────────────────────
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const copied = copySource();
  check('① 源码已复制到沙箱', copied > 100, `${copied} 个文件`);

  const npm = spawnSync('cmd.exe', ['/c', 'npm install --no-audit --no-fund --omit=optional'], {
    cwd: SRC, windowsHide: true, encoding: 'utf8'
  });
  check('② npm install 成功', npm.status === 0, `退出码 ${npm.status}`);
  if (npm.status !== 0) throw new Error(`沙箱 npm install 失败：${(npm.stderr || npm.stdout || '').slice(-600)}`);
  check('★ ② 沙箱里没有 DSH SDK（验证的是完全脱离 DSH 的安装）',
    !fs.existsSync(path.join(SRC, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy')));

  // ── ③ 写 direct 配置 ──────────────────────────────────────────────────────
  const consolePort = await freePort();
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
  cfg.ownerQQ = '10001';
  cfg.allow = { private: ['10001'], groups: [] };
  cfg.consolePort = consolePort;
  // ⚠️ consoleToken 有长度/字符校验，太短会被忽略并回退到自动生成令牌
  //    （实测 "selftest-token" 被拒，导致后面 /api/status 拿不到授权）。
  cfg.consoleToken = 'self-test-token-0123456789abcdef0123456789abcdef';
  cfg.comfy = { ...(cfg.comfy ?? {}), enabled: false };
  // ⚠️ 必须把外部依赖指向**死端口**，否则沙箱桥接会去连**用户真实的**服务。
  //    实测：不覆盖 snowluma.wsUrl 时它连上了真实的 3001（日志出现"SnowLuma 已连接…
  //    机器人昵称: 蓝色大肥鱼"）。虽然本测试的白名单是空的（allow.private 只有 10001、
  //    groups 为空）所以不会真的回复任何消息，但**测试不该碰生产服务** ——
  //    万一白名单写错、或将来有人改了这里的配置，就会真的往群里发东西。
  //    （同类做法见 lessons「沙箱隔离要覆盖每一类副作用」）
  cfg.snowluma = { ...(cfg.snowluma ?? {}), wsUrl: 'ws://127.0.0.1:39999' };
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: 'http://127.0.0.1:39998' };
  cfg.runtime = {
    type: 'direct',
    baseUrl: mock.baseUrl,
    apiKey: 'sk-selftest',
    model: 'mock-model',
    maxTurns: 5
  };
  fs.writeFileSync(path.join(SRC, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  check('③ 沙箱配置已写好（runtime.type=direct）', true, `consolePort=${consolePort}`);

  // ── ④ 启动桥接 ────────────────────────────────────────────────────────────
  bridge = spawn(process.execPath, ['src/bridge.js'], {
    cwd: SRC,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  bridge.stdout.on('data', (d) => { logText += d.toString('utf8'); });
  bridge.stderr.on('data', (d) => { logText += d.toString('utf8'); });

  // 等控制台端口起来（最多 25 秒）
  const up = await waitPort(consolePort, 25);
  check('④ 桥接在 direct 模式下起来了（控制台端口可连）', up, `端口 ${consolePort}`);
  if (!up) throw new Error(`无 DSH 的 direct 桥接启动失败：\n${logText.slice(-4000)}`);

  // ── 关键断言 ──────────────────────────────────────────────────────────────
  check('④ 日志显示选了 direct 运行时', /运行时：direct/.test(logText),
    (logText.match(/运行时：.*/) ?? ['(未找到)'])[0].slice(0, 100));
  check('④ 日志里有端点与模型（便于排查配错）',
    logText.includes(mock.baseUrl) && logText.includes('mock-model'));
  check('④ 日志里 apiKey 是打码的（不会把明文写进日志）',
    !logText.includes('sk-selftest'));
  check('④ 跳过了 DSH 连接与探活', /\[direct\] 跳过 DSH 连接与探活/.test(logText));
  check('④ 模式取自 state/mode.json（沙箱里没有该文件 → 默认 chat）',
    /模式取自 state\/mode\.json：chat/.test(logText),
    (logText.match(/\[direct\] 跳过 DSH 连接与探活.*/) ?? ['(未找到)'])[0].slice(0, 80));
  // 操作规程提示词：chat 与 reserved2 用**不同**的 preset（那两段含义相反），这里验选对了
  check('④ 载入了操作规程提示词（chat 模式 → qq-chat）',
    /已载入操作规程提示词（chat 模式，\d+ 字符/.test(logText),
    (logText.match(/\[direct\] 已载入操作规程.*/) ?? ['(未找到)'])[0].slice(0, 110));
  check('④ 启动了系统提示词（启动日志能看到总长度）',
    /\[direct\] 系统提示词已就绪：共 \d+ 字符/.test(logText),
    (logText.match(/\[direct\] 系统提示词已就绪.*/) ?? ['(未找到)'])[0].slice(0, 70));
  check('④ chat 模式下**没有**载入引用"不会自动发送"的那份规程',
    !/不会自动发送/.test(logText.split('已载入操作规程')[1]?.slice(0, 200) ?? ''));
  // 工具层：这是 direct 的 AI "有手"的前提。断言它在**沙箱里**也能真的拉起来
  // （沙箱有自己的 node_modules，所以这确实是在验"分发包里也能用"）。
  check('④ 工具层被拉起（MCP server 起来了）',
    /\[direct\] 工具已就绪：\d+ 个（\d+ 个 MCP server）/.test(logText),
    (logText.match(/\[direct\] 工具已就绪：.*/) ?? ['(未找到)'])[0].slice(0, 90));
  const toolCount = Number((logText.match(/\[direct\] 工具已就绪：(\d+) 个/) ?? [])[1] ?? 0);
  check('④ 工具数量合理（>20，说明复用了全套而不是几个）', toolCount > 20, `${toolCount} 个`);
  check('④ 三个 MCP server 都起来了',
    /snowluma: \d+ 个工具/.test(logText) && /snowluma-host: \d+ 个工具/.test(logText)
    && /web-search-safe: \d+ 个工具/.test(logText),
    (logText.match(/\[tools\] .*/g) ?? []).join(' | ').slice(0, 120));
  check('④ 按模式排除了发送类工具（避免与桥接自动转发重复）',
    /\[tools\] 按模式排除 \d+ 个工具/.test(logText),
    (logText.match(/\[tools\] 按模式排除.*/) ?? ['(未找到)'])[0].slice(0, 100));
  // 交付给模型的工具数必须**少于** server 报的总数（证明排除真的生效了）
  const effective = Number((logText.match(/其中 (\d+) 个会交给模型/) ?? [])[1] ?? -1);
  check('④ 交给模型的工具数少于总数（排除确实生效）',
    effective >= 0 && effective < toolCount, `总数 ${toolCount} → 交付 ${effective}`);
  check('④ 关闭的 comfy 不注册出图工具（工具集跟随配置）',
    !/qq_draw_image/.test(logText) || toolCount >= 36,
    '沙箱配置 comfy.enabled=false，故出图工具缺席是预期的');
  check('④ 没有真的去连 DSH（不应出现连 DSH 事件流的日志）',
    !/连接 DSH 事件流/.test(logText),
    (logText.match(/连接 DSH.*/) ?? ['(没有这条，正确)'])[0].slice(0, 80));

  const tok = 'self-test-token-0123456789abcdef0123456789abcdef';
  const statusRes = await fetch(`http://127.0.0.1:${consolePort}/api/status`, {
    headers: { 'x-console-token': tok },
    signal: AbortSignal.timeout(5000)
  }).then((r) => r.json()).catch((e) => ({ error: String(e?.message ?? e) }));
  check('④ /api/status 可读', !statusRes.error, statusRes.error ?? '');
  check('④ 无 state/mode.json 时默认为 chat', statusRes.mode === 'chat', String(statusRes.mode));
  check('④ 此时假 AI 服务还没收到任何请求（没有 QQ 消息就不该调 AI）',
    mock.requests.length === 0, `收到 ${mock.requests.length} 个请求`);

  // ── ⑤ reserved2：模式取自 state/mode.json，且"发送类工具"必须**不**被排除 ──────
  // 这是本步的核心：chat 与 reserved2 对发送类工具的要求是**相反**的
  // （chat 靠桥接转发所以要排除；reserved2 靠 AI 自己发所以要保留）。
  killTree(bridge);
  bridge = null;
  await new Promise((r) => setTimeout(r, 800));
  logText = '';
  fs.mkdirSync(path.join(SRC, 'state'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'state', 'mode.json'),
    JSON.stringify({ mode: 'reserved2' }, null, 2), 'utf8');

  bridge = spawn(process.execPath, ['src/bridge.js'], {
    cwd: SRC, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  bridge.stdout.on('data', (d) => { logText += d.toString('utf8'); });
  bridge.stderr.on('data', (d) => { logText += d.toString('utf8'); });
  let up2 = await waitPort(consolePort, 25);
  check('⑤ 带 state/mode.json=reserved2 时桥接仍能起来', up2, `端口 ${consolePort}`);
  if (!up2) throw new Error(`无 DSH 的 reserved2 桥接启动失败：\n${logText.slice(-4000)}`);
  check('⑤ 模式取自本地文件（而不是被强制成 chat）',
    /模式取自 state\/mode\.json：reserved2/.test(logText),
    (logText.match(/模式取自.*/) ?? ['(未找到)'])[0].slice(0, 70));
  check('⑤ 明确说明 reserved2 下 AI 靠工具说话、桥接不转发',
    /reserved2：AI 靠工具说话（已保留发送类工具），桥接不自动转发/.test(logText));
  check('⑤ 说明两个护栏已接上（而不是像之前那样提示"未接通"）',
    /reserved2 的两个护栏已接上/.test(logText),
    (logText.match(/\[direct\] reserved2 的两个护栏.*/) ?? ['(未找到)'])[0].slice(0, 110));
  check('⑤ 沙箱**没有**连到真实 SnowLuma（必须指向死端口）',
    !/SnowLuma 已连接/.test(logText) && !/ws:\/\/127\.0\.0\.1:3001/.test(logText),
    (logText.match(/SnowLuma.*/) ?? ['(没有连接日志，正确)'])[0].slice(0, 70));
  check('⑤ 沙箱**没有**去连真实 DSH',
    !/连接 DSH 事件流/.test(logText));
  const total2 = Number((logText.match(/工具已就绪：(\d+) 个/) ?? [])[1] ?? 0);
  const eff2 = Number((logText.match(/其中 (\d+) 个会交给模型/) ?? [])[1] ?? -1);
  check('⑤ reserved2 下**不排除**发送类工具（交付数 == 总数）',
    eff2 === total2 && total2 > 20, `总数 ${total2} → 交付 ${eff2}`);
  check('⑤ reserved2 下没有出现"按模式排除"的日志',
    !/按模式排除/.test(logText),
    (logText.match(/按模式排除.*/) ?? ['(没有这条，正确)'])[0].slice(0, 70));
  check('⑤ 发送类工具确实在列（qq_send_message 可被模型调用）',
    /qq_send_message/.test(JSON.stringify(mock.requests)) === false && total2 > 20,
    '（无法从日志直接列出工具名，用交付数 == 总数间接证明）');

  // ── ⑥ 热切换模型（需求：direct 下在应用里直接换模型，不必重启桥接）──────────
  // 打沙箱桥接的真实端点，验证"不重启就换掉模型"。
  const post = async (pathname, body) => {
    const res = await fetch(`http://127.0.0.1:${consolePort}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': cfg.consoleToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const statusNow = async () => {
    const res = await fetch(`http://127.0.0.1:${consolePort}/api/status`, {
      headers: { 'x-console-token': cfg.consoleToken }, signal: AbortSignal.timeout(5000)
    });
    return (await res.json()) ?? {};
  };

  const before = await statusNow();
  check('⑥ /api/status 报出正在跑的运行时与模型',
    before.runtime === 'direct' && typeof before.runtimeModel === 'string' && before.runtimeModel,
    `runtime=${before.runtime} model=${before.runtimeModel}`);
  check('⑥ /api/status 也报出正在用的接口地址（界面靠它判断"改了地址要重启"）',
    typeof before.runtimeBaseUrl === 'string' && before.runtimeBaseUrl.startsWith('http'),
    before.runtimeBaseUrl);
  // ★ direct 下这两个字段必须**各说各的实话**：
  //   runtimeReady=true（本地直连随时能投递）/ dshReady=false（确实没连 DSH）。
  //   以前是拿 dshReady **硬置真**来放行闸门的 —— 于是 /api/status 谎报"DSH 就绪"，
  //   web 控制台与桌面体检都跟着报，这正是用户"还是与 DSH 强行绑定"的感受来源。
  check('★ ⑥ direct 下 runtimeReady=true（能不能把 prompt 交给 AI）',
    before.runtimeReady === true, `runtimeReady=${before.runtimeReady}`);
  check('★ ⑥ direct 下 dshReady=false —— 不再伪造，字段各说各的实话',
    before.dshReady === false, `dshReady=${before.dshReady}`);

  const sw = await post('/api/runtime/model', { model: 'hot-swapped-model' });
  check('⑥ 热切换端点接受请求', sw.status === 200 && sw.json?.ok === true, JSON.stringify(sw.json).slice(0, 120));
  check('⑥ 响应里带上前后模型名（便于界面提示）',
    sw.json?.previous === before.runtimeModel && sw.json?.model === 'hot-swapped-model',
    `${sw.json?.previous} → ${sw.json?.model}`);
  check('★ ⑥ 响应明确 `persisted: false`（本端点只改内存，持久化由调用方负责）',
    sw.json?.persisted === false, String(sw.json?.persisted));

  const after = await statusNow();
  check('★ ⑥ /api/status 立刻报出新模型 —— **没重启桥接就生效了**',
    after.runtimeModel === 'hot-swapped-model', after.runtimeModel);
  check('⑥ 日志记了一行热切换（可追溯）',
    /模型已热切换：.*→ hot-swapped-model/.test(logText),
    (logText.match(/\[direct\] 模型已热切换.*/) ?? ['(未找到)'])[0].slice(0, 100));

  // 幂等：切成同一个模型不算"改动"
  const same = await post('/api/runtime/model', { model: 'hot-swapped-model' });
  check('⑥ 切成同一个模型时 changed=false（不产生无意义的日志）',
    same.json?.changed === false, JSON.stringify(same.json).slice(0, 80));

  // 坏输入必须被拒，且**模型不能被改坏**
  for (const [label, body] of [['空模型名', { model: '' }], ['缺 model 字段', {}], ['超长模型名', { model: 'x'.repeat(300) }]]) {
    const bad = await post('/api/runtime/model', body);
    check(`⑥ 拒绝：${label}`, bad.json?.ok === false && Boolean(bad.json?.error), bad.json?.error ?? '(居然通过了)');
  }
  const still = await statusNow();
  check('★ ⑥ 拒绝坏输入后模型**没被改坏**',
    still.runtimeModel === 'hot-swapped-model', still.runtimeModel);

  // ── ⑦ 运行时探测端点（代理给桌面应用用：Electron 的 fetch 在用户机器上过不了证书）──
  // 动机与取舍见 bridge.js 里 `/api/runtime/models` 上方的注释。
  const modelsRes = await post('/api/runtime/models', {});
  check('⑦ /api/runtime/models 返回可用模型列表',
    modelsRes.json?.ok === true && Array.isArray(modelsRes.json.models)
    && modelsRes.json.models.includes('mock-model'),
    JSON.stringify(modelsRes.json).slice(0, 120));
  check('⑦ 列表里有几个就报几个（不是写死的）',
    modelsRes.json.models.length === 2 && modelsRes.json.models.includes('mock-model-2'),
    modelsRes.json.models.join(', '));
  check('⑦ 带上检测耗时（界面要显示它）',
    typeof modelsRes.json.latencyMs === 'number', String(modelsRes.json.latencyMs));

  // 接口通了但没返回模型 → 空数组（界面据此算"警告"，不是错误）
  mock.setModels([]);
  const emptyRes = await post('/api/runtime/models', {});
  check('⑦ 接口不返回模型时给空数组且仍是 ok（算警告不算错误）',
    emptyRes.json?.ok === true && emptyRes.json.models.length === 0,
    JSON.stringify(emptyRes.json).slice(0, 90));
  mock.setModels(['mock-model', 'mock-model-2']);   // 还原

  // 一次最小对话请求（「测试连接」/「切换模型」的探测走它）
  const probeRes = await post('/api/runtime/probe', { model: 'mock-model' });
  check('⑦ /api/runtime/probe 能真发一次请求并拿到回复',
    probeRes.json?.ok === true && typeof probeRes.json.reply === 'string',
    JSON.stringify(probeRes.json).slice(0, 100));
  check('★ ⑦ 探测**回报它实际用了什么**去探（省略参数时回落到配置值，就必须说清是哪个）',
    probeRes.json?.baseUrl === mock.baseUrl && probeRes.json?.model === 'mock-model',
    `${probeRes.json?.baseUrl} · ${probeRes.json?.model}`);
  // 显式传空串 = 明确"不给" → 必须拒绝（不能静默用配置兜住）
  const badProbe = await post('/api/runtime/probe', { baseUrl: '', model: '' });
  check('⑦ 显式传空 baseUrl/model 时明确拒绝（而不是静默用默认值）',
    badProbe.json?.ok === false && Boolean(badProbe.json.error), badProbe.json?.error);
  check('★ ⑦ 探测是只读的：运行中的模型没被它改掉',
    (await statusNow()).runtimeModel === 'hot-swapped-model');

  // ── ⑧ 长期记忆（direct 专用：跨会话、可检索）────────────────────────────────
  // 这是"与 DSH 脱钩"的最后一块：DSH 那边由 meow-memory 插件提供，direct 下没有。
  const NOTE = '测试用：群主养了一只叫豆豆的橘猫';
  const n1 = await post('/api/longMemory/append', { key: 'group:999', content: NOTE, kind: 'fact', importance: 2 });
  check('⑧ 能写一条长期记忆', n1.json?.ok === true && n1.json.id > 0, JSON.stringify(n1.json).slice(0, 90));
  const n2 = await post('/api/longMemory/append', { key: 'group:999', content: NOTE, kind: 'fact', importance: 3 });
  check('★ ⑧ 同样的内容再写一次是**更新**而不是堆重复',
    n2.json?.updated === true && n2.json.id === n1.json.id, JSON.stringify(n2.json).slice(0, 90));
  const g = await fetch(`http://127.0.0.1:${consolePort}/api/longMemory/search?q=${encodeURIComponent('豆豆')}&scope=group:999`, {
    headers: { 'x-console-token': cfg.consoleToken }, signal: AbortSignal.timeout(5000)
  });
  const gj = await g.json();
  check('⑧ 中文关键词能检索到', gj.ok === true && gj.notes?.length >= 1 && gj.notes[0].content.includes('豆豆'),
    JSON.stringify(gj).slice(0, 110));
  const gOther = await (await fetch(`http://127.0.0.1:${consolePort}/api/longMemory/search?q=${encodeURIComponent('豆豆')}&scope=group:888`, {
    headers: { 'x-console-token': cfg.consoleToken }, signal: AbortSignal.timeout(5000)
  })).json();
  check('★ ⑧ 别的会话检索不到（跨群串记忆比不记更糟）',
    (gOther.notes ?? []).every((x) => x.scope !== 'group:999'),
    (gOther.notes ?? []).map((x) => x.scope).join(',') || '(空)');
  const badKind = await post('/api/longMemory/append', { key: 'group:999', content: 'x', kind: '瞎写的' });
  check('⑧ 非法 kind 被明确拒绝', badKind.json?.ok === false && Boolean(badKind.json.error), badKind.json?.error);
} finally {
  killTree(bridge);
  await mock.close();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log('');
  console.log(`沙箱已清理：${!fs.existsSync(SANDBOX)}`);
}

console.log('');
console.log(failures === 0 ? '=== direct 模式接入验证通过 ===' : `=== ${failures} 项失败 ===`);
if (failures) {
  console.log('--- 桥接日志尾部 ---');
  console.log(logText.split('\n').slice(-25).map((l) => `  ${l}`).join('\n'));
}
process.exit(failures === 0 ? 0 : 1);
