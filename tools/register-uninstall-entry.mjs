// 注册/移除 Windows「卸载」条目，让本软件出现在
//   「设置 → 应用 → 已安装的应用」与「控制面板 → 程序和功能」里。
//
// 写的是 HKCU（当前用户）而不是 HKLM（整机）：
//   · 本软件是单用户自用工具，装在自己的目录里，不是系统级安装；
//   · HKCU 通常不需要管理员权限，注册/移除都更轻。
//
// UninstallString 指向仓库根目录的 uninstall.bat —— 它自带提权与确认流程，
// 所以系统「卸载」按钮点下去就是完整的一次交互式卸载。
//
// 用法：
//   node tools/register-uninstall-entry.mjs            # 注册/更新
//   node tools/register-uninstall-entry.mjs --check    # 只看现状
//   node tools/register-uninstall-entry.mjs --remove   # 移除
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop';

const argv = process.argv.slice(2);
const doCheck = argv.includes('--check');
const doRemove = argv.includes('--remove');

function reg(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}

// 把 reg.exe 的输出正确解码。
// 坑：reg query 按**控制台代码页**（本机 cp936）输出，Node 按 UTF-8 读会把中文变成 U+FFFD。
// 好在 Node 自带 full ICU，可以按 GBK 重新解码。解不出来就退回原样，不阻断功能。
function decodeRegOutput(buf) {
  if (!buf) return '';
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function readEntry() {
  const r = spawnSync('reg.exe', ['query', KEY], { windowsHide: true });
  if (r.status !== 0) return null;
  const text = decodeRegOutput(r.stdout);
  const out = {};
  // 注意：split 必须同时处理 \r\n，且正则结尾不能用 `(.*)$` ——
  // JS 的 `.` 不匹配 \r，带 \r 的行会让 `(.*)$` 永远匹配不上（这个 bug 我踩过）。
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// 版本号取自 package.json（没有就退化成 0.0.0）
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function iconPath() {
  const candidates = [
    path.join(ROOT, 'assets', 'dsh.ico'),
    'D:\\DSH\\assets\\dsh.ico',
    'D:\\DSH\\assets\\icon.ico'
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// ── 检查 ────────────────────────────────────────────────────────────────────
if (doCheck) {
  const e = readEntry();
  if (!e) {
    console.log('未注册（系统「应用」列表里不会出现本软件）');
  } else {
    console.log('已注册：');
    for (const k of ['DisplayName', 'DisplayVersion', 'Publisher', 'InstallLocation', 'UninstallString', 'DisplayIcon']) {
      if (e[k]) console.log(`  ${k.padEnd(16)} ${e[k]}`);
    }
  }
  process.exit(0);
}

// ── 移除 ────────────────────────────────────────────────────────────────────
if (doRemove) {
  const r = reg(['delete', KEY, '/f']);
  console.log(r.status === 0 ? '✅ 已移除注册表卸载条目' : '条目不存在或无法删除（可忽略）');
  process.exit(0);
}

// ── 注册 ────────────────────────────────────────────────────────────────────
const uninstallBat = path.join(ROOT, 'uninstall.bat');
if (!fs.existsSync(uninstallBat)) {
  console.error(`❌ 找不到卸载程序：${uninstallBat}`);
  process.exit(1);
}

const icon = iconPath();
const values = [
  ['DisplayName', 'REG_SZ', 'QQ 桥接控制台（QQ Bridge）'],
  ['DisplayVersion', 'REG_SZ', version()],
  ['Publisher', 'REG_SZ', '本机自建'],
  ['InstallLocation', 'REG_SZ', ROOT],
  // 交互式卸载（会弹 UAC 并询问数据去向）
  ['UninstallString', 'REG_SZ', `"${uninstallBat}"`],
  // 静默卸载：保留数据、保留源码 —— 不弹任何提问
  ['QuietUninstallString', 'REG_SZ',
    `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(ROOT, 'tools', 'uninstall-silent.ps1')}" -Mode keep`],
  ['DisplayIcon', 'REG_SZ', icon ?? uninstallBat],
  // 不给「修改/修复」按钮：本软件没有安装程序，改配置请直接编辑 config.json
  ['NoModify', 'REG_DWORD', '1'],
  ['NoRepair', 'REG_DWORD', '1']
];

console.log(`注册表位置: ${KEY}`);
console.log(`  卸载命令  : "${uninstallBat}"`);
console.log(`  静默卸载  : uninstall-quiet.bat（保留数据与源码）`);
if (icon) console.log(`  图标      : ${icon}`);
console.log('');

let failures = 0;
for (const [name, type, data] of values) {
  const r = reg(['add', KEY, '/v', name, '/t', type, '/d', data, '/f']);
  if (r.status !== 0) {
    failures += 1;
    console.error(`  ❌ ${name}: ${(r.stdout ?? '') + (r.stderr ?? '')}`.trim());
  } else {
    console.log(`  ✅ ${name}`);
  }
}

if (failures) {
  console.error(`\n❌ ${failures} 项写入失败`);
  process.exit(1);
}
console.log('\n完成。现在可以在「设置 → 应用 → 已安装的应用」里搜到「QQ 桥接控制台」。');
console.log('（HKCU 条目只对当前用户可见；移除请用 --remove）');
