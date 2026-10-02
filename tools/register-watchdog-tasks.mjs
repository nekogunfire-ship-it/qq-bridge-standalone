// 注册 / 移除**本项目的两个看门狗计划任务**（登录自启）。
//
// 为什么需要它们：
//   · `Bridge Watchdog` —— 守护 QQ 桥接。执行 state/slang-agent/launch-bridge-watchdog.vbs，
//     它会拉起 bridge-watchdog.ps1（三态判定 ok/hung/dead、hung 走 POST /api/restart、
//     限流 MaxRestartsPerHour=6、状态变化写 bridge-watch.log）。
//   · `DSH Watchdog`   —— 守护 DSH 网页子进程并自动同步桥接端点。
//     执行 state/slang-agent/dsh-watchdog-start.cmd。
//
// 二者原本都是"手动启动才生效"，关机重开后不会自启 —— 本脚本补上登录自启。
//
// ⚠️ 注册/删除计划任务需要管理员权限（会弹 UAC）。
// ⚠️ 任务按**用户**全局注册，不区分安装目录。所以同一用户装两份时后注册的会覆盖前一份；
//    卸载端已做归属检查（只删指向自己目录的任务）。
//
// 用法：
//   node tools/register-watchdog-tasks.mjs              # 注册两个任务
//   node tools/register-watchdog-tasks.mjs --check      # 只看现状
//   node tools/register-watchdog-tasks.mjs --remove     # 移除
//   node tools/register-watchdog-tasks.mjs --task bridge|dsh   # 只处理其中一个
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCHDOG_DIR = path.join(ROOT, 'state', 'slang-agent');

const TASKS = [
  {
    key: 'bridge',
    name: 'Bridge Watchdog',
    describe: 'Keep the QQ bridge answering: 3-state health check (ok/hung/dead), auto restart via launcher',
    target: path.join(WATCHDOG_DIR, 'launch-bridge-watchdog.vbs'),
    purpose: '守护 QQ 桥接（VBS 隐藏启动 bridge-watchdog.ps1）'
  },
  {
    key: 'dsh',
    name: 'DSH Watchdog',
    describe: 'Keep the DSH web child alive and auto-sync the QQ bridge endpoint',
    target: path.join(WATCHDOG_DIR, 'dsh-watchdog-start.cmd'),
    purpose: '守护 DSH 网页子进程并同步桥接端点'
  }
];

const argv = process.argv.slice(2);
const doCheck = argv.includes('--check');
const doRemove = argv.includes('--remove');
const onlyIdx = argv.indexOf('--task');
const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
const targets = only ? TASKS.filter((t) => t.key === only || t.name === only) : TASKS;

function schtasks(args) {
  return spawnSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
}

/**
 * 跑外部命令并**正确解码输出**。
 * 坑：PowerShell/schtasks 按控制台代码页（本机 cp936/GBK）输出，Node 按 UTF-8 读会把
 * 中文变成乱码（本机路径含「默认工作区」，显示出来就是 Ĭ�Ϲ�����）。
 * 有 UTF-16LE BOM 按 UTF-16LE 解，否则按 GBK 解（Node 自带 full ICU）。
 */
function runDecoded(cmd, args) {
  const r = spawnSync(cmd, args, { windowsHide: true });
  const buf = r.stdout ?? Buffer.alloc(0);
  if (!buf.length) return { ok: r.status === 0, out: '' };
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else {
    try { text = new TextDecoder('gbk', { fatal: false }).decode(buf); }
    catch { text = buf.toString('utf8'); }
  }
  return { ok: r.status === 0, out: text };
}

/** 用 PowerShell 的对象模型查（查看任务通常不需要提权；schtasks 查询在非提权下会被拒） */
function queryTask(name) {
  const ps = runDecoded('powershell.exe', [
    '-NoProfile', '-Command',
    `$t = Get-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; ` +
    `if (-not $t) { 'NOTASK' } else { "$($t.State)|" + (($t.Actions | ForEach-Object { "$($_.Execute)" }) -join ';') }`
  ]);
  const out = ps.out.trim();
  if (!out || out === 'NOTASK') return null;
  const [state, exec] = out.split('|');
  return { state, exec: exec ?? '' };
}

// ── --check ─────────────────────────────────────────────────────────────────
if (doCheck) {
  console.log('=== 看门狗计划任务现状 ===');
  console.log('');
  for (const t of TASKS) {
    const info = queryTask(t.name);
    console.log(`  ${t.name}`);
    console.log(`    用途  : ${t.purpose}`);
    console.log(`    目标  : ${t.target}`);
    console.log(`    脚本  : ${fs.existsSync(t.target) ? '存在 ✅' : '缺失 ❌'}`);
    if (info) {
      console.log(`    状态  : ${info.state}（已注册）`);
      console.log(`    执行  : ${info.exec}`);
    } else {
      console.log('    状态  : 未注册 ❌ —— 登录时不会自启，看门狗只在手动启动后生效');
    }
    console.log('');
  }
  process.exit(0);
}

// ── --remove ────────────────────────────────────────────────────────────────
if (doRemove) {
  let failed = 0;
  for (const t of targets) {
    const info = queryTask(t.name);
    if (!info) { console.log(`  · ${t.name}：不存在，跳过`); continue; }
    const r = schtasks(['/Delete', '/TN', t.name, '/F']);
    if (r.status === 0) console.log(`  ✅ 已移除 ${t.name}`);
    else { failed += 1; console.error(`  ❌ 移除 ${t.name} 失败：${(r.stdout ?? '') + (r.stderr ?? '')}`); }
  }
  process.exit(failed ? 1 : 0);
}

// ── 注册 ────────────────────────────────────────────────────────────────────
for (const t of targets) {
  if (!fs.existsSync(t.target)) {
    console.error(`❌ 找不到启动目标：${t.target}`);
    process.exit(1);
  }
}

// ⚠️ 只用 SID，不用 whoami 的「域名\用户名」：本机用户名含中文，经
// PowerShell → Node 的编码链路会被破坏成乱码，导致注册失败并报
// 「帐户名与安全标识间无任何映射」。SID 是纯 ASCII，没有这个问题。
const sid = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
  { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
if (!sid) { console.error('❌ 无法取得当前用户 SID'); process.exit(1); }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function taskXml(t) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${esc(t.describe)}</Description>
    <URI>\\${esc(t.name)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(t.target)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

let failed = 0;
for (const t of targets) {
  console.log(`任务名  : ${t.name}（${t.purpose}）`);
  console.log(`执行    : ${t.target}`);
  const xmlPath = path.join(os.tmpdir(), `qb-task-${t.key}-${process.pid}.xml`);
  fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(taskXml(t), 'utf16le')]));
  const r = schtasks(['/Create', '/TN', t.name, '/XML', xmlPath, '/F']);
  try { fs.rmSync(xmlPath, { force: true }); } catch {}
  if (r.status === 0) {
    console.log(`  ✅ 已注册/更新（登录时自动启动）`);
  } else {
    failed += 1;
    console.error(`  ❌ 注册失败：${(r.stdout ?? '') + (r.stderr ?? '')}`);
  }
  console.log('');
}

if (failed) {
  console.error(`❌ ${failed} 个任务注册失败。`);
  console.error('   最常见原因：权限不足 —— 请用管理员身份运行本脚本（创建计划任务需要提权）。');
  process.exit(1);
}
console.log('完成。现在可以立刻验证：');
console.log('  node tools/register-watchdog-tasks.mjs --check');
console.log('  （要立刻跑起来而不等下次登录：schtasks /Run /TN "<任务名>"）');
