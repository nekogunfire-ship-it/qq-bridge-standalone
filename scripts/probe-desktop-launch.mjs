// 桌面版启动诊断探针：逐组测试 Electron 启动参数，找出哪一套能让应用真正启动。
//
// 背景：用户机器上 Electron 启动时报
//   GPU process launch failed: error_code=18
//   FATAL: GPU process isn't usable. Goodbye.
// 随后整个应用退出（窗口一闪即没）。需要确定关闭 GPU 的哪组开关能绕过它。
//
// 判据：应用启动成功时会往 state/desktop.log 写一行，且日志里有「窗口与托盘已创建」。
// 每组参数用**独立的 userData 目录**，避免上一组的缓存污染下一组（用户日志里
// GPUPersistentCache 被占用（0x20）正是这类污染）。
//
// 用法：node scripts/probe-desktop-launch.mjs          （跑全部组合）
//       node scripts/probe-desktop-launch.mjs --only 3 （只跑第 3 组）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const LOG = path.join(ROOT, 'state', 'desktop.log');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');

const CASES = [
  { name: 'A. 默认（不加任何开关）', flags: [] },
  { name: 'B. 仅 --disable-gpu', flags: ['--disable-gpu'] },
  { name: 'C. disable-gpu + 软件光栅', flags: ['--disable-gpu', '--disable-software-rasterizer'] },
  { name: 'D. 上面 + 禁用 GPU 合成', flags: ['--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing'] },
  { name: 'E. 上面 + 禁用 GPU 沙箱', flags: ['--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing', '--disable-gpu-sandbox'] },
  { name: 'F. 上面 + no-sandbox', flags: ['--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--no-sandbox'] },
  { name: 'G. 上面 + 禁用 DirectComposition', flags: ['--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--no-sandbox', '--disable-direct-composition'] }
];

const WAIT_MS = 12_000;
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx >= 0 ? Number(process.argv[onlyIdx + 1]) : null;

if (!fs.existsSync(ELECTRON)) {
  console.error(`找不到 Electron：${ELECTRON}\n先在 desktop 目录执行 npm install。`);
  process.exit(1);
}

// 确保日志文件存在，便于比较新增内容
fs.mkdirSync(path.dirname(LOG), { recursive: true });

function readLog() {
  try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; }
}

function tryCase(testCase, index) {
  return new Promise((resolve) => {
    const userData = path.join(os.tmpdir(), `qbd-probe-${index}-${Date.now()}`);
    const before = readLog();
    const out = [];

    const child = spawn(ELECTRON, [DESKTOP, ...testCase.flags, `--user-data-dir=${userData}`], {
      cwd: DESKTOP,
      env: { ...process.env, QQ_BRIDGE_GPU: '0' }
    });

    child.stdout?.on('data', (d) => out.push(d.toString('utf8')));
    child.stderr?.on('data', (d) => out.push(d.toString('utf8')));

    let settled = false;
    const finish = (ok, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      setTimeout(() => { try { fs.rmSync(userData, { recursive: true, force: true }); } catch {} }, 1500);

      const after = readLog();
      const appended = after.slice(before.length);
      const created = /窗口与托盘已创建/.test(appended);
      const gpuFatal = /GPU process isn't usable/.test(out.join(''));
      const code = child.exitCode;

      console.log(`  ${ok || created ? '✅' : '❌'} ${testCase.name}`);
      console.log(`      日志新增: ${created ? '有「窗口与托盘已创建」' : '(无)'}`);
      console.log(`      进程退出码: ${code ?? '(仍在运行，已结束)'}${gpuFatal ? ' | 出现 GPU fatal' : ''}`);
      if (note) console.log(`      备注: ${note}`);
      resolve({ ok: created, name: testCase.name, exitCode: code, gpuFatal });
    };

    const timer = setTimeout(() => finish(false, `${WAIT_MS / 1000}s 内未看到启动成功日志`), WAIT_MS);

    child.on('error', (e) => finish(false, `无法启动：${e.message}`));
    child.on('close', (exitCode) => {
      if (settled) return;
      // 进程自己退出了 —— 看日志判断是否曾成功启动
      const after = readLog();
      const appended = after.slice(before.length);
      const created = /窗口与托盘已创建/.test(appended);
      if (created) {
        finish(true, `进程退出了（exit=${exitCode}），但启动日志已写入 —— 可能是单实例锁或窗口被关`);
      } else {
        finish(false, `进程退出 exit=${exitCode}，且没有启动成功日志`);
      }
    });
  });
}

(async function main() {
  console.log('=== 桌面版启动诊断探针 ===');
  console.log(`Electron: ${ELECTRON}`);
  console.log(`日志文件: ${LOG}`);
  console.log(`每组最多等 ${WAIT_MS / 1000} 秒\n`);

  const results = [];
  const list = only != null && Number.isInteger(only) ? [CASES[only]].filter(Boolean) : CASES;
  if (only != null && !list.length) {
    console.error(`--only ${only} 超出范围（0..${CASES.length - 1}）`);
    process.exit(2);
  }

  for (let i = 0; i < list.length; i += 1) {
    const realIndex = only != null ? only : i;
    results.push(await tryCase(list[i], realIndex));
    console.log('');
  }

  const winners = results.filter((r) => r.ok);
  console.log('=== 结论 ===');
  if (winners.length) {
    console.log(`  ✅ 能成功启动的组合：${winners.map((w) => w.name).join('、')}`);
    console.log('  建议：把最先成功的那组开关写进 desktop/main.mjs（或启动脚本）后重试。');
  } else {
    console.log('  ❌ 所有组合都未能启动 —— 该环境下 Electron 不可用。');
    console.log('  可选退路：改用系统自带浏览器（Edge/Chrome）承载界面，');
    console.log('            由 Node 提供本地管理页 + 启停能力，不依赖 Chromium 内嵌。');
  }
  fs.writeFileSync(path.join(ROOT, 'state', 'desktop-probe-result.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\n  结果已存 state/desktop-probe-result.json');
})();
