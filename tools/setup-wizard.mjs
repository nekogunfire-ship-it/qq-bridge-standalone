// 首次配置向导 —— 让免安装包"解压即用"。
//
// 面向的场景：别人（或你换机后）拿到 dist/ 里的 zip，解压、npm install 之后，
// 需要一份能跑的 config.json。手改模板很容易漏填，这个向导负责：
//
//   ① 体检：Node 版本、依赖是否装好、三个外部依赖（SnowLuma / ComfyUI / DSH）通不通
//   ② **自动探测**：能从运行中的服务问到的一律自己填（DSH 端点与令牌、ComfyUI 地址、
//      SnowLuma 地址），减少人工输入与填错
//   ③ 只问必须人工知道的：你的 QQ 号（管理员）、要放行的群号
//   ④ 生成 config.json —— **已有配置绝不静默覆盖**，先备份并确认
//   ⑤ 收尾：打印下一步该做什么
//
// 用法：
//   node tools/setup-wizard.mjs --check          # 只体检，不写任何东西（可自动化验证）
//   node tools/setup-wizard.mjs --yes            # 用探测到的默认值生成配置（非交互）
//   node tools/setup-wizard.mjs                  # 交互式问答
//   node tools/setup-wizard.mjs --root <路径>    # 指定目标目录（沙箱测试用）
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = path.resolve(__dirname, '..');

// 目标目录可注入：与 uninstall-core / config-portability 同样的理由 ——
// 向导会**生成/覆盖 config.json**（被 gitignore、删了不可恢复），
// 测试必须能指向沙箱，绝不能默认写真实仓库。
function resolveRoot() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith('--root='));
  if (eq) return path.resolve(eq.slice('--root='.length));
  if (process.env.QB_SETUP_ROOT) return path.resolve(process.env.QB_SETUP_ROOT);
  return CODE_ROOT;
}
const TARGET = resolveRoot();

const CONFIG = path.join(TARGET, 'config.json');
const EXAMPLE = path.join(TARGET, 'config.example.json');
const ARCHIVE = path.join(TARGET, 'archive');

// ── 探测工具 ────────────────────────────────────────────────────────────────
function probePort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, '127.0.0.1'); } catch { fin(false); }
  });
}

async function httpGet(url, timeoutMs = 2500, headers = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(t);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// ── ① 体检 ──────────────────────────────────────────────────────────────────
async function healthCheck() {
  const report = { items: [], detected: {}, problems: [] };
  const add = (name, ok, detail, level = 'info') => {
    report.items.push({ name, ok, detail, level });
    if (!ok && level === 'error') report.problems.push(name);
  };

  // Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js 版本', major >= 20, `v${process.versions.node}${major >= 22 ? '（推荐）' : major >= 20 ? '（可用，建议 22+）' : '（过低，需要 20 以上）'}`,
    major >= 20 ? 'info' : 'error');

  // 依赖
  const nm = path.join(TARGET, 'node_modules');
  add('根依赖 node_modules', fs.existsSync(nm), fs.existsSync(nm) ? '已安装' : '未安装 —— 请先执行 npm install', fs.existsSync(nm) ? 'info' : 'error');
  const dnm = path.join(TARGET, 'desktop', 'node_modules');
  add('桌面版依赖 desktop/node_modules', fs.existsSync(dnm),
    fs.existsSync(dnm) ? '已安装' : '未安装 —— 桌面窗口需要它（cd desktop && npm install）', 'info');

  // 配置文件
  add('配置文件 config.json', fs.existsSync(CONFIG),
    fs.existsSync(CONFIG) ? '已存在（向导不会静默覆盖）' : '尚未创建 —— 向导可以生成', 'info');
  add('配置模板 config.example.json', fs.existsSync(EXAMPLE),
    fs.existsSync(EXAMPLE) ? '在' : '缺失！无法生成配置', fs.existsSync(EXAMPLE) ? 'info' : 'error');

  // SnowLuma（QQ 网关）
  const sl3000 = await probePort(3000);
  const sl3001 = await probePort(3001);
  add('SnowLuma QQ 网关', sl3000 || sl3001,
    sl3000 || sl3001 ? `在线（HTTP ${sl3000 ? '3000✓' : '3000✗'} / WS ${sl3001 ? '3001✓' : '3001✗'}）`
      : '未运行 —— 它是外部依赖，需自行准备（本包不含）', 'info');
  report.detected.snowluma = { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', online: sl3000 || sl3001 };

  // ComfyUI（出图）
  const comfy = await httpGet('http://127.0.0.1:8188/system_stats');
  add('ComfyUI 出图引擎', comfy.ok,
    comfy.ok ? '在线（8188 有响应）' : `未响应（${comfy.error ?? `HTTP ${comfy.status}`}）—— 外部依赖，需自行准备`,
    'info');
  report.detected.comfy = { host: 'http://127.0.0.1:8188', online: comfy.ok };

  // DSH（AI 宿主）：从管理器问出当前运行中的端点与令牌
  const mgr = await httpGet('http://127.0.0.1:3780/api/state');
  let dshFound = null;
  if (mgr.ok) {
    try {
      const state = JSON.parse(mgr.text);
      const running = (state.versions ?? []).find((v) => v.status === 'running');
      if (running?.url) {
        const m = running.url.match(/^(https?:\/\/[^/]+)\/?\?token=(.*)$/);
        if (m) dshFound = { baseUrl: m[1], token: m[2] };
      }
    } catch { /* 解析不了就当没找到 */ }
  }
  add('DSH AI 宿主', Boolean(dshFound),
    dshFound ? `已探测到端点与令牌（${dshFound.baseUrl}）` : 'DSH 未在运行（若要用 dsh 运行时需要它）',
    'info');
  report.detected.dsh = dshFound;

  // DSH 的 **SDK 依赖**是否装了 —— 这与"DSH 是否在跑"是两件事：
  //   装了 SDK + DSH 在跑  → 可以用 dsh 运行时
  //   没装 SDK            → 只能用 direct 运行时（安装时用 npm i --omit=optional 就会是这样）
  let sdkAvailable = false;
  try {
    const mod = await import('../src/dsh-client.js');
    sdkAvailable = mod.isDshSdkAvailable() === true;
  } catch (e) {
    sdkAvailable = false;
    report.sdkError = String(e?.message ?? e).split('\n')[0].slice(0, 160);
  }
  report.detected.dshSdk = sdkAvailable;
  add('DSH 的 SDK 依赖（可选）', true,
    sdkAvailable
      ? '已安装 —— dsh 与 direct 两种运行时都能选'
      : '未安装（可选依赖被跳过）—— 只能用 direct 运行时；想用 dsh 就重装依赖：npm install',
    'info');

  return report;
}

function printReport(report) {
  console.log('=== 环境体检 ===');
  console.log('');
  for (const it of report.items) {
    const mark = it.ok ? '✅' : (it.level === 'error' ? '❌' : '⚠️ ');
    console.log(`  ${mark} ${it.name}`);
    console.log(`      ${it.detail}`);
  }
  console.log('');
  if (!report.problems.length) {
    console.log('  ✅ 没有阻断性问题');
  } else {
    console.log(`  ❌ ${report.problems.length} 项需要先处理：${report.problems.join('、')}`);
  }
  console.log('');
}

// ── 交互输入 ────────────────────────────────────────────────────────────────
function makePrompter(nonInteractive) {
  const rl = nonInteractive ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question, fallback = '') {
      if (nonInteractive || !rl) return fallback;
      const hint = fallback ? ` [${fallback}]` : '';
      const answer = await new Promise((res) => rl.question(`  ${question}${hint}: `, res));
      const v = answer.trim();
      return v || fallback;
    },
    close() { try { rl?.close(); } catch {} }
  };
}

// ── ③ 生成配置 ──────────────────────────────────────────────────────────────
// 模板里的"示例预设"带占位文件名（如 `改成你的文件名.safetensors`）。
// 直接照抄进配置会留下地雷：用户选中那个预设就报错。所以生成时把它们剪掉并报告。
const PLACEHOLDER_RE = /(改成你的|请填|your[-_ ]?file|placeholder|xxx)/i;

function prunePlaceholders(cfg) {
  const removed = [];

  // 模型预设：unet / ckpt 指向占位文件名
  for (const [name, preset] of Object.entries(cfg.comfy?.models ?? {})) {
    const file = preset?.unet ?? preset?.ckpt ?? '';
    if (PLACEHOLDER_RE.test(String(file))) {
      delete cfg.comfy.models[name];
      removed.push(`模型预设「${name}」（文件名是占位符：${file}）`);
    }
  }
  // 剪完可能 defaultModel 指向了不存在的预设 —— 换成一个存在的
  const left = Object.keys(cfg.comfy?.models ?? {});
  if (cfg.comfy?.defaultModel && !left.includes(cfg.comfy.defaultModel)) {
    const prev = cfg.comfy.defaultModel;
    cfg.comfy.defaultModel = left[0] ?? '';
    removed.push(`默认模型从「${prev}」改为「${cfg.comfy.defaultModel || '(无可用预设)'}」`);
  }

  // 角色 LoRA：lora 字段是占位符
  for (const [name, entry] of Object.entries(cfg.comfy?.characterLoras ?? {})) {
    if (name.startsWith('_comment')) continue;
    if (PLACEHOLDER_RE.test(String(entry?.lora ?? ''))) {
      delete cfg.comfy.characterLoras[name];
      removed.push(`角色 LoRA「${name}」（指向占位文件）`);
    }
  }

  // 角色 LoRA 的 model 指向了已被剪掉的预设
  for (const [name, entry] of Object.entries(cfg.comfy?.characterLoras ?? {})) {
    if (name.startsWith('_comment')) continue;
    if (entry?.model && !left.includes(entry.model)) {
      removed.push(`角色 LoRA「${name}」原本指向已剪掉的预设「${entry.model}」，已改为「${cfg.comfy.defaultModel}」`);
      entry.model = cfg.comfy.defaultModel;
    }
  }

  return removed;
}

function buildConfig(template, answers) {
  const cfg = JSON.parse(JSON.stringify(template));
  if (answers.ownerQQ) {
    cfg.ownerQQ = String(answers.ownerQQ);
    // 管理员自己默认允许私聊（与模板语义一致：allow.private 是放行名单）
    const priv = new Set((cfg.allow?.private ?? []).map(String));
    priv.add(String(answers.ownerQQ));
    cfg.allow.private = [...priv];
  }
  if (answers.groups?.length) {
    const g = new Set((cfg.allow?.groups ?? []).map(String));
    for (const x of answers.groups) if (x) g.add(String(x));
    cfg.allow.groups = [...g];
  }
  if (answers.dshBaseUrl) cfg.dsh.baseUrl = answers.dshBaseUrl;
  if (answers.dshToken) cfg.dsh.authToken = answers.dshToken;
  // 运行时：dsh（需要 DSH 环境）或 direct（标准 AI API，不需要 DSH）。
  // 模板里默认为 dsh；选了 direct 就整段覆盖，并把 dsh 段留空（不再需要）。
  if (answers.runtime) {
    if (answers.runtime === 'direct') {
      cfg.runtime = {
        ...(cfg.runtime ?? {}),
        type: 'direct',
        baseUrl: answers.directBaseUrl,
        apiKey: answers.directApiKey ?? '',
        model: answers.directModel,
        maxTurns: 20,
        timeoutMs: 120000
      };
    } else {
      // type=dsh 时**删掉 direct 专用字段**：模板里带着它们（默认值），
      // 留着会在配置里显示一个空的 apiKey，让人以为"这里漏填了"。
      // 桥接侧对这些字段有默认值，删掉不影响。
      cfg.runtime = { type: 'dsh' };
    }
  }
  if (answers.comfyHost) cfg.comfy.host = answers.comfyHost;
  if (answers.comfyOutputDir) cfg.comfy.outputDir = answers.comfyOutputDir;
  if (answers.workspaceTitle) cfg.workspaceTitle = answers.workspaceTitle;
  return cfg;
}

function backupExisting() {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(ARCHIVE, `config.json.before-setup-${stamp}`);
  fs.copyFileSync(CONFIG, dest);
  return dest;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const nonInteractive = argv.includes('--yes');
  // --yes 模式下用参数把答案一次给全（脚本化安装用）；缺省则探测/留空
  const argValue = (name) => {
    const i = argv.indexOf(name);
    if (i !== -1 && argv[i + 1]) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    return eq ? eq.slice(name.length + 1) : '';
  };

  console.log('============================================================');
  console.log('  QQ 桥接 —— 首次配置向导');
  console.log('============================================================');
  console.log(`  目标目录: ${TARGET}`);
  console.log('');

  const report = await healthCheck();
  printReport(report);

  if (checkOnly) {
    console.log('（--check：只体检，未写入任何文件）');
    return report.problems.length ? 1 : 0;
  }

  if (!fs.existsSync(EXAMPLE)) {
    console.error('❌ 缺少 config.example.json，无法生成配置。请确认包完整。');
    return 1;
  }

  // 已有配置 → 不静默覆盖
  let overwrite = false;
  const prompt = makePrompter(nonInteractive);
  if (fs.existsSync(CONFIG)) {
    console.log('⚠️  已存在 config.json。');
    if (nonInteractive) {
      console.log('   --yes 模式下不覆盖已有配置（避免误伤）。要重建请先自行备份/删除。');
      prompt.close();
      return 0;
    }
    const ans = await prompt.ask('要重新生成吗？现有配置会先备份（y/N）', 'N');
    if (!/^y/i.test(ans)) {
      console.log('  已跳过配置生成。');
      prompt.close();
      return 0;
    }
    overwrite = true;
  }

  console.log('=== 请填写必要信息 ===');
  console.log('  （能从运行中的服务探测到的都已自动填好，直接回车即可）');
  console.log('');

  const d = report.detected;
  const answers = {};

  // 命令行给了就用命令行（--yes 脚本化场景），否则交互问
  const cliOwner = argValue('--owner-qq');
  const cliGroups = argValue('--groups');

  answers.ownerQQ = cliOwner || await prompt.ask('你的 QQ 号（管理员，机器人只认这个人的指令）', '');
  if (!/^\d{5,}$/.test(answers.ownerQQ)) {
    console.log('');
    console.log('⚠️  没有填写有效的 QQ 号 —— 生成配置后机器人将不认任何人，你随时可以手改 config.json 的 ownerQQ。');
  }

  const groupsRaw = cliGroups || await prompt.ask('要放行的群号（多个用逗号分隔，留空=不放行任何群）', '');
  answers.groups = groupsRaw.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));

  // ── 运行时选择：dsh（需要 DSH 环境）或 direct（标准 AI API，不需要 DSH）────────
  // 这是用户明确要求的"安装时让用户选是否用 DSH 环境"的落点。
  // 默认值按环境**推断**（装了 SDK 且 DSH 在跑 → 建议 dsh；否则建议 direct），
  // 而不是硬编码一个默认让用户去发现不对。
  const cliRuntime = String(argValue('--runtime') ?? '').toLowerCase();
  const suggestDsh = Boolean(d.dshSdk && d.dsh);
  const suggest = suggestDsh ? 'dsh' : 'direct';
  console.log('');
  console.log('  运行时：dsh = 挂在 DSH 上（功能最全，需要 DSH 环境）');
  console.log('          direct = 直接对接标准 AI API（OpenAI 兼容，**不需要 DSH**）');
  if (!suggestDsh) {
    console.log(`    （本机建议 direct：${d.dshSdk ? 'DSH 未在运行' : '未安装 DSH 的 SDK 依赖'}）`);
  }
  let runtime = cliRuntime;
  if (!['dsh', 'direct'].includes(runtime)) {
    const ans = await prompt.ask(`用哪种运行时？（dsh/direct）`, suggest);
    runtime = String(ans).trim().toLowerCase();
    if (!['dsh', 'direct'].includes(runtime)) runtime = suggest;
  }
  answers.runtime = runtime;

  if (runtime === 'direct') {
    console.log('');
    console.log('  direct 需要一处标准 AI API（OpenAI 兼容）。');
    const cliDirectBase = argValue('--direct-base-url');
    const cliDirectModel = argValue('--direct-model');
    answers.directBaseUrl = cliDirectBase || await prompt.ask('接口地址', 'https://api.deepseek.com/v1');
    answers.directModel = cliDirectModel || await prompt.ask('模型名', 'deepseek-chat');
    // ⚠️ 密钥刻意**不要求写在这里**，也不经过任何第三方：
    //    既支持直接输入（本地自用），也支持留空后自己填 config.json。
    answers.directApiKey = await prompt.ask('API key（可留空，稍后自己填进 config.json）', '');
    console.log('');
    console.log('  ⚠️ direct 目前只支持 chat 模式；二代仿真（reserved2）需要工具循环，尚未支持。');
  } else if (d.dsh) {
    console.log('');
    console.log(`  已自动探测到 DSH：${d.dsh.baseUrl}`);
    answers.dshBaseUrl = d.dsh.baseUrl;
    answers.dshToken = d.dsh.token;
  } else {
    console.log('');
    console.log('  ⚠️ 选了 dsh 但没探测到 DSH —— 稍后请手动填 config.json 的 dsh.baseUrl 与 dsh.authToken。');
  }

  answers.comfyHost = d.comfy?.host ?? 'http://127.0.0.1:8188';
  const cliOutDir = argValue('--comfy-output');
  const outDir = cliOutDir || await prompt.ask('ComfyUI 输出目录（可留空用模板默认）',
    readJsonSafe(EXAMPLE)?.comfy?.outputDir ?? '');
  answers.comfyOutputDir = outDir;

  prompt.close();

  // 写入（已有配置先备份）
  const template = readJsonSafe(EXAMPLE);
  if (!template) { console.error('❌ config.example.json 解析失败'); return 1; }
  const cfg = buildConfig(template, answers);
  const pruned = prunePlaceholders(cfg);
  if (pruned.length) {
    console.log('');
    console.log('=== 已剪掉模板里的占位预设（它们没有真实文件，留着会报错）===');
    for (const p of pruned) console.log(`  · ${p}`);
  }

  let backupPath = null;
  if (overwrite && fs.existsSync(CONFIG)) {
    backupPath = backupExisting();
    console.log('');
    console.log(`  已备份原配置：${backupPath}`);
  }

  try {
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(CONFIG, 'utf8')); // 立刻校验
  } catch (e) {
    console.error(`❌ 写入校验失败：${e?.message ?? e}`);
    if (backupPath) { fs.copyFileSync(backupPath, CONFIG); console.error('   已从备份还原'); }
    return 1;
  }

  console.log('');
  console.log('=== 配置已生成 ===');
  console.log(`  ${CONFIG}`);
  console.log(`  运行时        : ${cfg.runtime?.type ?? 'dsh'}`);
  console.log(`  ownerQQ      : ${cfg.ownerQQ || '（空 —— 机器人不会认任何人，请补填）'}`);
  console.log(`  放行的群      : ${(cfg.allow.groups ?? []).join(', ') || '（无）'}`);
  console.log(`  放行的私聊    : ${(cfg.allow.private ?? []).join(', ') || '（无）'}`);
  if ((cfg.runtime?.type ?? 'dsh') === 'direct') {
    const rt = cfg.runtime;
    console.log(`  AI 接口       : ${rt.baseUrl}`);
    console.log(`  AI 模型       : ${rt.model}`);
    console.log(`  AI key        : ${rt.apiKey ? `${String(rt.apiKey).slice(0, 4)}…（${String(rt.apiKey).length} 字符）` : '（空 —— 需补填，否则请求会 401）'}`);
    console.log('  注：direct 只支持 chat 模式；dsh.* 段已不再需要，可留空。');
  } else {
    console.log(`  DSH 端点      : ${cfg.dsh.baseUrl}${cfg.dsh.authToken ? '（含令牌）' : '（⚠️ 无令牌，需补填）'}`);
  }
  console.log(`  ComfyUI       : ${cfg.comfy.host}`);
  console.log(`  出图模型      : ${Object.keys(cfg.comfy.models ?? {}).join(', ')}`);

  console.log('');
  console.log('=== 下一步 ===');
  const steps = [];
  if (!fs.existsSync(path.join(TARGET, 'node_modules'))) steps.push('在本目录执行：npm install');
  if (!fs.existsSync(path.join(TARGET, 'desktop', 'node_modules'))) steps.push('想要桌面窗口：cd desktop && npm install');
  if (!cfg.ownerQQ) steps.push('补填 config.json 的 ownerQQ（否则机器人不认任何人）');
  if ((cfg.runtime?.type ?? 'dsh') === 'direct') {
    if (!cfg.runtime.apiKey) steps.push('补填 config.json 的 runtime.apiKey（否则 AI 请求会 401）');
  } else if (!cfg.dsh.authToken) {
    steps.push('补填 config.json 的 dsh.authToken');
  }
  steps.push('启动全部服务：powershell -ExecutionPolicy Bypass -File tools\\qq-bridge-launcher.ps1 -Action startAll');
  steps.push('想要桌面窗口：npm run desktop（或运行 tools\\create-app-shortcut.ps1 建桌面快捷方式）');
  steps.push('想做系统级卸载入口：npm run uninstall:register');
  for (const [i, s] of steps.entries()) console.log(`  ${i + 1}. ${s}`);

  return 0;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main().then((code) => process.exit(code));

export { healthCheck, buildConfig, resolveRoot, TARGET };
