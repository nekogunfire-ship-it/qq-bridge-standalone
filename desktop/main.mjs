// QQ 桥接桌面版：Electron 主进程。
//
// 职责划分（刻意保持简单，避免和桥接的控制台抢职责）：
//   - 窗口/托盘生命周期
//   - 通过 tools/qq-bridge-launcher.ps1 做启停（不自己 spawn node，复用权威启动器）
//   - 自动检查（desktop/lib/health.js）、自动保存（settings.js）
//   - 把结果通过 IPC 交给渲染层展示
//
// 服务本身仍然跑在桥接里（127.0.0.1:3100），本窗口只是前端 + 生命周期管理。
import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { healthCheck, readConfig, readConsoleToken, probePort } from './lib/health.js';
import { launcherStatus, launcherDiagnose, launcherStartAll, launcherStopAll, launcherRestartAll, launcherRestartBridgeOnly, launcherStartComfy, launcherStopComfy } from './lib/launcher.js';
import { comfySetupStatus, startComfyInstall, startModelInstall, cancelComfySetup, readComfyInstall } from './lib/comfy-manager.js';
import { loadSettings, saveSettings, SETTINGS_PATH } from './lib/settings.js';
import { startLifecycleRun, readLifecycleLog } from './lib/lifecycle-log.js';
import { readDshRestartLog } from './lib/dsh-watch.js';
import { findDownServices, decideWatchdog, isScriptWatchdogAlive } from './lib/watchdog.js';
import { runUiProbe, collectOnce, summarize } from './lib/ui-probe.js';
import { readRuntimeApiKey, readRuntimeConfig, writeRuntimeConfig } from './lib/runtime-config.js';
import { DirectRuntime } from '../src/agent-runtime/direct.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ComfyUI 的路径与地址都从既有配置读，不在这里硬编码：
//   comfyDir → tools/services.json（启动器也用同一份，改一处全生效）
//   host     → config.json 的 comfy.host（桥接出图用的地址，保持一致）
function readComfyDir() {
  try {
    const managed = readComfyInstall(ROOT)?.installDir;
    if (managed) return managed;
  } catch {}
  try {
    const services = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'services.json'), 'utf8'));
    if (services?.comfyDir) return services.comfyDir;
  } catch {}
  return 'E:\\comfyui';
}

function readComfyHost() {
  try {
    const cfg = readConfig(ROOT);
    if (cfg?.comfy?.host) return cfg.comfy.host.replace(/\/+$/, '');
  } catch {}
  return 'http://127.0.0.1:8188';
}
const CONSOLE_URL = 'http://127.0.0.1:3100/';

// ── 启动前的 Chromium 开关（必须在 app ready 之前设置）────────────────────────
//
// 背景：本机首次启动时 Chromium 的 GPU 进程反复启动失败（error_code=18），随后
// 判定 "GPU process isn't usable. Goodbye." 直接终止整个应用；同时它在
// %APPDATA%\qq-bridge-desktop\GPUPersistentCache 下的缓存目录被占用（0x20），
// 进一步加剧失败。
//
// 本窗口只渲染状态卡片与文本，完全不需要 GPU 加速，因此直接禁用：
//   - disableHardwareAcceleration()：Electron 层不启用加速合成
//   - disable-gpu / disable-gpu-compositing：不走 GPU 路径与 GPU 合成
//   - disable-gpu-sandbox：避开受限/虚拟化环境里 GPU 沙箱起不来的问题
//
// ⚠️ 刻意**不加** in-process-gpu：它把 GPU 初始化放进主进程，一旦失败会直接终止
// 整个应用（表现为 "GPU process isn't usable. Goodbye." 后窗口一闪即没）。
// 保持 GPU 在独立进程里，失败时 Chromium 才能降级到软件渲染。
const FORCE_SOFTWARE = process.env.QQ_BRIDGE_GPU !== '1';
if (FORCE_SOFTWARE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// ── 渲染沙箱开关（实测必需，别删）────────────────────────────────────────────
// 症状：控制台独立窗口一开就黑，日志是
//   「渲染进程结束：reason=launch-failed exitCode=18」——12 毫秒内渲染进程就起不来。
// 定位过程：用外部 Electron 探针加载同一个控制台地址，**同一台机器、同样提权**下渲染完美；
// 逐个对比两者差异，唯一剩下的就是命令行开关 —— 探针带了 `--no-sandbox`，而应用没带。
// （已排除：GPU 开关组、webPreferences.sandbox、X-Frame-Options、CSP、跨源、页面本身。）
//
// 为什么可以接受：这是本机自用的管理工具，页面来源只有两个 —— 打包在本地的渲染层
// （file://）与本机桥接（127.0.0.1:3100）。禁用渲染沙箱把攻击面限制在这两个受信来源上。
app.commandLine.appendSwitch('no-sandbox');

// 启动诊断日志：写到 state/desktop.log。
// 为什么需要：GUI 崩溃时用户往往只来得及看到窗口一闪，而我（远程排查）拿不到控制台输出。
// 有了这个文件，任何启动失败都能事后读取，不必依赖用户复制粘贴。
const LOG_FILE = path.join(ROOT, 'state', 'desktop.log');
function dlog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {}
  console.log(`[desktop] ${message}`);
}

/**
 * 真发一次最小请求，验证"端点 / key / 模型名"能不能用。
 *
 * 只做**一次普通对话请求**，不测工具调用 —— 那要起 3 个 MCP 子进程，对界面上的
 * "测连接"按钮太重了。需要深测（含"模型会不会调工具"）用：
 *     node tools/check-direct-runtime.mjs --tools
 * 界面上"先测再存"能省掉"存了 → 重启 → 才发现 key 不对"的来回。
 *
 * ⚠️ apiKey 只在这里用一次，**不落日志、不进渲染层**。
 */
async function probeDirect({ baseUrl, model, apiKey }) {
  const rt = new DirectRuntime({
    baseUrl,
    apiKey,
    model,
    systemPrompt: '你是连通性测试助手。',
    timeoutMs: 30_000,      // 界面上的按钮不该让人等两分钟
    log: () => {}
  });
  const t0 = Date.now();
  let r = await rt.send({ key: '__ui_runtime_test__', text: '回复两个字：收到' });
  // 偶发网络/证书失败重试一次。
  // 动机（2026-09-26 实测）：用户机器上有安全软件拦截 HTTPS，证书错误**偶发** ——
  // 模型检测第一次运行就撞上 `SELF_SIGNED_CERT_IN_CHAIN`，而同一个请求再发一次就好了。
  // **把偶发失败直接呈现给用户，等于制造假故障。**
  if (!r.ok && isRetryableText(String(r.error ?? ''))) {
    dlog(`「测试连接」首次失败（${String(r.error).slice(0, 60)}），自动重试一次`);
    r = await rt.send({ key: '__ui_runtime_test__', text: '回复两个字：收到' });
  }
  const latencyMs = Date.now() - t0;
  if (!r.ok) return { ok: false, error: r.error, hint: r.hint ?? null, latencyMs };
  return {
    ok: true,
    latencyMs,
    reply: String(r.text ?? '').slice(0, 60),
    usage: r.usage ?? null
  };
}

// ── 网络错误的分类与重试（模型检测 / 测试连接 / 切换模型 共用）──────────────────
//
// ⚠️ 这几段**必须放在模块顶层**：`probeDirect`（上面）在顶层，而它们原来写在
//    `app.whenReady` 那一层的块里 —— 那样 `probeDirect` 调不到，会是 ReferenceError。
//    （我在这个项目上已经因为"函数写在块里、在外面调用"崩过一次，见 direct 的
//     `buildDirectSystemPrompt` 那次。）

/**
 * 识别证书类错误。
 * ⚠️ `direct.js` 与 `tools/check-direct-runtime.mjs` **早就有**同样的判断，
 * 我写模型检测时**忘了复用** —— 于是那次证书失败走了通用兜底「检查接口地址、网络与代理设置」，
 * 对用户毫无帮助（真正该说的是"安全软件在拦 HTTPS"）。**检测功能第一次运行就抓到了这个不一致。**
 */
function isCertError(text) {
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|certificate/i.test(String(text ?? ''));
}

/** 网络类错误 → **可操作的下一步**（只说"检测失败"等于没说） */
function classifyNetError(error) {
  const code = error?.cause?.code ?? error?.code ?? '';
  const msg = String(error?.message ?? error);
  if (isCertError(msg) || isCertError(code)) {
    return '证书校验失败 —— 安全软件（卡巴斯基等）在拦截 HTTPS。'
      + '两种办法：① 在该软件里放行这个 API 域名；② 让 Node 信任系统证书（启动参数加 --use-system-ca）';
  }
  if (code === 'ENOTFOUND') return '域名解析不了 —— 检查接口地址拼写与网络/代理';
  if (code === 'ECONNREFUSED') return '端点没人监听 —— 本地模型服务是不是没启动？';
  if (/timeout|ETIMEDOUT|TimeoutError/i.test(`${msg} ${error?.name ?? ''}`)) {
    return '请求超时 —— 网络慢或被墙，也可能是代理没配';
  }
  return '检查接口地址、网络与代理设置';
}

/** 同上，但直接吃字符串（`DirectRuntime` 的错误是以字符串返回的，不是 Error） */
function isRetryableText(text) {
  const t = String(text ?? '');
  // 证书拦截是**偶发**的（实测同一个请求重发就好），值得重试；
  // 域名解析不了 / 没人监听 是确定性问题，重试没意义。
  if (isCertError(t)) return true;
  return /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|fetch failed/i.test(t);
}

/** 这个错误值不值得重试（偶发性 vs 确定性） */
function isRetryable(error) {
  if (typeof error === 'string') return isRetryableText(error);
  return isRetryableText(`${error?.message ?? error} ${error?.cause?.code ?? error?.code ?? ''}`);
}

/** 带重试的 fetch（默认重试 1 次）—— 理由见 `probeDirect` 里的注释 */
async function fetchWithRetry(url, options, { retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryable(error)) throw error;
      dlog(`网络请求失败（${error?.cause?.code ?? error?.message}），自动重试一次`);
    }
  }
  throw lastError;
}

// 清掉可能残留（被占用/损坏）的 GPU 缓存目录，避免它把启动拖垮。
function cleanGpuCache() {  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'qq-bridge-desktop');
  const targets = [
    path.join(base, 'GPUPersistentCache'),
    path.join(base, 'Cache'),
    path.join(base, 'Code Cache'),
    path.join(base, 'GPUCache'),
    path.join(base, 'DawnGraphiteCache'),
    path.join(base, 'DawnWebGPUCache')
  ];
  const cleaned = [];
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); cleaned.push(path.basename(t)); }
    } catch { /* 被占用就跳过，不影响启动 */ }
  }
  return cleaned;
}

let mainWindow = null;
let consoleWindow = null; // 「聊天与出图」独立窗口（复用同一个，不重复开）
let tray = null;
let quitting = false;
let busyAction = null; // 正在执行的启停动作，避免重复点击
let watchdogTimer = null; // 看门狗定时器（主进程侧，见下方 startWatchdog）
let watchdogLastRunAt = 0; // 上次自动拉起的时间戳，用于冷却

// ── 看门狗：关键服务不在时自动拉起 ──────────────────────────────────────────
//
// 为什么需要：实测到桥接会在 `SnowLuma 连接断开（code=1006）` 之后**自己消失**
// （进程退出、bridge.log 无崩溃记录），结果机器人**静默掉线**，用户毫不知情。
// 这类"没被察觉的失效"最适合自动兜住。
//
// 为什么放在主进程：界面上的「自动检查」跑在渲染层（renderer 的 setInterval），
// 而窗口收进托盘后 Chromium 会**节流/暂停**渲染层的定时器 —— 恰恰在"窗口关着、
// 最需要看门狗"的时候它会睡着。所以这里用主进程的定时器。
//
// 安全阀：① **脚本级看门狗在跑时一律礼让**（它更完善，避免重复重启）；
//         ② 冷却时间（默认 180s）内不重复拉起；③ 有生命周期动作在执行时不插手；④ 可整体关掉。
// 判定逻辑在 desktop/lib/watchdog.js（单独成模块以便单测那几项边界）。
async function watchdogTick() {
  const settings = loadSettings();
  const down = await findDownServices();
  const verdict = decideWatchdog({
    down,
    settings,
    lastRunAt: watchdogLastRunAt,
    busy: busyAction,
    quitting,
    scriptWatchdogAlive: isScriptWatchdogAlive(ROOT, fs)
  });

  if (verdict.action === 'skip') {
    // 只在"确实有服务掉线但这次不拉起"时记一行，避免每 30 秒刷无意义的日志
    if (down.length) dlog(`看门狗：${verdict.reason}（掉线：${down.map((d) => d.label).join(' / ')}）`);
    return;
  }

  const names = down.map((d) => d.label).join(' / ');
  watchdogLastRunAt = Date.now();
  dlog(`看门狗：检测到 ${names} 不在监听，自动尝试拉起`);
  try {
    // startAll 是幂等的：已在运行的服务会被启动器跳过
    await runLifecycle('startAll', { silent: true });
    dlog('看门狗：已发起一键启动');
  } catch (error) {
    dlog(`看门狗：拉起失败 ${error?.message ?? error}`);
  }
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  const settings = loadSettings();
  // 探测间隔固定 30 秒（比界面上的自动检查更勤），是否启用由设置控制
  watchdogTimer = setInterval(() => { watchdogTick().catch(() => {}); }, 30_000);
  dlog(`看门狗已启动：${settings.watchdogEnabled ? '启用' : '停用'}，每 30s 探测一次，冷却 ${settings.watchdogCooldownSeconds}s`);
  // 启动后先等一会儿再首次探测，避免与应用启动抢资源
  setTimeout(() => { watchdogTick().catch(() => {}); }, 20_000);
}

// ── 单实例：第二次启动时聚焦已有窗口 ────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function trayIcon(preferSmall = false) {
  // 用仓库里自己的图标（`tools/gen-app-icon.mjs` 生成；想换图直接覆盖那两个 PNG）。
  // ⚠️ 这里**不再引用 DSH 的图标** —— 那既是"与 DSH 绑着"的残留，
  //   又是个**已经失效**的引用：原候选 dsh-0.1.13.ico / assets/icon.png /
  //   public/favicon.ico **在仓库里一个都不存在**，于是 Tray 一直拿到
  //   `nativeImage.createEmpty()` —— 托盘上其实是**空图标**。
  const big = path.join(ROOT, 'assets', 'app-icon.png');
  const small = path.join(ROOT, 'assets', 'tray-icon.png');
  const candidates = preferSmall ? [small, big] : [big, small];
  candidates.push(path.join(ROOT, 'public', 'favicon.ico'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const img = nativeImage.createFromPath(c);
        if (!img.isEmpty()) return img;
      }
    } catch {}
  }
  return nativeImage.createEmpty();
}

function createWindow() {
  const settings = loadSettings();
  mainWindow = new BrowserWindow({
    width: settings.window?.width ?? 1180,
    height: settings.window?.height ?? 780,
    minWidth: 820,
    minHeight: 600,
    title: 'QQ 桥接控制台',
    backgroundColor: '#0f1420',
    icon: trayIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 渲染层是本机受信页面，但仍保持最小权限
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  attachRendererDiagnostics(mainWindow, '主窗口');

  // UI 探针模式（QB_UI_PROBE=1）：截图 + 几何采集 + 依赖装配检查，落盘后自动退出。
  // 用途：改完界面后由 AI 自己验证渲染结果，不必每次都让用户当眼睛。
  // 由 scripts/probe-ui.ps1 提权调用（本机 electron.exe 只能提权跑）。
  if (process.env.QB_UI_PROBE === '1') {
    dlog('[ui-probe] 进入探针模式');
    runUiProbe(mainWindow, { root: ROOT, log: dlog })
      .then(({ reportTxt }) => {
        dlog(`[ui-probe] 完成，报告：${reportTxt}`);
      })
      .catch((e) => dlog(`[ui-probe] 失败：${e?.message ?? e}`))
      .finally(() => { quitting = true; app.quit(); });
  }

  // 记住窗口尺寸（自动保存的一部分）
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    saveSettings({ window: { width: b.width, height: b.height } });
  };
  mainWindow.on('resize', debounce(persistBounds, 800));
  mainWindow.on('close', (e) => {
    // 关闭 = 收进托盘（真退出走托盘菜单），符合"常规应用"的预期
    if (!quitting) {
      e.preventDefault();
      persistBounds();
      mainWindow.hide();
    }
  });

  // 外部链接交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  return mainWindow;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

function createTray() {
  tray = new Tray(trayIcon(true));   // 托盘用 32px 那张，小尺寸更锐
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '打开网页控制台', click: () => shell.openExternal(CONSOLE_URL).catch(() => {}) },
    { type: 'separator' },
    { label: '一键启动全部服务', click: () => runLifecycle('startAll') },
    { label: '一键重启全部服务', click: () => runLifecycle('restartAll') },
    { label: '停止全部服务', click: () => runLifecycle('stopAll') },
    { type: 'separator' },
    // 显式的重启/退出入口：此前只有「退出」且窗口关闭是收进托盘，
    // 用户找不到重启方式（实测反馈"怎么重开应用"）—— 这两个菜单项补上这个缺口。
    { label: '重启应用（加载界面改动）', click: () => relaunchApp() },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setToolTip('QQ 桥接控制台（双击显示窗口）');
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// 重启桌面应用本身（不是重启服务）。用于加载渲染层/主进程的代码改动。
function relaunchApp() {
  dlog('用户请求重启应用');
  quitting = true;
  app.relaunch();
  app.exit(0);
}

// 故障定位提示：把"渲染进程为什么会挂"的原因直接写进日志。
// 起因：控制台独立窗口打开后 12 毫秒就出现
//   「渲染进程结束：reason=launch-failed exitCode=18」
// 而界面全黑 —— 但没有任何地方记录"是谁挂的、挂的时候是什么环境"。
// 这里把 webContents 的事件、进程类型、以及关键的 GPU 相关环境变量一起落盘，
// 免得每次只能靠外部探针反推。
function attachRendererDiagnostics(win, label) {
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => {
    dlog(`[${label}] 页面加载失败 code=${code} desc=${desc} url=${url}`);
  });
  wc.on('did-finish-load', () => {
    dlog(`[${label}] 页面加载完成 ${wc.getURL()}`);
    // 页面加载完成后取一次渲染指标 —— 诊断"窗口开着但一片黑"时要区分
    // "DOM 没渲染"与"渲染了但没画出来"，这些数字能直接说明问题。
    //
    // 主窗口升级为**完整布局采集**（分区可见性 / 关键元素几何 / 溢出 / 依赖装配），
    // 并落盘 state/ui-report.json。这样 AI 只靠"用户重启一次应用"就能验证界面改动，
    // 不必再跑需要提权的独立探针（那要弹 UAC，实测用户会取消）。
    setTimeout(async () => {
      try {
        if (label === '主窗口') {
          const data = await collectOnce(win);
          dlog(`[${label}] 布局采集 ${summarize(data)}`);
          try {
            fs.writeFileSync(
              path.join(ROOT, 'state', 'ui-report.json'),
              JSON.stringify({ at: new Date().toISOString(), label, data }, null, 2),
              'utf8'
            );
          } catch (e) {
            dlog(`[${label}] ui-report.json 写入失败：${e?.message ?? e}`);
          }
          return;
        }
        const probe = await wc.executeJavaScript(`(() => {
          const b = document.body;
          const main = document.querySelector('main');
          const cs = main ? getComputedStyle(main) : null;
          const rect = main ? main.getBoundingClientRect() : null;
          return {
            title: document.title,
            readyState: document.readyState,
            textLen: b ? (b.innerText || '').length : -1,
            bodyH: b ? b.scrollHeight : -1,
            mainDisplay: cs ? cs.display : null,
            mainVisibility: cs ? cs.visibility : null,
            mainOpacity: cs ? cs.opacity : null,
            mainSize: rect ? (Math.round(rect.width) + 'x' + Math.round(rect.height)) : null
          };
        })()`);
        dlog(`[${label}] 渲染检查 ${JSON.stringify(probe)}`);
      } catch (error) {
        dlog(`[${label}] 渲染检查失败：${error?.message ?? error}`);
      }
    }, 2500);
  });
  wc.on('render-process-gone', (_e, details) => {
    dlog(`[${label}] 渲染进程结束：reason=${details?.reason} exitCode=${details?.exitCode}`);
  });
  wc.on('preload-error', (_e, preloadPath, error) => {
    dlog(`[${label}] preload 出错 ${preloadPath}：${error?.message ?? error}`);
  });
  wc.on('console-message', (_e, level, message, line, source) => {
    // 只记警告与错误，避免日志被普通输出淹没
    if (level >= 2) dlog(`[${label}] 页面控制台[${level}] ${String(message).slice(0, 220)} (${source}:${line})`);
  });
}

// ── 「聊天与出图」独立窗口 ──────────────────────────────────────────────────
// 为什么不用 iframe 内嵌：iframe 同时受 X-Frame-Options、CSP frame-src、以及
// file:// 源与 http://127.0.0.1 跨源三重限制，实测在 Electron 里持续表现为
// 「load 事件不触发 + 纯黑」（而服务端响应头已确认正确）。把控制台当**顶层页面**
// 加载就没有这些限制，且能与管理窗口并排、自由缩放。
//
// 带令牌进入：控制台支持 ?token=，会在页面内记住并用于后续 x-console-token 头。
function consoleUrlWithToken() {
  const token = readConsoleToken(ROOT);
  const query = new URLSearchParams({ embed: '1' });
  if (token) query.set('token', token);
  return `${CONSOLE_URL}?${query.toString()}`;
}

function openConsoleWindow() {
  const url = consoleUrlWithToken();
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    try {
      consoleWindow.loadURL(url); // 重新加载以带上可能已变化的令牌
      consoleWindow.show();
      consoleWindow.focus();
      dlog('控制台窗口已存在，重新加载并聚焦');
      return { ok: true, reused: true };
    } catch (error) {
      dlog(`复用控制台窗口失败：${error?.message ?? error}`);
    }
  }
  try {
    consoleWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 520,
      minHeight: 420,
      title: 'QQ 桥接控制台 · 聊天与出图',
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      icon: undefined,
      webPreferences: {
        // 这是**外部页面**（桥接提供），不需要任何 Node 能力
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    consoleWindow.on('closed', () => { consoleWindow = null; dlog('控制台窗口已关闭'); });
    attachRendererDiagnostics(consoleWindow, '控制台窗口');
    dlog(`[控制台窗口] 加载 ${url.replace(/token=[^&]*/, 'token=***')} | GPU开关=${FORCE_SOFTWARE ? '已施加(软件渲染)' : '未施加(保留GPU)'} | QQ_BRIDGE_GPU=${process.env.QQ_BRIDGE_GPU ?? '(未设)'}`);
    consoleWindow.loadURL(url);
    dlog('已打开控制台窗口（独立窗口加载控制台页面）');
    return { ok: true, reused: false };
  } catch (error) {
    dlog(`打开控制台窗口失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── IPC：把主进程能力暴露给渲染层（白名单式，不做通用转发）──────────────────
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    root: ROOT,
    consoleUrl: CONSOLE_URL,
    settingsPath: SETTINGS_PATH,
    busy: busyAction
  }));

  ipcMain.handle('health:check', async () => healthCheck(ROOT, { comfyInstalled: comfySetupStatus(ROOT).installed }));

  ipcMain.handle('launcher:status', async () => launcherStatus(ROOT));
  ipcMain.handle('launcher:diagnose', async () => launcherDiagnose(ROOT));
  // 生命周期时间线：点过重启后可以看它到底跑了多久（排障用）
  ipcMain.handle('lifecycle:log', () => readLifecycleLog(80));
  // DSH 重启记录：端点变化与中断时长（用户抱怨过两次"掉线"，这样能直接看到而不是翻 manager.log）
  ipcMain.handle('dsh:restartLog', () => readDshRestartLog(60));

  // 打开「聊天与出图」的独立控制台窗口（复用同一个窗口）。
  // 不再用 iframe 内嵌 —— 原因见 openConsoleWindow 上方的注释。
  ipcMain.handle('console:openWindow', () => openConsoleWindow());

  ipcMain.handle('lifecycle:run', async (_evt, action) => {
    if (busyAction) return { ok: false, error: `正在执行「${busyAction}」，请稍候` };
    return runLifecycle(action);
  });

  // ComfyUI 单独走一对动作：它不进 startAll 的失败判定（可选服务），而且要等
  // 30~60 秒加载底模才监听 8188，所以超时预算与主链路不同。走同一套时间线，
  // 这样"什么时候点了、花了多久"和别的动作一样可追溯。
  ipcMain.handle('comfy:start', async () => {
    if (busyAction) return { ok: false, error: `正在执行「${busyAction}」，请稍候` };
    return runLifecycle('comfyStart');
  });
  ipcMain.handle('comfy:stop', async () => {
    if (busyAction) return { ok: false, error: `正在执行「${busyAction}」，请稍候` };
    return runLifecycle('comfyStop');
  });
  ipcMain.handle('comfy:setupStatus', () => comfySetupStatus(ROOT));
  ipcMain.handle('comfy:install', (_evt, options) => startComfyInstall(ROOT, options ?? {}));
  ipcMain.handle('comfy:installModel', (_evt, options) => startModelInstall(ROOT, options ?? {}));
  ipcMain.handle('comfy:cancelSetup', () => cancelComfySetup());

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_evt, patch) => {
    const next = saveSettings(patch ?? {});
    // 看门狗的启用/冷却时间改动要立刻生效，不必重启应用
    if (patch && ('watchdogEnabled' in patch || 'watchdogCooldownSeconds' in patch)) {
      watchdogLastRunAt = 0;
      startWatchdog();
    }
    broadcast('settings:changed', next);
    return next;
  });

  // 常用动作：打开目录 / 打开配置 / 打开外部界面
  ipcMain.handle('shell:openPath', async (_evt, which) => {
    const map = {
      root: ROOT,
      config: path.join(ROOT, 'config.json'),
      state: path.join(ROOT, 'state'),
      // 模型目录、ComfyUI 安装目录都从 tools/services.json / bridge 配置读，别再硬编码路径
      models: path.join(readComfyDir(), 'ComfyUI', 'models'),
      comfy: readComfyDir(),
      logs: path.join(ROOT, 'state')
    };
    const target = map[which] ?? which;
    if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, path: target };
  });

  ipcMain.handle('shell:openDsh', async () => {
    const st = await launcherStatus(ROOT);
    const url = st.payload?.dshUrl ?? null;
    if (!url) return { ok: false, error: '拿不到 DSH 地址（它可能没在运行）' };
    await shell.openExternal(url);
    return { ok: true, url: url.replace(/\?.*$/, '') };
  });

  ipcMain.handle('shell:openConsole', async () => {
    await shell.openExternal(CONSOLE_URL);
    return { ok: true, url: CONSOLE_URL };
  });

  // ComfyUI 的网页界面（出图时想自己看图/调参就点它）
  ipcMain.handle('shell:openComfy', async () => {
    const url = readComfyHost();
    await shell.openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle('shell:openExternal', async (_evt, rawUrl) => {
    try {
      const url = new URL(String(rawUrl));
      const allowed = new Set(['github.com', 'docs.comfy.org', 'huggingface.co']);
      if (url.protocol !== 'https:' || !allowed.has(url.hostname)) return { ok: false, error: '只允许打开官方 HTTPS 文档链接' };
      await shell.openExternal(url.href);
      return { ok: true, url: url.href };
    } catch (error) { return { ok: false, error: error?.message ?? String(error) }; }
  });

  ipcMain.handle('config:createFromTemplate', async () => {
    const example = path.join(ROOT, 'config.example.json');
    const target = path.join(ROOT, 'config.json');
    if (fs.existsSync(target)) return { ok: false, error: 'config.json 已存在，未覆盖' };
    if (!fs.existsSync(example)) return { ok: false, error: '找不到 config.example.json' };
    fs.copyFileSync(example, target);
    return { ok: true, path: target };
  });

  // ── 卸载：读取计划（只读，不删任何东西）────────────────────────────────
  // 走的是与命令行/根目录 uninstall.bat **完全相同的核心**（tools/uninstall-core.mjs），
  // 只是加 --json 拿机器可读结果，避免两套逻辑各说各话。
  ipcMain.handle('uninstall:plan', async () => {
    const core = path.join(ROOT, 'tools', 'uninstall-core.mjs');
    if (!fs.existsSync(core)) return { ok: false, error: '找不到卸载核心 tools/uninstall-core.mjs' };
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [core, '--json', '--keep-data'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
      child.on('close', (code) => {
        if (code !== 0) return resolve({ ok: false, error: (err || `退出码 ${code}`).slice(0, 300) });
        try { resolve({ ok: true, plan: JSON.parse(out) }); }
        catch (e) { resolve({ ok: false, error: `计划解析失败：${e?.message ?? e}` }); }
      });
    });
  });

  // ── 卸载：执行（交接给根目录的独立卸载程序）────────────────────────────
  //
  // 为什么是"交接"而不是在本进程里删：
  //   桌面应用自己就跑在 desktop/node_modules（Electron）里，**进程运行中无法删除自己的文件**。
  //   根目录的 uninstall.bat 已经包含完整流程（提权 → 确认 → 执行 → 报告），
  //   复用它既避免自删难题，也保证"界面卸载"与"独立卸载"走同一条审计过的路径。
  ipcMain.handle('uninstall:start', async () => {
    const bat = path.join(ROOT, 'uninstall.bat');
    if (!fs.existsSync(bat)) return { ok: false, error: `找不到卸载程序：${bat}` };

    const planResult = await new Promise((resolve) => {
      const core = path.join(ROOT, 'tools', 'uninstall-core.mjs');
      const child = spawn(process.execPath, [core, '--json', '--keep-data'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
      child.on('error', () => resolve(null));
    });

    const mb = planResult ? Math.round(planResult.freeingBytes / 1048576) : null;
    const summary = planResult
      ? [
        `将卸载：${planResult.repo}`,
        mb !== null ? `预计释放：${mb} MB` : '',
        '',
        '处理方式：',
        '· 停止桥接与 SnowLuma',
        '· 摘除 DSH 里的 MCP 注入与 preset 副本',
        '· 删除桌面快捷方式与计划任务',
        '· 删除依赖（node_modules，约 400 MB）',
        '· 保留源码与 .git',
        '',
        '你的数据（state\\ 里 的对话历史 / 黑话库 / 表情、config.json）怎么处理？'
      ].filter(Boolean).join('\n')
      : '将启动根目录的独立卸载程序（uninstall.bat）。\n\n你的数据（state\\ 与 config.json）怎么处理？';

    const answer = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: '卸载 QQ 桥接控制台',
      message: '确认要卸载吗？',
      detail: summary,
      buttons: ['保留数据（推荐）', '归档后删除', '彻底删除', '取消'],
      defaultId: 0,
      cancelId: 3,
      noLink: true
    });
    if (answer.response === 3) return { ok: false, cancelled: true };

    const mode = ['keep', 'archive', 'purge'][answer.response] ?? 'keep';

    // 第二道确认：彻底删除是不可逆的，必须再问一次
    if (mode === 'purge') {
      const second = await dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'error',
        title: '再次确认',
        message: '「彻底删除」不可恢复',
        detail: '对话历史、黑话库、表情收藏、以及含你 QQ 号与令牌的 config.json 都会被永久删除。\n\n确定继续吗？',
        buttons: ['取消（推荐）', '我确定，彻底删除'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (second.response !== 1) return { ok: false, cancelled: true };
    }

    try {
      // uninstall.bat 自带提权；传模式参数让它不再重复询问数据去向
      const child = spawn('cmd.exe', ['/c', 'start', '', bat, mode], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      dlog(`从界面发起卸载：mode=${mode}，随后退出应用（让独立卸载程序接管）`);
      // 稍等片刻让新窗口起来，再退出自己 —— 否则用户会以为界面卡死
      setTimeout(() => { quitting = true; app.quit(); }, 1500);
      return { ok: true, mode };
    } catch (error) {
      dlog(`启动卸载程序失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  // ── 配置导出 / 导入 ─────────────────────────────────────────────────────
  // 都走 tools/config-portability.mjs（与命令行同一套逻辑）。
  // 导出：写到仓库根目录，成功后返回路径；导入：先跑预览，用户确认才 --apply。
  function runConfigTool(args) {
    const tool = path.join(ROOT, 'tools', 'config-portability.mjs');
    if (!fs.existsSync(tool)) return Promise.resolve({ ok: false, error: '找不到 tools/config-portability.mjs' });
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [tool, ...args], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
      child.on('close', (code) => resolve({ ok: code === 0, code, out, err }));
    });
  }

  // ── AI 运行时（dsh / direct）────────────────────────────────────────────────
  // 这三个通道让界面能查看/切换运行时、并**在保存前先测一下通不通**。
  // ⚠️ 两条安全约定（见 desktop/lib/runtime-config.js 顶部说明）：
  //   · apiKey **不回传渲染层** —— 只告知"填过没有"，界面留空即"不修改"；
  //   · 写入前备份到 archive/、只外科式改 runtime 段、写完校验并回滚。
  ipcMain.handle('runtime:get', async () => {
    const info = readRuntimeConfig(ROOT);
    // 顺带问一下桥接"你正在跑的是哪个运行时" —— 界面据此判断"改了配置但还没重启"。
    // 桥接没起来 / 还是旧版不带这个字段时，running 就是 null（界面显示"未知"，
    // **不假装知道**）。
    let running = null;
    let runningModel = null;
    let runningBaseUrl = null;
    try {
      const r = await bridgeGet('/api/status');
      if (r?.ok && r.json) {
        if (typeof r.json.runtime === 'string') running = r.json.runtime;
        if (typeof r.json.runtimeModel === 'string') runningModel = r.json.runtimeModel;
        if (typeof r.json.runtimeBaseUrl === 'string') runningBaseUrl = r.json.runtimeBaseUrl;
      }
    } catch { /* 取不到就留 null */ }
    return { ...info, running, runningModel, runningBaseUrl };
  });

  ipcMain.handle('runtime:save', async (_evt, patch = {}) => {
    const r = writeRuntimeConfig(ROOT, patch);
    if (r.ok) {
      dlog(`AI 运行时已改为 ${patch.type}${r.backup ? `（备份 ${path.basename(r.backup)}）` : ''}`);
    } else {
      dlog(`AI 运行时保存失败：${r.error}`);
    }
    return r;
  });

  /**
   * 测连接：真发一次最小请求。界面上"先测再存"能省掉"存了→重启→发现 key 不对"的来回。
   * apiKey 留空时用**已保存的那把**（界面拿不到明文，这是唯一的合理做法）。
   * 不回传 apiKey，也不把它写进日志。
   */
  ipcMain.handle('runtime:test', async (_evt, form = {}) => {
    const saved = readRuntimeConfig(ROOT);
    const apiKey = (typeof form.apiKey === 'string' && form.apiKey.length > 0)
      ? form.apiKey
      : null;
    const baseUrl = String(form.baseUrl ?? saved.runtime?.baseUrl ?? '').trim();
    const model = String(form.model ?? saved.runtime?.model ?? '').trim();
    if (!baseUrl || !model) return { ok: false, error: 'baseUrl 与 model 都要填' };
    if (apiKey === null && saved.apiKeySet) {
      // 需要用已保存的 key —— 但 readRuntimeConfig 刻意不回传它，所以这里直接读文件
      // （只在本进程内用一次，不落日志、不进渲染层）
      const secret = readRuntimeApiKey(ROOT);
      if (!secret.ok) return { ok: false, error: secret.error };
      return await probeViaBest({ baseUrl, model, apiKey: secret.apiKey });
    }
    // Ollama 等本地 OpenAI 兼容端点允许无鉴权；未保存 key 时直接用空串探测。
    return await probeViaBest({ baseUrl, model, apiKey: apiKey ?? '' });
  });

  /**
   * 探测一次"这个端点 + key + 模型能不能用"。
   *
   * **优先问桥接**（`POST /api/runtime/probe`），桥接不可用再退回本地 `probeDirect`。
   * 为什么（2026-09-26 实测）：Electron 主进程的 fetch 在这台机器上**持续**报
   * `SELF_SIGNED_CERT_IN_CHAIN`（安全软件拦 HTTPS 的证书不在 Electron 自带的根证书里），
   * 而**桥接那个进程能通**（同一个 API、同一把 key、同一个 node）。`--use-system-ca`
   * 又没法通过 NODE_OPTIONS 传给 Electron（Node 的白名单不允许，实测根证书仍是 150）。
   * ⇒ 让应用问桥接**比让应用自己测更诚实** —— 要测的本来就是"机器人这条路通不通"。
   */
  async function probeViaBest({ baseUrl, model, apiKey }) {
    const viaBridge = await bridgePost('/api/runtime/probe', { baseUrl, model, apiKey }, 40_000);
    if (viaBridge.ok) {
      return {
        ok: true,
        latencyMs: viaBridge.json?.latencyMs ?? null,
        reply: viaBridge.json?.reply ?? '',
        via: 'bridge'
      };
    }
    // 桥接没起来 / 太旧没这个端点 → 退回本地（可能因证书失败，但至少能给出原因）
    const local = await probeDirect({ baseUrl, model, apiKey });
    return { ...local, via: 'local', bridgeError: viaBridge.error };
  }

  /**
   * **模型检测**：问该接口"你有哪些可用模型"（`GET {baseUrl}/models`）。
   *
   * 这是"检测功能"而不只是"填下拉的数据源"，所以要多给三样东西：
   *   · `latencyMs` —— 检测耗时（慢得像挂住 vs 快，是完全不同的诊断信息）；
   *   · `hint`      —— **失败时要说清下一步查什么**。401 / 404 / 域名解析不了 / 没人监听
   *                    含义完全不同，只报"检测失败"等于没说；
   *   · `source`    —— 用的是哪把 key（"已保存的" vs "你刚填的"），避免"我明明换了 key 却还报旧错"。
   * apiKey 留空时用已保存的那把，全程**不回传渲染层、不落日志**。
   */
  ipcMain.handle('runtime:listModels', async (_evt, form = {}) => {
    const saved = readRuntimeConfig(ROOT);
    const baseUrl = String(form.baseUrl ?? saved.runtime?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!baseUrl) return { ok: false, error: '还没填接口地址', hint: '先填接口地址（例如 https://api.deepseek.com/v1）' };
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: `接口地址必须以 http:// 或 https:// 开头（现在是 ${baseUrl}）` };
    }
    const entered = typeof form.apiKey === 'string' && form.apiKey.length > 0;
    let apiKey = entered ? form.apiKey : '';
    if (!apiKey) {
      const secret = readRuntimeApiKey(ROOT);
      if (secret.ok) apiKey = secret.apiKey;
    }
    const source = entered ? '刚填的 key' : (apiKey ? '已保存的 key' : '未带 key');
    const t0 = Date.now();

    // **优先问桥接**（它的 fetch 在这台机器上能通，Electron 的不能 —— 见 probeViaBest 的说明）
    const viaBridge = await bridgePost('/api/runtime/models', { baseUrl, apiKey }, 12_000);
    if (viaBridge.ok && viaBridge.json) {
      const j = viaBridge.json;
      const models = Array.isArray(j.models) ? j.models : [];
      return {
        ok: true, models, latencyMs: j.latencyMs ?? (Date.now() - t0), source, baseUrl, via: 'bridge',
        ...(models.length ? {} : { note: '接口响应正常，但没有返回模型列表（有些服务不实现 /models）—— 可直接选「自定义」手填模型名' })
      };
    }
    // 桥接通了但接口本身失败（有状态码）→ 直接如实报，不用再本地试一遍
    if (viaBridge.json?.status) {
      return {
        ok: false, status: viaBridge.json.status, latencyMs: viaBridge.json.latencyMs ?? (Date.now() - t0),
        error: viaBridge.json.error ?? `HTTP ${viaBridge.json.status}`,
        hint: viaBridge.json.status === 401 || viaBridge.json.status === 403
          ? 'key 可能不对或没权限 —— 检查 API key；本地服务（Ollama 等）通常不需要 key，可以留空'
          : (viaBridge.json.status === 404
            ? '接口地址可能不对 —— 多数服务要写到 /v1 为止，不要带 /chat/completions'
            : '看响应体里的 message'),
        source, baseUrl, via: 'bridge'
      };
    }
    dlog(`桥接的模型检测不可用（${String(viaBridge.error).slice(0, 60)}），改由应用自己请求`);

    try {
      // 带重试：证书拦截 / 连接抖动可能是偶发的，重发一次往往就通了
      const res = await fetchWithRetry(`${baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000)
      });
      const latencyMs = Date.now() - t0;
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        // 状态码 → 可操作的提示（这几条覆盖了实际会遇到的绝大多数误配）
        const hint = res.status === 401 || res.status === 403
          ? 'key 可能不对或没权限 —— 检查 API key；本地服务（Ollama 等）通常不需要 key，可以留空'
          : (res.status === 404
            ? '接口地址可能不对 —— 多数服务要写到 /v1 为止，不要带 /chat/completions'
            : (res.status === 402 ? '账户余额或额度问题' : '看响应体里的 message'));
        return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}`, hint, source, baseUrl };
      }
      const models = Array.isArray(json?.data)
        ? json.data.map((m) => m?.id).filter((s) => typeof s === 'string' && s)
        : [];
      // 接口通了但列不出来：不是失败，但要说清"是接口没实现这个端点"
      if (!models.length) {
        return {
          ok: true, models: [], latencyMs, source, baseUrl,
          note: '接口响应正常，但没有返回模型列表（有些服务不实现 /models）—— 可直接选「自定义」手填模型名'
        };
      }
      return { ok: true, models, latencyMs, source, baseUrl };
    } catch (error) {
      const latencyMs = Date.now() - t0;
      const code = error?.cause?.code ?? error?.code ?? '';
      // 分类统一走 classifyNetError（含**证书**那一类）。
      // ⚠️ 原来这里手写了一套，结果**漏了证书错误** → `SELF_SIGNED_CERT_IN_CHAIN`
      //    被说成"检查接口地址、网络与代理设置"，对用户毫无帮助。
      //    一次失败的分类就该只有一处实现，不然迟早分叉。
      return {
        ok: false,
        latencyMs,
        error: String(error?.message ?? error) + (code ? `（${code}）` : ''),
        hint: classifyNetError(error),
        source,
        baseUrl
      };
    }
  });

  /**
   * **热切换模型**（direct 模式）：一次做完三件事 ——
   *   ① **先探新模型能不能用**（一次最小请求）；
   *   ② 探通了才写 config.json（持久化，走安全写入：备份 + 外科式 + 校验回滚）；
   *   ③ 通知桥接**立即生效**（`POST /api/runtime/model`），不用重启。
   *
   * ⚠️ **失败即什么都不改**（fail-closed）：探不通就不写配置、不切运行时。
   *    否则"换成一个不存在的模型名"会让机器人静默哑掉，而用户以为只是换了个模型。
   *    （要跳过这一步，直接改 config.json 再重启即可 —— 那是显式动作。）
   */
  ipcMain.handle('runtime:switchModel', async (_evt, form = {}) => {
    const model = String(form.model ?? '').trim();
    if (!model) return { ok: false, error: '模型名不能为空' };
    const saved = readRuntimeConfig(ROOT);
    if (!saved.ok) return { ok: false, error: saved.error };
    if (saved.runtime.type !== 'direct') {
      return { ok: false, error: '只有 direct 模式能在应用里热切换模型（挂 DSH 时模型由 DSH 决定）' };
    }
    const baseUrl = String(form.baseUrl ?? saved.runtime.baseUrl ?? '').trim();
    if (!baseUrl) return { ok: false, error: '还没填接口地址' };
    const enteredKey = typeof form.apiKey === 'string' ? form.apiKey : '';

    // ① 探测（用界面填的 key；留空则用已保存的那把）
    let apiKeyForProbe = enteredKey;
    if (!apiKeyForProbe) {
      const secret = readRuntimeApiKey(ROOT);
      if (secret.ok) apiKeyForProbe = secret.apiKey;
    }
    const probe = await probeViaBest({ baseUrl, model, apiKey: apiKeyForProbe });
    if (!probe.ok) {
      return { ok: false, step: 'probe', error: `新模型不可用，**未做任何改动**：${probe.error}`, hint: probe.hint ?? null };
    }

    // ② 持久化（只改 runtime 段；其余字段由 runtime-config 原样保留）
    const saved2 = writeRuntimeConfig(ROOT, {
      type: 'direct',
      baseUrl,
      model,
      ...(enteredKey ? { apiKey: enteredKey } : {})
    });
    if (!saved2.ok) return { ok: false, step: 'save', error: `写入配置失败：${saved2.error}` };

    // ③ 立即生效
    const applied = await bridgePost('/api/runtime/model', { model });
    dlog(`模型热切换：→ ${model}（探测 ${probe.latencyMs}ms；运行时生效=${applied.ok}）`);
    return {
      ok: true,
      model,
      latencyMs: probe.latencyMs,
      reply: probe.reply,
      backup: saved2.backup ?? null,
      // 配置写成了 ≠ 运行时生效了：桥接没起/不是 direct 时这里为 false，
      // 界面据此提示"配置已保存，重启后生效"。
      applied: applied.ok,
      applyError: applied.ok ? null : applied.error
    };
  });

  ipcMain.handle('config:export', async (_evt, opts = {}) => {    const sanitize = opts?.sanitize === true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = path.join(ROOT, `config-bundle${sanitize ? '-sanitized' : ''}-${stamp}.json`);
    const r = await runConfigTool(['export', '--out', outFile, ...(sanitize ? ['--sanitize'] : [])]);
    if (!r.ok) return { ok: false, error: (r.err || r.out || `退出码 ${r.code}`).slice(0, 300) };
    dlog(`已导出配置包：${outFile}（sanitize=${sanitize}）`);
    return { ok: true, path: outFile, sanitize };
  });

  ipcMain.handle('config:import', async () => {
    const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: '选择配置包',
      defaultPath: ROOT,
      filters: [{ name: '配置包 JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths?.length) return { ok: false, cancelled: true };
    const file = picked.filePaths[0];

    // 先预览（不写入）
    const preview = await runConfigTool(['import', file]);
    const previewText = (preview.out || preview.err || '').trim();
    if (!preview.ok) return { ok: false, error: previewText.slice(0, 500) };

    const answer = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: '导入配置',
      message: '确认导入这个配置包吗？',
      detail: `${previewText.slice(0, 1500)}\n\n导入会覆盖现有 config.json（覆盖前会自动备份到 archive/）。`,
      buttons: ['取消', '确认导入'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (answer.response !== 1) return { ok: false, cancelled: true };

    const applied = await runConfigTool(['import', file, '--apply']);
    const appliedText = (applied.out || applied.err || '').trim();
    if (!applied.ok) return { ok: false, error: appliedText.slice(0, 500) };
    dlog(`已导入配置包：${file}`);
    return { ok: true, file, output: appliedText.slice(0, 500) };
  });

  // ── 监测页的数据源 ───────────────────────────────────────────────────────
  // 在这里（主进程）取数而不是让渲染层直接 fetch：
  //   ① 控制台令牌不必进渲染层；② 不受渲染层 CSP/跨源限制；③ 失败时能统一兜底。
  // 数据都来自桥接已有的 /api/* 端点，没有为界面新增任何桥接侧接口。
  async function bridgeGet(pathname, timeoutMs = 6000) {
    const token = readConsoleToken(ROOT);
    if (!token) return { ok: false, error: '读不到控制台令牌（state/console-token）—— 服务是否已启动？' };
    const port = Number(readConfig(ROOT)?.consolePort) || 3100;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        headers: { 'x-console-token': token },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok) {
        return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
      }
      return { ok: true, json };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** 与 bridgeGet 对称的 POST。桥接的错误体里通常有可读的 `error`，优先带出来。 */
  async function bridgePost(pathname, body = {}, timeoutMs = 8000) {
    const token = readConsoleToken(ROOT);
    if (!token) return { ok: false, error: '读不到控制台令牌（state/console-token）—— 服务是否已启动？' };
    const port = Number(readConfig(ROOT)?.consolePort) || 3100;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'x-console-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      // ⚠️ 桥接的错误响应带 4xx，但**响应体里的 error 才是有用的信息**
      //（例如"当前不是 direct 模式"）—— 不能只报 `HTTP 400`。
      if (!res.ok || json?.ok === false) {
        return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
      }
      return { ok: true, json };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // 所有会话的唤醒状态（潜水/活跃、未读数、上次唤醒原因、最近 AI 回复时间…）
  ipcMain.handle('monitor:states', async () => {
    const r = await bridgeGet('/api/socialV2/states');
    if (!r.ok) return r;
    return { ok: true, conversations: r.json?.conversations ?? [] };
  });

  // 活动流：/api/status 的 activity 字段就是带时间戳的运行日志
  ipcMain.handle('monitor:activity', async () => {
    const r = await bridgeGet('/api/status');
    if (!r.ok) return r;
    const j = r.json ?? {};
    return {
      ok: true,
      activity: String(j.activity ?? ''),
      mode: j.mode ?? null,
      role: j.role ?? null,
      roleMode: j.roleMode ?? null,
      ownerQQ: j.ownerQQ ?? null,
      dshReady: j.dshReady === true,
      // 「能不能把 prompt 交给 AI」—— direct 下恒真。界面判"能不能干活"要看这个，
      // 别看 dshReady（direct 下它是诚实的 false：确实没连 DSH）。
      runtimeReady: j.runtimeReady === true,
      runtime: j.runtime ?? null,
      socialV2Paused: j.socialV2Paused === true,
      allowGroups: j.allowGroups ?? [],
      allowPrivate: j.allowPrivate ?? []
    };
  });

  // 某个会话的最近消息
  ipcMain.handle('monitor:recent', async (_evt, key, limit = 20) => {
    const k = String(key ?? '').trim();
    if (!k) return { ok: false, error: '缺少会话 key' };
    const r = await bridgeGet(`/api/socialV2/recent?key=${encodeURIComponent(k)}&limit=${Number(limit) || 20}`);
    if (!r.ok) return r;
    return { ok: true, messages: r.json?.messages ?? [] };
  });

  // 重启应用本身（加载界面改动）。独立于"重启服务"。
  ipcMain.handle('app:relaunch', () => {
    relaunchApp();
    return { ok: true };
  });

  // 退出应用（等价于托盘菜单的「退出」）
  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
    return { ok: true };
  });
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// 每个动作的硬超时：**保证 UI 一定能恢复**。
// 实测 restartAll 约 2 分 35 秒；若启动器卡住，没有上限就会让按钮永久禁用
// （用户报过：点重启后四个按钮全部灰住无法交互）。
const ACTION_TIMEOUT_MS = {
  startAll: 180_000,
  stopAll: 90_000,
  restartAll: 240_000,
  restartBridgeOnly: 120_000
};

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `${label} 超过 ${Math.round(ms / 1000)} 秒仍未完成，已放弃等待（操作可能仍在后台进行，请稍后刷新状态）`, timedOut: true });
    }, ms);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: String(e?.message ?? e) }); } }
    );
  });
}

async function runLifecycle(action, { silent = false } = {}) {
  const runners = {
    startAll: () => launcherStartAll(ROOT),
    stopAll: () => launcherStopAll(ROOT),
    restartAll: () => launcherRestartAll(ROOT),
    // 轻量档：只重启桥接，不动 DSH / SnowLuma（快得多，也不会打断网页端会话）
    restartBridgeOnly: () => launcherRestartBridgeOnly(ROOT),
    // 出图服务（可选）：等端口起来，冷启动约 30~60 秒
    comfyStart: () => launcherStartComfy(ROOT),
    comfyStop: () => launcherStopComfy(ROOT)
  };
  const runner = runners[action];
  if (!runner) return { ok: false, error: `不支持的动作：${action}` };

  // silent：看门狗触发的动作不接管界面按钮/进度条（用户没点任何东西，
  // 不该看到按钮变灰或用进度条打断）。仍照常写时间线与日志，便于事后追溯。
  if (!silent) busyAction = action;
  const run = startLifecycleRun(silent ? `watchdog:${action}` : action);
  if (!silent) broadcast('lifecycle:state', { busy: action, startedAt: Date.now() });

  try {
    const timeoutMs = ACTION_TIMEOUT_MS[action] ?? 180_000;
    // 记录"开始调用 launcher"的时刻：否则 launcher 返回与随后几乎瞬时的体检会落在
    // 同一毫秒，时间线里出现两个相同的耗时（用户看到会以为时间戳又坏了）。
    run.mark('调用 launcher');
    const result = await withTimeout(runner(), timeoutMs, `动作 ${action}`);
    run.mark(result.timedOut ? '超时放弃' : 'launcher 已返回');

    // 体检也加上限，避免它把整个动作拖住
    const health = await withTimeout(healthCheck(ROOT, { comfyInstalled: comfySetupStatus(ROOT).installed }), 30_000, '体检');
    run.mark('体检完成');
    if (health && !health.error) broadcast('health:changed', health);

    const summary = run.done(result);
    return { ...result, health: health?.error ? undefined : health, timing: summary, timedOut: result.timedOut === true };
  } catch (error) {
    run.done({ ok: false, error: String(error?.message ?? error) });
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    // 无论如何都要恢复按钮 —— 这是"界面卡死"的直接护栏
    if (!silent) {
      busyAction = null;
      broadcast('lifecycle:state', { busy: null });
    }
  }
}

// ── 启动流程 ────────────────────────────────────────────────────────────────
dlog(`启动中：electron=${process.versions.electron} node=${process.versions.node} 软件渲染=${FORCE_SOFTWARE}`);

app.whenReady().then(() => {
  // 先清掉可能损坏/被占用的 GPU 缓存（上次崩溃残留会让这次也起不来）
  const cleaned = cleanGpuCache();
  if (cleaned.length) dlog(`已清理缓存目录：${cleaned.join(', ')}`);

  registerIpc();
  createWindow();
  createTray();
  dlog('窗口与托盘已创建');

  // 看门狗：主进程侧定时探测关键服务，不在就自动拉起（窗口收进托盘后依然有效）
  startWatchdog();

  // 启动后自动检查一次（渲染层也会主动请求，这里推一份让 UI 立即有数据）
  setTimeout(() => {
    healthCheck(ROOT, { comfyInstalled: comfySetupStatus(ROOT).installed }).then((h) => broadcast('health:changed', h)).catch(() => {});
  }, 1200);
});

// 渲染进程崩溃时不要静默变成白屏：记录并自动重载一次
let reloadCount = 0;
app.on('render-process-gone', (_event, _contents, details) => {
  dlog(`渲染进程结束：reason=${details?.reason} exitCode=${details?.exitCode}`);
  if (reloadCount < 1 && mainWindow && !mainWindow.isDestroyed()) {
    reloadCount += 1;
    dlog('尝试重新加载窗口…');
    mainWindow.reload();
  }
});

app.on('child-process-gone', (_event, details) => {
  dlog(`子进程结束：type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}`);
});

app.on('window-all-closed', () => {
  // Windows 上关闭窗口不退出（收进托盘）
  if (process.platform !== 'darwin' && quitting) app.quit();
});

app.on('before-quit', () => { quitting = true; dlog('正在退出'); });

// 未捕获异常不要静默：写日志 + 弹窗告知，便于用户反馈
process.on('uncaughtException', (error) => {
  dlog(`未捕获异常：${error?.stack ?? error}`);
  try {
    dialog.showErrorBox('QQ 桥接控制台 — 未预期错误', String(error?.stack ?? error));
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  dlog(`未处理的 Promise 拒绝：${reason?.stack ?? reason}`);
});

// 让 start.mjs 能在崩溃后读到日志位置
process.on('exit', (code) => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} 进程退出 code=${code}\n`, 'utf8');
  } catch {}
});
