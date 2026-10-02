// 启动脚本：校验运行环境 → 找到 Electron → 拉起桌面窗口。
//
// 之所以不直接在 package.json 里写 `electron .`：
//   1. 需要给出**可操作的中文提示**（没装 Electron 时告诉用户怎么办，而不是一串英文栈）
//   2. 需要校验 Node 版本（本项目用 node:sqlite 等较新特性）
//   3. 需要确认在仓库根目录运行（否则相对路径全错）
//
// ⚠️ 第一步就做环境变量净化（见下方 sanitizeEnv），因为继承来的 Node 专用变量会让
//    Electron 启动即崩（静默、零日志）。这段必须在任何实质工作之前执行。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ── 0. 环境变量净化（最先执行）───────────────────────────────────────────────
// 实测（2026-09-25）：Electron 启动即崩、退出码 0x80000003、零输出零日志 —— 根因是
// 继承的 NODE_OPTIONS 里带了 `--require worker-events.cjs`（DSH 为它自己的 Node 工具注入，
// 该模块在 D:\DSH\compat\ 靠 NODE_PATH 解析）。Electron 主进程的 Node 预加载阶段解析不到
// → 主进程崩溃。对照实验：清空 NODE_OPTIONS 后 `electron.exe --no-sandbox --version`
// 立即返回 v44.4.5（退出码 0）。
//
// 这些变量只对「被 DSH 拉起的 Node 工具」有意义，对 Electron 只有破坏作用，因此一律剔除。
// 剔除内容会打印出来，便于一眼确认净化是否生效。
const SANITIZE_ENV = ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'];
const childEnv = { ...process.env };
const sanitized = [];
for (const key of SANITIZE_ENV) {
  const value = childEnv[key];
  if (value) { sanitized.push({ key, value }); delete childEnv[key]; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = __dirname;
const ROOT = path.resolve(DESKTOP, '..');
const require = createRequire(import.meta.url);

function fail(msg, hint) {
  console.error(`\n[desktop] ${msg}`);
  if (hint) console.error(`         ${hint}`);
  process.exit(1);
}

// ── 1. Node 版本 ────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 20) {
  fail(`Node 版本过低（当前 ${process.versions.node}）`, '桌面版需要 Node 20 或更高；推荐直接用 DSH 自带的 node。');
}

// ── 2. 定位 Electron ────────────────────────────────────────────────────────
function findElectronBinary() {
  // require('electron') 在 Node 下返回可执行文件路径字符串
  try {
    const p = require('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {}
  // 退路：直接从 node_modules 里找
  const candidates = [
    path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(DESKTOP, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const electronBin = findElectronBinary();
if (!electronBin) {
  fail('没有找到 Electron（桌面窗口的运行环境）。',
    '在 desktop 目录下执行安装：cd desktop && npm install\n'
    + '          安装内容约 150 MB，只需装一次。若网络受限，可设置镜像：npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/');
}

// ── 3. 准备干净的 userData 目录 ─────────────────────────────────────────────
//
// 为什么不让它用默认的 %APPDATA%\qq-bridge-desktop：
//   实测（scripts/probe-desktop-launch.mjs）7 组启动开关**全部成功**，包括
//   "不加任何开关"的默认组 —— 说明 GPU 开关不是关键，真正的变量是每组都用了
//   独立的 --user-data-dir。而默认目录里曾经留下损坏且被占用的缓存
//   （日志：Failed to open persistent cache ... (0x20 另一个程序正在使用此文件)），
//   导致 Chromium 反复起不来 GPU 进程并最终 "GPU process isn't usable. Goodbye."。
//
// 因此固定用一个项目内的 userData 目录，并在每次启动前清掉其中的缓存子目录。
//
// 覆盖：`QB_USER_DATA_DIR` 可指定另一个 userData 目录。用途是 **UI 探针** ——
// main.mjs 用了 app.requestSingleInstanceLock()，若探针与正在运行的实例共用同一个
// userData，第二个实例会直接被锁拒掉（实测：探针呼起后 desktop.log 只有一行"启动中"
// 就再无下文）。探针改用一个 **纯 ASCII 的临时目录**，既避开单实例锁，也避开
// "中文路径下 Electron 静默失败"这个已知坑。
const USER_DATA = process.env.QB_USER_DATA_DIR
  ? path.resolve(process.env.QB_USER_DATA_DIR)
  : path.join(ROOT, 'state', 'electron-profile');
const CACHE_DIRS = ['GPUPersistentCache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Cache', 'Code Cache', 'ShaderCache'];

function prepareUserData() {
  const removed = [];
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    for (const name of CACHE_DIRS) {
      const target = path.join(USER_DATA, name);
      if (fs.existsSync(target)) {
        try { fs.rmSync(target, { recursive: true, force: true }); removed.push(name); } catch {}
      }
    }
  } catch {}
  return removed;
}

const cleared = prepareUserData();
console.log(`[desktop] 仓库根目录: ${ROOT}`);
console.log(`[desktop] userData: ${USER_DATA}`);
if (cleared.length) console.log(`[desktop] 已清理缓存目录：${cleared.join(', ')}`);

// --check：只跑到这里就退出（不拉起 Electron）。
// 用途：在没有桌面会话的环境（CI / 我的沙箱）里验证本脚本的**运行期**逻辑 ——
// 语法检查查不出「用了未定义的变量」这类错误，曾经因此漏掉一个 ROOT 未定义的 bug。
if (sanitized.length) {
  for (const { key, value } of sanitized) {
    console.log(`[desktop] 已剔除环境变量（其 --require 会让 Electron 启动即崩）：${key}=${value}`);
  }
} else {
  console.log('[desktop] 环境变量无需净化（未发现 NODE_OPTIONS / NODE_PATH / ELECTRON_RUN_AS_NODE）');
}

if (process.argv.includes('--check')) {
  console.log('[desktop] --check 通过：环境校验与目录准备均正常，未拉起 Electron。');
  process.exit(0);
}

// ── 4. 拉起 ─────────────────────────────────────────────────────────────────
console.log('[desktop] 启动 QQ 桥接桌面控制台…');
const child = spawn(electronBin, [DESKTOP, `--user-data-dir=${USER_DATA}`], {
  cwd: DESKTOP,
  stdio: 'inherit',
  windowsHide: false,
  env: childEnv
});

child.on('error', (error) => fail(`启动 Electron 失败：${error?.message ?? error}`));
child.on('close', (code) => {
  // 非零退出时提示去看日志 —— 窗口崩溃时用户往往没看到报错
  if (code !== 0) {
    console.error(`\n[desktop] Electron 退出码 ${code}。`);
    const logFile = path.join(ROOT, 'state', 'desktop.log');
    if (fs.existsSync(logFile)) {
      console.error(`[desktop] 启动日志尾部（完整内容见 ${logFile}）：`);
      try {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        for (const line of lines.slice(-8)) console.error(`         ${line}`);
      } catch {}
    } else {
      console.error('[desktop] 没有生成启动日志 —— 说明 Electron 在加载应用代码之前就退出了。');
      console.error('[desktop] 常见原因：① 继承了带 --require 的 NODE_OPTIONS（本脚本已自动剔除）；');
      console.error('[desktop]           ② 缺少桌面会话（远程/无头环境）；③ 显卡驱动异常；④ 安全软件拦截。');
    }
  }
  process.exit(code ?? 0);
});
