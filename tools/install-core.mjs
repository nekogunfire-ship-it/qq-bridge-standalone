// 安装程序核心：把分发包"装"成一个正式安装（复制到安装目录 + 装依赖 + 建快捷方式 + 登记卸载项）。
//
// ⚠️ 这个工具会修改**系统级状态**（注册表、快捷方式，可选计划任务）。本项目已经因为
//   "沙箱测试动了全局状态"破坏过用户的 DSH Watchdog 任务与注册表项，所以这里的设计原则：
//
//   ① **默认只出计划**（`--plan` 是默认行为），必须显式 `--apply` 才动手；
//   ② **目标目录必须为空、或带有本程序的安装标记**（`.qq-bridge-install.json`）——
//      绝不对一个无关目录"覆盖安装"；
//   ③ 所有全局登记（注册表键名、快捷方式路径）都**可注入**，便于沙箱测试指向别处；
//   ④ 覆盖/删除任何全局登记前先做**归属检查**（是不是指向本安装目录）；
//   ⑤ 装完写一份清单进目标目录，记录"我们创建了什么"，卸载端可据此精确清理。
//
// 用法：
//   node tools/install-core.mjs --plan                       # 只看计划（默认）
//   node tools/install-core.mjs --apply --target <目录>       # 真正安装
//   node tools/install-core.mjs --apply --with-shortcuts --with-uninstall-entry
//   node tools/install-core.mjs --apply --with-watchdogs      # 另注册看门狗任务（需提权）
//   --reg-key <名称>   注册表键名（测试用；默认 qq-bridge-desktop）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = path.resolve(__dirname, '..');

const MARKER = '.qq-bridge-install.json';
const DEFAULT_REG_KEY = 'qq-bridge-desktop';
const REG_BASE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

// 安装包必须包含这些（用来判断"这是不是一个完整的分发包"）
const REQUIRED_IN_SOURCE = ['package.json', 'src/bridge.js', 'config.example.json', 'uninstall.bat'];

// 不参与安装的东西（与 tools/package-dist.mjs 的排除规则保持同一套理念）
const COPY_EXCLUDE_SEGMENTS = ['node_modules', 'state', 'archive', '.git', 'dist', '__pycache__'];
const COPY_EXCLUDE_FILES = [/\.log$/i, /\.bak$/i, /\.bak-/i, /^config\.json$/i, /^config-bundle-.*\.json$/i];

function argValue(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}
const has = (name) => process.argv.slice(2).includes(name);

function runDecoded(cmd, args) {
  const r = spawnSync(cmd, args, { windowsHide: true });
  const buf = r.stdout ?? Buffer.alloc(0);
  if (!buf.length) return { ok: r.status === 0, out: '' };
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else { try { text = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch { text = buf.toString('utf8'); } }
  return { ok: r.status === 0, out: text };
}

function isAdmin() {
  return spawnSync('net.exe', ['session'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

// ── 路径解析（全部可注入，测试才能指向沙箱）────────────────────────────────
function resolvePaths() {
  const source = path.resolve(argValue('--source') ?? CODE_ROOT);
  const target = path.resolve(
    argValue('--target')
    ?? process.env.QB_INSTALL_TARGET
    ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'QQBridge')
  );
  // 快捷方式落地目录：走 APPDATA / USERPROFILE 环境变量，测试可整体重定向
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const home = process.env.USERPROFILE ?? os.homedir();
  return {
    source,
    target,
    desktopDir: path.join(home, 'Desktop'),
    startMenuDir: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    regKey: argValue('--reg-key') ?? DEFAULT_REG_KEY,
  };
}

// ── 目标目录安全检查 ────────────────────────────────────────────────────────
function inspectTarget(target) {
  if (!fs.existsSync(target)) return { state: 'empty', entries: 0 };
  const entries = fs.readdirSync(target);
  if (entries.length === 0) return { state: 'empty', entries: 0 };
  const markerPath = path.join(target, MARKER);
  if (fs.existsSync(markerPath)) {
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}
    return { state: 'previous-install', entries: entries.length, marker };
  }
  return { state: 'foreign', entries: entries.length, sample: entries.slice(0, 6) };
}

/** 收集要复制的文件（相对 source） */
function collectSourceFiles(source) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(source, rel);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const parts = childRel.split(/[\\/]/).map((p) => p.toLowerCase());
      if (parts.some((p) => COPY_EXCLUDE_SEGMENTS.includes(p))) continue;
      const base = parts[parts.length - 1];
      if (COPY_EXCLUDE_FILES.some((re) => re.test(base))) continue;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) files.push(childRel);
    }
  };
  walk('');
  return files.sort();
}

// ── 快捷方式（用 PowerShell 的 WScript.Shell；无第三方依赖）──────────────────
// 关键：桌面版快捷方式必须指向 `node.exe <target>\desktop\start.mjs`，
// **不能**直接指向 electron.exe（会绕过 start.mjs 的缓存清理与 userData 指定）。
function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function createShortcut({ lnkPath, targetPath, arguments: args, workDir, iconPath, runAsAdmin, description }) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$ws = New-Object -ComObject WScript.Shell',
    `$lnk = $ws.CreateShortcut(${psQuote(lnkPath)})`,
    `$lnk.TargetPath = ${psQuote(targetPath)}`,
    args ? `$lnk.Arguments = ${psQuote(args)}` : null,
    workDir ? `$lnk.WorkingDirectory = ${psQuote(workDir)}` : null,
    iconPath ? `$lnk.IconLocation = ${psQuote(iconPath)}` : null,
    description ? `$lnk.Description = ${psQuote(description)}` : null,
    '$lnk.WindowStyle = 7',   // 最小化，避免 cmd 黑框闪出
    '$lnk.Save()',
    'Write-Output "SAVED"'
  ].filter(Boolean).join('; ');
  const r = runDecoded('powershell.exe', ['-NoProfile', '-Command', script]);
  if (!r.ok || !r.out.includes('SAVED')) {
    return { ok: false, error: (r.out || '创建快捷方式失败').slice(0, 200) };
  }

  // RunAsAdmin 位：WScript.Shell 不暴露该属性，只能改 .lnk 二进制头
  // （LinkFlags 在 offset 0x14 起 4 字节，RunAsAdmin = offset 0x15 的 bit5 即 0x20）。
  // 本机 electron.exe 必须提权才能跑，桌面版快捷方式需要它。
  if (runAsAdmin) {
    try {
      const buf = fs.readFileSync(lnkPath);
      buf[0x15] |= 0x20;
      fs.writeFileSync(lnkPath, buf);
    } catch (e) {
      return { ok: false, error: `快捷方式已建，但设置「以管理员身份运行」失败：${e?.message ?? e}` };
    }
  }
  return { ok: true };
}

/** 读 .lnk 的目标（判断归属用）。读不到就返回 null（保守：当成"不是我们的"）。 */
function readShortcutTarget(lnkPath) {
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `try { $l = $ws.CreateShortcut(${psQuote(lnkPath)}); Write-Output ($l.TargetPath + "|" + $l.Arguments) } catch { Write-Output "UNREADABLE" }`
  ].join('; ');
  const r = runDecoded('powershell.exe', ['-NoProfile', '-Command', script]);
  const out = r.out.trim();
  if (!out || out === 'UNREADABLE') return null;
  const [target, args] = out.split('|');
  return { target, arguments: args ?? '' };
}

// ── 计划 ────────────────────────────────────────────────────────────────────
function buildPlan(p) {
  const steps = [];
  const push = (title, detail, kind = 'action') => steps.push({ title, detail, kind });

  if (!fs.existsSync(p.source)) {
    return { ok: false, error: `找不到安装包目录：${p.source}`, steps: [] };
  }
  const missing = REQUIRED_IN_SOURCE.filter((f) => !fs.existsSync(path.join(p.source, f)));
  if (missing.length) {
    return { ok: false, error: `安装包不完整，缺少：${missing.join(', ')}`, steps: [] };
  }

  const t = inspectTarget(p.target);
  const files = collectSourceFiles(p.source);

  push('复制程序文件', `${files.length} 个文件 → ${p.target}`, 'copy');
  if (t.state === 'previous-install') push('覆盖已有安装', `目标目录已有本程序安装（保留其中的 config.json / state）`, 'note');
  if (has('--no-dsh')) {
    push('安装依赖（不装 DSH）',
      'npm install --omit=optional —— 跳过 DSH 的 SDK，运行时将使用 direct（标准 AI API）', 'action');
  } else {
    push('安装依赖（含 DSH 环境）',
      'npm install —— 装上 DSH 的 SDK（可选依赖），dsh 与 direct 两种运行时都能选', 'action');
  }
  if (has('--with-comfy')) {
    push('安装 ComfyUI 环境', `从官方 GitHub 下载 Windows Portable（${argValue('--comfy-variant') ?? 'nvidia'}）`, 'action');
  } else {
    push('不安装 ComfyUI', '以后可在桌面应用「出图」页安装', 'keep');
  }
  if (has('--with-image-model')) {
    push('安装 SDXL Base 1.0', '约 6.9 GB；用户已在安装向导中接受 CreativeML Open RAIL++-M 许可证', 'action');
  } else {
    push('不下载图片模型', '以后可在桌面应用「出图」页阅读许可证并下载', 'keep');
  }
  push('生成配置', '运行配置向导：npm run setup（体检 + 自动探测 + 询问运行时 + 生成 config.json）', 'action');

  if (has('--with-shortcuts')) {
    for (const s of shortcutPlan(p)) push(s.title, s.detail, s.kind);
  } else {
    push('不创建快捷方式', '（加 --with-shortcuts 才会创建桌面与开始菜单快捷方式）', 'keep');
  }

  if (has('--with-uninstall-entry')) {
    push('登记系统卸载项', `HKCU\\...\\Uninstall\\${p.regKey} → 指向目标目录的 uninstall.bat`, 'action');
  } else {
    push('不登记系统卸载项', '（加 --with-uninstall-entry 才会让「设置 → 应用」列出本程序）', 'keep');
  }

  if (has('--with-watchdogs')) {
    push('注册看门狗任务', '登录自启：Bridge Watchdog + DSH Watchdog（需管理员权限）', 'action');
  } else {
    push('不注册看门狗任务', '（加 --with-watchdogs 才会注册；它们是按用户全局的）', 'keep');
  }

  push('写安装标记', `${path.join(p.target, MARKER)}：记录本次创建了什么，便于将来精确卸载`, 'copy');
  push('第三方边界', 'SnowLuma 始终由用户自行准备；DSH / ComfyUI / SDXL 仅按上述选项处理', 'keep');

  return { ok: true, steps, targetState: t, fileCount: files.length };
}

function shortcutPlan(p) {
  const desktopLnk = path.join(p.desktopDir, 'QQ 桥接控制台.lnk');
  const menuDir = path.join(p.startMenuDir, 'QQ 桥接');
  return [
    {
      title: '创建桌面快捷方式',
      detail: `${desktopLnk} → node.exe <目标>\\desktop\\start.mjs（最小化 + 以管理员身份运行）`,
      kind: 'action'
    },
    {
      title: '创建开始菜单项',
      detail: `${menuDir}（启动 / 停止 / 卸载 三个入口）`,
      kind: 'action'
    }
  ];
}

function formatPlan(plan, p) {
  const lines = [];
  lines.push(`安装包来源：${p.source}`);
  lines.push(`安装目标  ：${p.target}`);
  const st = plan.targetState;
  lines.push(`目标现状  ：${
    st.state === 'empty' ? '空目录（可直接安装）'
      : st.state === 'previous-install' ? `已有本程序安装（${st.entries} 项，将覆盖程序文件、保留配置与数据）`
        : `⚠️ 非空且不是本程序的安装（${st.entries} 项：${(st.sample ?? []).join(', ')}…）`
  }`);
  lines.push('');
  lines.push('安装计划：');
  const mark = { action: '[执行]', copy: '[复制]', note: '[注意]', keep: '[留]' };
  plan.steps.forEach((s, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. ${mark[s.kind] ?? '[·]'} ${s.title}`);
    if (s.detail) lines.push(`        ${s.detail}`);
  });
  return lines.join('\n');
}

// ── 执行 ────────────────────────────────────────────────────────────────────
function execute(p, log = console.log) {
  const results = [];
  const rec = (step, ok, detail) => { results.push({ step, ok, detail }); log(`  ${ok ? '✅' : '⚠️ '} ${step}${detail ? ` — ${detail}` : ''}`); };

  // 1) 复制程序文件。config.json / state / archive 已在 collectSourceFiles 中排除，
  // 因而用户数据会保留；其余程序文件必须覆盖，确保重装/升级真正更新到新版本。
  const files = collectSourceFiles(p.source);
  let copied = 0;
  let updated = 0;
  const copyFailures = [];
  for (const rel of files) {
    const to = path.join(p.target, rel);
    const existed = fs.existsSync(to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.copyFileSync(path.join(p.source, rel), to);
      if (existed) updated += 1;
      else copied += 1;
    } catch (error) {
      copyFailures.push(`${rel}: ${error?.message ?? error}`);
    }
  }
  rec('复制程序文件', copyFailures.length === 0,
    copyFailures.length === 0
      ? `新复制 ${copied} 个，更新 ${updated} 个；用户配置与状态未覆盖`
      : `${copyFailures.length} 个文件失败：${copyFailures.slice(0, 3).join('；')}`);

  // 安装包里的 services.json 可能来自另一台机器；Node 路径与 HTA 必须按目标机/目标目录
  // 重新生成。第三方服务路径只在原值不存在时留给后续 setup 向导探测，避免覆盖已有安装。
  try {
    const servicesPath = path.join(p.target, 'tools', 'services.json');
    const services = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
    services.nodeExe = process.execPath;
    for (const field of ['dshExe', 'snowLumaDir', 'comfyDir']) {
      if (services[field] && !fs.existsSync(services[field])) services[field] = '';
    }
    fs.writeFileSync(servicesPath, JSON.stringify(services, null, 2) + '\n', 'utf8');
    const builder = path.join(p.target, 'tools', 'build-hta.mjs');
    const built = spawnSync(process.execPath, [builder], { cwd: p.target, windowsHide: true });
    rec('重建本机启动器', built.status === 0,
      built.status === 0 ? '已按安装目录生成 launcher.hta / runtime/init.json' : `生成失败（退出码 ${built.status}）`);
  } catch (e) {
    rec('重建本机启动器', false, String(e?.message ?? e));
  }

  // 2) 写安装标记（先写，后面步骤失败也能看出这是我们的安装）
  const marker = {
    kind: 'qq-bridge-install',
    installedAt: new Date().toISOString(),
    source: p.source,
    target: p.target,
    created: { shortcuts: [], regKey: null, tasks: [] }
  };
  fs.writeFileSync(path.join(p.target, MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8');
  rec('写安装标记', true, MARKER);

  // 3) npm install
  // `--no-dsh`：跳过可选依赖（DSH 的 SDK），装出一个**不需要 DSH** 的环境。
  // 这是用户要求的"安装时让用户选是否安装 DSH 环境"的落点：
  //   装了 → 可以用 dsh 运行时；不装 → 用 direct 运行时（标准 AI API）。
  if (!has('--skip-npm')) {
    const omitOptional = has('--no-dsh');
    log(`  正在执行 npm install${omitOptional ? ' --omit=optional（跳过 DSH 的可选依赖）' : ''}（可能要一会儿）…`);
    const rr = spawnSync('cmd.exe', [
      '/c',
      `cd /d "${p.target}" && npm install --no-audit --no-fund${omitOptional ? ' --omit=optional' : ''}`
    ], { windowsHide: true });
    rec('安装依赖', rr.status === 0,
      rr.status === 0
        ? `npm install 完成${omitOptional ? '（未安装 DSH 的 SDK）' : '（含 DSH 的 SDK）'}`
        : `npm install 失败（退出码 ${rr.status}）`);
    const desktopResult = spawnSync('cmd.exe', [
      '/c',
      `cd /d "${path.join(p.target, 'desktop')}" && npm install --no-audit --no-fund`
    ], { windowsHide: true });
    rec('安装桌面运行环境', desktopResult.status === 0,
      desktopResult.status === 0 ? 'Electron 桌面运行环境安装完成' : `desktop npm install 失败（退出码 ${desktopResult.status}）`);
  } else {
    rec('安装依赖', true, '已按 --skip-npm 跳过');
    rec('安装桌面运行环境', true, '已按 --skip-npm 跳过');
  }

  // 4) 可选安装 ComfyUI 与图片模型。专用 CLI 复用桌面应用同一套下载、路径和配置逻辑。
  if (has('--with-comfy') || has('--with-image-model')) {
    const tool = path.join(p.target, 'tools', 'install-comfy-cli.mjs');
    const args = [tool];
    if (has('--with-comfy')) args.push('--with-comfy');
    if (has('--with-image-model')) args.push('--with-image-model', '--accept-model-license');
    args.push('--variant', argValue('--comfy-variant') ?? 'nvidia');
    const comfyResult = spawnSync(process.execPath, args, { cwd: p.target, windowsHide: false, stdio: 'inherit' });
    rec('ComfyUI / 图片模型', comfyResult.status === 0,
      comfyResult.status === 0 ? '所选出图组件安装完成' : `安装失败（退出码 ${comfyResult.status}）；可稍后在应用「出图」页重试`);
  }

  // 5) 快捷方式
  if (has('--with-shortcuts')) {
    const nodeExe = process.execPath;
    const startMjs = path.join(p.target, 'desktop', 'start.mjs');
    const icon = ['assets/dsh.ico', 'assets/deepseek娘.png']
      .map((f) => path.join(p.target, f)).find((f) => fs.existsSync(f));

    // 归属检查：桌面上若已有同名快捷方式且**不指向本安装**，不覆盖
    const desktopLnk = path.join(p.desktopDir, 'QQ 桥接控制台.lnk');
    const existing = fs.existsSync(desktopLnk) ? readShortcutTarget(desktopLnk) : null;
    const mine = existing ? existing.arguments?.toLowerCase().includes(p.target.toLowerCase()) : false;
    if (existing && !mine) {
      rec('桌面快捷方式', true, `已存在且指向别处（${existing.target}），未覆盖`);
    } else {
      fs.mkdirSync(p.desktopDir, { recursive: true });
      const r = createShortcut({
        lnkPath: desktopLnk,
        targetPath: nodeExe,
        arguments: `"${startMjs}"`,
        workDir: p.target,
        iconPath: icon,
        runAsAdmin: true,
        description: 'QQ 桥接控制台（桌面版）'
      });
      rec('桌面快捷方式', r.ok, r.ok ? desktopLnk : r.error);
      if (r.ok) marker.created.shortcuts.push(desktopLnk);
    }

    // 开始菜单：启动 / 停止 / 卸载
    const menuDir = path.join(p.startMenuDir, 'QQ 桥接');
    try {
      fs.mkdirSync(menuDir, { recursive: true });
      const entries = [
        { name: '启动 QQ 桥接控制台.lnk', node: true },
        { name: '停止 QQ 桥接.lnk', bat: path.join(p.target, 'tools', '停止QQ桥接.bat') },
        { name: '卸载 QQ 桥接控制台.lnk', bat: path.join(p.target, 'uninstall.bat') }
      ];
      let made = 0;
      for (const e of entries) {
        const lnk = path.join(menuDir, e.name);
        const r = e.node
          ? createShortcut({ lnkPath: lnk, targetPath: nodeExe, arguments: `"${startMjs}"`, workDir: p.target, iconPath: icon, runAsAdmin: true, description: 'QQ 桥接控制台' })
          : createShortcut({ lnkPath: lnk, targetPath: e.bat, workDir: p.target, iconPath: icon, runAsAdmin: e.name.includes('卸载'), description: e.name.replace('.lnk', '') });
        if (r.ok) { made += 1; marker.created.shortcuts.push(lnk); }
      }
      rec('开始菜单项', made > 0, `${menuDir}（${made}/${entries.length} 个）`);
    } catch (e) {
      rec('开始菜单项', false, String(e?.message ?? e));
    }
  }

  // 5) 注册表卸载项（先做归属检查，避免覆盖掉另一份安装的登记）
  if (has('--with-uninstall-entry')) {
    const key = `${REG_BASE}\\${p.regKey}`;
    const q = runDecoded('reg.exe', ['query', key, '/v', 'InstallLocation']);
    let declared = '';
    if (q.ok) {
      const m = q.out.split(/\r?\n/).map((l) => l.match(/InstallLocation\s+REG_\w+\s+(.*?)\s*$/)).find(Boolean);
      declared = m ? m[1] : '';
    }
    if (declared && path.resolve(declared).toLowerCase() !== p.target.toLowerCase()) {
      rec('系统卸载项', true, `已存在且登记的是别处（${declared}），未覆盖`);
    } else {
      const uninstallBat = path.join(p.target, 'uninstall.bat');
      const values = [
        ['DisplayName', 'REG_SZ', 'QQ 桥接控制台（QQ Bridge）'],
        ['DisplayVersion', 'REG_SZ', readVersion(p.target)],
        ['Publisher', 'REG_SZ', '本机自建'],
        ['InstallLocation', 'REG_SZ', p.target],
        ['UninstallString', 'REG_SZ', `"${uninstallBat}"`],
        ['QuietUninstallString', 'REG_SZ',
          `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(p.target, 'tools', 'uninstall-silent.ps1')}" -Mode keep`],
        ['NoModify', 'REG_DWORD', '1'],
        ['NoRepair', 'REG_DWORD', '1']
      ];
      let ok = 0;
      for (const [n, t, d] of values) {
        const r = runDecoded('reg.exe', ['add', key, '/v', n, '/t', t, '/d', d, '/f']);
        if (r.ok) ok += 1;
      }
      rec('系统卸载项', ok === values.length, ok === values.length ? key : `${ok}/${values.length} 项写入成功`);
      if (ok === values.length) marker.created.regKey = key;
    }
  }

  // 6) 看门狗任务（需要提权；交给专用脚本做，我们只调用）
  if (has('--with-watchdogs')) {
    const tool = path.join(p.target, 'tools', 'register-watchdog-tasks.mjs');
    if (!fs.existsSync(tool)) {
      rec('看门狗任务', false, '找不到 tools/register-watchdog-tasks.mjs');
    } else if (!isAdmin()) {
      rec('看门狗任务', false, '需要管理员权限（创建计划任务）—— 请提权后再执行这一步');
    } else {
      const r = spawnSync(process.execPath, [tool], { cwd: p.target, windowsHide: true });
      rec('看门狗任务', r.status === 0, r.status === 0 ? 'Bridge Watchdog + DSH Watchdog 已注册' : `注册失败（退出码 ${r.status}）`);
      if (r.status === 0) marker.created.tasks = ['Bridge Watchdog', 'DSH Watchdog'];
    }
  }

  // 更新标记里的清单
  fs.writeFileSync(path.join(p.target, MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8');
  return results;
}

function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const apply = has('--apply');
  const p = resolvePaths();

  console.log('=== QQ 桥接 · 安装 ===');
  console.log('');
  const plan = buildPlan(p);
  if (!plan.ok) {
    console.error(`❌ ${plan.error}`);
    return 1;
  }
  console.log(formatPlan(plan, p));
  console.log('');

  // 安全检查：目标非空且不是本程序 → 拒绝（除非显式 --force-target）
  if (plan.targetState.state === 'foreign' && !has('--force-target')) {
    console.error('❌ 目标目录非空，且看起来不是本程序的安装。');
    console.error(`   为避免覆盖你的文件，已中止。请换一个空目录，或加 --force-target 明确承担。`);
    console.error(`   目标：${p.target}`);
    console.error(`   现有内容：${(plan.targetState.sample ?? []).join(', ')}…`);
    return 2;
  }

  if (!apply) {
    console.log('以上为**计划**（默认不执行任何操作）。');
    console.log('确认无误后加 --apply 真正安装。');
    return 0;
  }

  console.log('=== 开始安装 ===');
  const results = execute(p);
  const okCount = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`安装完成：${okCount}/${results.length} 步成功。`);
  console.log('');
  console.log('下一步：');
  console.log(`  1. 生成配置：cd /d "${p.target}" && npm run setup`);
  console.log(`  2. 启动服务：powershell -ExecutionPolicy Bypass -File "${path.join(p.target, 'tools', 'qq-bridge-launcher.ps1')}" -Action startAll`);
  console.log(`  3. 桌面窗口：双击桌面上的「QQ 桥接控制台」`);
  return 0;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) process.exit(main());

export { buildPlan, execute, collectSourceFiles, inspectTarget, createShortcut, MARKER, resolvePaths };
