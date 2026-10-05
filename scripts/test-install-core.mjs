// 安装程序的自检 —— 这是本项目**风险最高**的工具（会写注册表、建快捷方式，可选注册计划任务）。
//
// 本项目已经因为"沙箱测试动了全局状态"破坏过用户的 DSH Watchdog 任务与注册表项，
// 所以这里的隔离必须覆盖**每一类副作用**：
//   ① 文件      → --target 指向沙箱
//   ② 桌面      → 用 USERPROFILE 重定向到沙箱
//   ③ 开始菜单  → 用 APPDATA 重定向到沙箱
//   ④ 注册表    → --reg-key 换成一次性测试键名（并在结束时删掉）
//   ⑤ 计划任务  → 测试里**不开** --with-watchdogs（它按用户全局，无法用参数隔离）
// 并且最后断言真实系统（真实桌面、真实注册表项、真实任务）**全部未变**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../desktop/lib/health.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(REPO, 'tools', 'install-core.mjs');
const SANDBOX = path.join(os.tmpdir(), `qb-install-sandbox-${process.pid}`);
const TARGET = path.join(SANDBOX, 'app');
const FAKE_HOME = path.join(SANDBOX, 'home');
const FAKE_APPDATA = path.join(SANDBOX, 'appdata');
const FAKE_LOCALAPPDATA = path.join(SANDBOX, 'localappdata');
const TEST_REG_KEY = `qq-bridge-desktop-SELFTEST-${process.pid}`;
const TEST_REG_PATH = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${TEST_REG_KEY}`;
const REAL_REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function runDecoded(cmd, args, env) {
  const r = spawnSync(cmd, args, { windowsHide: true, env: env ?? process.env });
  const buf = r.stdout ?? Buffer.alloc(0);
  if (!buf.length) return { ok: r.status === 0, out: '' };
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else { try { text = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch { text = buf.toString('utf8'); } }
  return { ok: r.status === 0, out: text };
}

const sandboxEnv = {
  ...process.env,
  USERPROFILE: FAKE_HOME,
  APPDATA: FAKE_APPDATA,
  LOCALAPPDATA: FAKE_LOCALAPPDATA
};
const runTool = (args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: 'utf8', windowsHide: true, env: sandboxEnv });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const regExists = (key) => runDecoded('reg.exe', ['query', key]).ok;

// ── 记录真实系统状态（用于最后的"没被碰过"断言）────────────────────────────
const realRegBefore = regExists(REAL_REG_PATH);
const realDesktopBefore = fs.readdirSync(path.join(os.homedir(), 'Desktop')).filter((f) => f.endsWith('.lnk')).sort();
const realTasksBefore = runDecoded('powershell.exe', ['-NoProfile', '-Command',
  `(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'Watchdog' } | ForEach-Object { $_.TaskName }) -join ','`]).out.trim();
console.log('=== 真实系统状态（测试前）===');
console.log(`  注册表卸载项: ${realRegBefore ? '存在' : '不存在'}`);
console.log(`  桌面 .lnk 数: ${realDesktopBefore.length}`);
console.log(`  看门狗任务  : ${realTasksBefore || '(无)'}`);
console.log('');

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

// ── 1. 计划模式：不创建任何东西 ─────────────────────────────────────────────
const planRun = runTool(['--target', TARGET]);
check('默认（不加 --apply）只出计划', planRun.status === 0 && /以上为\*\*计划\*\*/.test(planRun.out),
  planRun.out.includes('计划') ? '已提示为计划' : planRun.out.slice(-100));
check('计划模式不创建目标目录', !fs.existsSync(TARGET));
const optionalPlan = runTool(['--target', TARGET, '--with-comfy', '--with-image-model', '--comfy-variant', 'intel']);
check('计划列出可选 ComfyUI 环境', optionalPlan.status === 0 && /安装 ComfyUI 环境/.test(optionalPlan.out));
check('计划保留所选显卡版本', /intel/.test(optionalPlan.out));
check('计划列出 SDXL 模型与许可证', /SDXL Base 1\.0/.test(optionalPlan.out) && /Open RAIL/.test(optionalPlan.out));
check('可选组件仍保持计划模式，不启动大文件下载', !fs.existsSync(TARGET));

// ── 2. 拒绝写入"无关的非空目录"（防覆盖用户文件）───────────────────────────
const foreign = path.join(SANDBOX, 'foreign');
fs.mkdirSync(foreign, { recursive: true });
fs.writeFileSync(path.join(foreign, 'my-important-file.txt'), 'do not touch', 'utf8');
const foreignRun = runTool(['--target', foreign, '--apply', '--skip-npm', '--skip-setup']);
check('拒绝安装到无关的非空目录', foreignRun.status === 2, `退出码 ${foreignRun.status}`);
check('拒绝时未写入任何东西', (() => {
  const entries = fs.readdirSync(foreign);
  return entries.length === 1 && entries[0] === 'my-important-file.txt';
})(), fs.readdirSync(foreign).join(', '));

// ── 2b. 安装后自动配置：全程在独立目标中，不触碰真实配置 ────────────────
const autoTarget = path.join(SANDBOX, 'auto-config-app');
const autoInstall = runTool([
  '--target', autoTarget, '--apply', '--skip-npm', '--no-dsh'
]);
let autoConfig = null;
let autoState = null;
try { autoConfig = JSON.parse(fs.readFileSync(path.join(autoTarget, 'config.json'), 'utf8')); } catch {}
try { autoState = JSON.parse(fs.readFileSync(path.join(autoTarget, 'state', 'post-install.json'), 'utf8')); } catch {}
check('安装后自动生成首次配置', autoInstall.status === 0 && Boolean(autoConfig));
check('不安装 DSH 时自动选择 direct 运行时', autoConfig?.runtime?.type === 'direct');
check('自动生成不含密钥的待办状态', autoState?.autoConfigured === true && Array.isArray(autoState?.remaining));
check('自动配置过程有明确结果', /自动首次配置/.test(autoInstall.out));

// ── 3. 真安装（依赖与看门狗跳过；全局路径全部重定向）───────────────────────
const installRun = runTool([
  '--target', TARGET, '--apply', '--skip-npm', '--skip-setup',
  '--with-shortcuts', '--with-uninstall-entry', '--reg-key', TEST_REG_KEY
]);
check('安装返回成功', installRun.status === 0, installRun.out.trim().split('\n').slice(-1)[0]);

// 3a. 文件
check('程序文件已复制', fs.existsSync(path.join(TARGET, 'src', 'bridge.js'))
  && fs.existsSync(path.join(TARGET, 'package.json'))
  && fs.existsSync(path.join(TARGET, 'uninstall.bat')));
check('未复制 node_modules / state / config.json', !fs.existsSync(path.join(TARGET, 'node_modules'))
  && !fs.existsSync(path.join(TARGET, 'state'))
  && !fs.existsSync(path.join(TARGET, 'config.json')));
check('已写安装标记 .qq-bridge-install.json', fs.existsSync(path.join(TARGET, '.qq-bridge-install.json')));
check('标记里记录了创建了哪些全局项', (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(TARGET, '.qq-bridge-install.json'), 'utf8'));
    return m.kind === 'qq-bridge-install' && Array.isArray(m.created?.shortcuts);
  } catch { return false; }
})());

// 3b. 快捷方式（落在沙箱桌面/开始菜单里）
const sbDesktop = path.join(FAKE_HOME, 'Desktop');
const sbMenu = path.join(FAKE_APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'QQ 桥接');
check('桌面快捷方式建在沙箱桌面里', fs.existsSync(path.join(sbDesktop, 'QQ 桥接控制台.lnk')),
  fs.existsSync(sbDesktop) ? fs.readdirSync(sbDesktop).join(', ') : '(桌面目录不存在)');
check('开始菜单项已建立', fs.existsSync(sbMenu) && fs.readdirSync(sbMenu).length >= 3,
  fs.existsSync(sbMenu) ? fs.readdirSync(sbMenu).join(', ') : '(未建立)');
check('开始菜单含「卸载」入口', fs.existsSync(sbMenu) && fs.readdirSync(sbMenu).some((f) => /卸载/.test(f)));

// 3c. RunAsAdmin 位（本机 electron.exe 必须提权；桌面前快捷方式需要它）
check('桌面快捷方式带「以管理员身份运行」位', (() => {
  const lnk = path.join(sbDesktop, 'QQ 桥接控制台.lnk');
  if (!fs.existsSync(lnk)) return false;
  const buf = fs.readFileSync(lnk);
  return (buf[0x15] & 0x20) !== 0;
})());

// 3d. 注册表（一次性测试键名）
check('注册表卸载项已写入（用测试键名）', regExists(TEST_REG_PATH));
if (regExists(TEST_REG_PATH)) {
  const q = runDecoded('reg.exe', ['query', TEST_REG_PATH, '/v', 'InstallLocation']);
  const m = q.out.split(/\r?\n/).map((l) => l.match(/InstallLocation\s+REG_\w+\s+(.*?)\s*$/)).find(Boolean);
  check('注册表里的 InstallLocation 指向本沙箱安装目录',
    Boolean(m) && path.resolve(m[1]).toLowerCase() === TARGET.toLowerCase(), m ? m[1] : '(读不到)');
}

// ── 4. 覆盖安装：保留已有 config.json ───────────────────────────────────────
fs.writeFileSync(path.join(TARGET, 'config.json'), '{"ownerQQ":"keep-me"}', 'utf8');
fs.mkdirSync(path.join(TARGET, 'state'), { recursive: true });
fs.writeFileSync(path.join(TARGET, 'state', 'bridge.log'), 'my history', 'utf8');
fs.writeFileSync(path.join(TARGET, 'README.md'), 'stale program file', 'utf8');
const reinstall = runTool([
  '--target', TARGET, '--apply', '--skip-npm', '--skip-setup',
  '--with-shortcuts', '--with-uninstall-entry', '--reg-key', TEST_REG_KEY
]);
check('覆盖安装成功（识别为已有安装而非无关目录）', reinstall.status === 0,
  reinstall.out.split('\n').find((l) => /目标现状/.test(l))?.trim() ?? '');
check('覆盖安装保留了 config.json', (() => {
  try { return JSON.parse(fs.readFileSync(path.join(TARGET, 'config.json'), 'utf8')).ownerQQ === 'keep-me'; }
  catch { return false; }
})());
check('覆盖安装保留了 state/', fs.existsSync(path.join(TARGET, 'state', 'bridge.log')));
check('覆盖安装会更新旧程序文件',
  fs.readFileSync(path.join(TARGET, 'README.md'), 'utf8') === fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'));
check('应用自身配置读取逻辑能自动读到上次保留的数据',
  readConfig(TARGET)?.ownerQQ === 'keep-me');
check('应用运行数据在重装后内容不变',
  fs.readFileSync(path.join(TARGET, 'state', 'bridge.log'), 'utf8') === 'my history');

// ── 5. 归属检查：注册表项登记的是别处时不得覆盖 ─────────────────────────────
const other = path.join(SANDBOX, 'app2');
fs.mkdirSync(other, { recursive: true });
runDecoded('reg.exe', ['add', TEST_REG_PATH, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', other, '/f']);
const hijack = runTool([
  '--target', TARGET, '--apply', '--skip-npm', '--skip-setup', '--with-uninstall-entry', '--reg-key', TEST_REG_KEY
]);
const q2 = runDecoded('reg.exe', ['query', TEST_REG_PATH, '/v', 'InstallLocation']);
const m2 = q2.out.split(/\r?\n/).map((l) => l.match(/InstallLocation\s+REG_\w+\s+(.*?)\s*$/)).find(Boolean);
check('注册表项登记的是别处时不被覆盖', Boolean(m2) && path.resolve(m2[1]).toLowerCase() === other.toLowerCase(),
  m2 ? m2[1] : '(读不到)');
check('且报告里说明了未覆盖', /已存在且登记的是别处|未覆盖/.test(hijack.out));

// ── 6. 真实系统必须一丝未动 ─────────────────────────────────────────────────
check('真实注册表卸载项未被触碰', regExists(REAL_REG_PATH) === realRegBefore,
  `${realRegBefore} → ${regExists(REAL_REG_PATH)}`);
check('真实桌面未被触碰（.lnk 清单一致）', (() => {
  const now = fs.readdirSync(path.join(os.homedir(), 'Desktop')).filter((f) => f.endsWith('.lnk')).sort();
  return JSON.stringify(now) === JSON.stringify(realDesktopBefore);
})(), `原来 ${realDesktopBefore.length} 个`);
check('真实看门狗任务未被触碰', (() => {
  const now = runDecoded('powershell.exe', ['-NoProfile', '-Command',
    `(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'Watchdog' } | ForEach-Object { $_.TaskName }) -join ','`]).out.trim();
  return now === realTasksBefore;
})(), `${realTasksBefore} → 现在`);

// ── --no-dsh：安装时不装 DSH 的可选依赖（用户要求"安装时选是否用 DSH 环境"）──────
// 只验**计划文案**与参数被接受：真跑 npm install --omit=optional 要联网且慢，
// 而"跳过了哪个包"这件事已由 scripts/experiment-missing-dsh-package.mjs 单独验证过。
{
  const sbNoDsh = path.join(os.tmpdir(), `qb-install-nodsh-${process.pid}`);
  fs.rmSync(sbNoDsh, { recursive: true, force: true });
  const planNoDsh = runTool(['--target', sbNoDsh, '--no-dsh']);
  const txtNoDsh = planNoDsh.out ?? '';
  check('--no-dsh 被接受（计划生成成功）', planNoDsh.status === 0, `退出码 ${planNoDsh.status}`);
  check('计划里写明"不装 DSH"', /不装 DSH/.test(txtNoDsh),
    (txtNoDsh.split('\n').find((l) => /不装 DSH/.test(l)) ?? '').trim().slice(0, 90));
  check('计划里写明会用 --omit=optional', /--omit=optional/.test(txtNoDsh));
  check('计划里说明了运行时将是 direct', /direct/.test(txtNoDsh));
  check('--no-dsh 只是计划，未落盘（默认 dry-run）', !fs.existsSync(sbNoDsh));

  // 对照：不给 --no-dsh 时计划应说明"含 DSH"
  const planDsh = runTool(['--target', sbNoDsh]);
  const txtDsh = planDsh.out ?? '';
  check('不给 --no-dsh 时计划说明会装上 DSH 的 SDK', /含 DSH|DSH 的 SDK/.test(txtDsh),
    (txtDsh.split('\n').find((l) => /DSH/.test(l)) ?? '').trim().slice(0, 90));
  fs.rmSync(sbNoDsh, { recursive: true, force: true });
}

// ── 收尾：删掉测试注册表键与沙箱 ────────────────────────────────────────────
runDecoded('reg.exe', ['delete', TEST_REG_PATH, '/f']);
check('测试用注册表键已清理', !regExists(TEST_REG_PATH));
fs.rmSync(SANDBOX, { recursive: true, force: true });
check('沙箱已清理', !fs.existsSync(SANDBOX));

console.log('');
console.log(failures === 0 ? '=== 安装程序自检通过 ===' : `=== ${failures} 项失败 ===`);
if (failures && regExists(TEST_REG_PATH)) runDecoded('reg.exe', ['delete', TEST_REG_PATH, '/f']);
process.exit(failures === 0 ? 0 : 1);
