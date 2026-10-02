// 卸载的**归属检查**自检 —— 守一个我真实造成过的破坏。
//
// 事故背景：沙箱测试跑 `--execute` 时，`execute()` 按**任务名**无条件删除计划任务、
// 无条件删除注册表卸载项。而计划任务与注册表项都是**按用户全局**的，不受 `--root` 约束 ——
// 于是沙箱测试把真实安装的 `DSH Watchdog` 任务与注册表卸载项删掉了。
//
// 也就是说：文件层面的隔离做对了，**全局系统状态层面没有**。
// 修复：卸载前先核对归属（任务动作路径 / 注册表 InstallLocation 是否指向本 ROOT），
// 不属于就跳过。本测试就守这条。
//
// 做法：在一个**独立沙箱目录**（路径与真实仓库不同）里跑 `--execute`，
// 然后断言"真实系统的任务与注册表项**依然存在**"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(REPO, 'tools', 'uninstall-core.mjs');
const SANDBOX = path.join(os.tmpdir(), `qb-ownership-sandbox-${process.pid}`);
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop';
const TASKS = ['Bridge Watchdog', 'DSH Watchdog'];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** 正确解码外部命令输出（本机代码页 GBK，路径含中文） */
function runDecoded(cmd, args) {
  const r = spawnSync(cmd, args, { windowsHide: true });
  const buf = r.stdout ?? Buffer.alloc(0);
  if (!buf.length) return { ok: r.status === 0, out: '' };
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else { try { text = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch { text = buf.toString('utf8'); } }
  return { ok: r.status === 0, out: text };
}

function taskExists(name) {
  const r = runDecoded('powershell.exe', ['-NoProfile', '-Command',
    `if (Get-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`]);
  return r.out.trim() === 'YES';
}

function registryExists() {
  const r = runDecoded('reg.exe', ['query', REG_KEY]);
  return r.ok;
}

// ── 记录"作案前"的真实系统状态 ──────────────────────────────────────────────
const tasksBefore = Object.fromEntries(TASKS.map((t) => [t, taskExists(t)]));
const regBefore = registryExists();
console.log('=== 真实系统状态（测试前）===');
for (const t of TASKS) console.log(`  ${t}: ${tasksBefore[t] ? '存在' : '不存在'}`);
console.log(`  注册表卸载项: ${regBefore ? '存在' : '不存在'}`);
console.log('');
if (!tasksBefore['Bridge Watchdog'] && !regBefore) {
  console.log('SKIP 真实系统上既没有任务也没有注册表项 —— 没有可被误删的东西，本测试无从验证。');
  console.log('     请先运行 node tools/register-watchdog-tasks.mjs 与 node tools/register-uninstall-entry.mjs。');
  process.exit(0);
}

// ── 造一个"另一份安装"的沙箱 ────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(500), 'utf8');
fs.mkdirSync(path.join(SANDBOX, 'desktop', 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, 'config.json'), '{"ownerQQ":"1"}', 'utf8');
fs.mkdirSync(path.join(SANDBOX, 'state'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, 'state', 'bridge.log'), 'log', 'utf8');

// ── 桌面隔离 + 快照（2026-09-26 事故后补）────────────────────────────────────
// 🔴 事故：本测试原本**没有覆盖 `USERPROFILE`** → `inventory()` 用真实的
//    `process.env.USERPROFILE` 扫了**用户的真实桌面**，把 `QQ 桥接控制台.lnk`
//    删掉了（当时 `execute()` 删快捷方式**没有归属检查**，只按文件名粗筛）。
//    而注册表项因为有 `InstallLocation` 检查所以活了下来 ——
//    症状就是"快捷方式没了、卸载项还在"，且**测试全绿、毫无提示**。
// 两层防护：① 本测试把 USERPROFILE 指到沙箱；② 前后快照比对真实桌面（漏了就红）。
const FAKE_HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(path.join(FAKE_HOME, 'Desktop'), { recursive: true });
const REAL_DESKTOP = path.join(os.homedir(), 'Desktop');
const listDesktop = () => {
  try { return fs.readdirSync(REAL_DESKTOP).filter((f) => f.toLowerCase().endsWith('.lnk')).sort(); }
  catch { return []; }
};
const realDesktopBefore = listDesktop();
console.log(`  （安全网）真实桌面 .lnk 数：${realDesktopBefore.length}；USERPROFILE 将指向沙箱`);

// ── 守卫：确认作用在沙箱 ────────────────────────────────────────────────────
const planRun = spawnSync(process.execPath, [TOOL, '--root', SANDBOX, '--json', '--keep-data'], {
  cwd: REPO, encoding: 'utf8', windowsHide: true, env: { ...process.env, USERPROFILE: FAKE_HOME }
});
let plan = null;
try { plan = JSON.parse(planRun.stdout ?? ''); } catch {}
if (!plan || path.resolve(plan.repo) !== path.resolve(SANDBOX)) {
  console.error(`🛑 中止：作用对象不是沙箱（实际 ${plan?.repo ?? '(解析失败)'}）`);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
check('守卫通过：卸载作用在沙箱路径', true, plan.repo);

// 计划里应明确写出"会跳过他人的任务"
check('计划里声明会跳过不属于本目录的任务',
  /跳过/.test(JSON.stringify(plan.steps)), '（计划含「跳过」步骤）');

// ── 真跑 execute（非提权：任务删除本就无权，但我们断言的是"根本没去删"）────
const execRun = spawnSync(process.execPath, [TOOL, '--root', SANDBOX, '--keep-data', '--execute', '--elevated-ok'], {
  cwd: REPO, encoding: 'utf8', windowsHide: true, env: { ...process.env, USERPROFILE: FAKE_HOME }
});
const execOut = (execRun.stdout ?? '') + (execRun.stderr ?? '');

// ── 关键断言：真实系统的任务、注册表项、桌面快捷方式必须原封不动 ──────────────
for (const t of TASKS) {
  if (!tasksBefore[t]) { console.log(`INFO ${t} 测试前就不存在，跳过该断言`); continue; }
  check(`沙箱卸载后真实任务「${t}」仍存在`, taskExists(t),
    taskExists(t) ? '未被误删' : '❌ 被误删了！');
}
if (regBefore) {
  check('沙箱卸载后注册表卸载项仍存在', registryExists(),
    registryExists() ? '未被误删' : '❌ 被误删了！');
}
// ★ 2026-09-26 事故后新增：真实桌面的快捷方式也必须一个不少
//    （上次就是这条缺失 —— 快捷方式被删而测试全绿）
const realDesktopAfter = listDesktop();
check('★ 沙箱卸载后真实桌面快捷方式**一个不少**',
  JSON.stringify(realDesktopAfter) === JSON.stringify(realDesktopBefore),
  realDesktopAfter.length === realDesktopBefore.length
    ? `${realDesktopBefore.length} 个，清单一致`
    : `❌ 少了：${realDesktopBefore.filter((f) => !realDesktopAfter.includes(f)).join('、')}`);

// 归属跳过要有明确说明（便于用户理解为什么没删干净）
check('执行报告里说明了跳过原因',
  /不属于本次卸载目标|指向另一份安装/.test(execOut) || !tasksBefore['Bridge Watchdog'],
  execOut.split('\n').filter((l) => /跳过/.test(l)).slice(0, 2).join(' | ').slice(0, 160));

// 沙箱自己的东西该删的删了（证明 execute 本身在工作，不是整个没跑）
check('沙箱自己的 node_modules 已被删除（execute 确实执行了）',
  !fs.existsSync(path.join(SANDBOX, 'node_modules')));

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? '=== 卸载归属检查自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
