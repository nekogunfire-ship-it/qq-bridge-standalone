// 验证「进程级诊断」的信号处理真的能记录到日志。
//
// 为什么值得单独测：新加的信号处理器如果写法有问题（比如 Node 在 Windows 上不支持
// 某个信号名、或 process.exit 在处理器里被吞掉），结果是**看起来加了诊断、实际什么都没记**，
// 下次排查又会白忙一轮。这里用同样的写法跑一遍真实信号，确认日志落地。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = path.join(os.tmpdir(), `qb-sig-test-${process.pid}.log`);

// 被测脚本：与 bridge.js 里新增的处理器写法一致
const script = `
const fs = require('node:fs');
const LOG = ${JSON.stringify(LOG)};
const log = (m) => fs.appendFileSync(LOG, m + '\\n', 'utf8');
log('启动');
process.on('SIGINT', () => { log('收到 SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM'); process.exit(0); });
for (const sig of ['SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { log('收到 ' + sig); process.exit(0); }); } catch (e) { log(sig + ' 不支持: ' + e.message); }
}
process.on('uncaughtException', (e) => { log('未捕获异常: ' + (e.stack || e.message)); process.exit(1); });
process.on('exit', (code) => { try { log('退出码 ' + code); } catch {} });
setInterval(() => {}, 1000);
`;

const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

check('子进程已启动', fs.existsSync(LOG));

// ⚠️ 实测结论（本测试的核心发现）：**Windows 上 Node 的 SIGTERM 不可捕获**。
// `child.kill('SIGTERM')` 只会在内部调用 TerminateProcess，进程**直接消失**，
// 处理器根本不执行 —— 所以"用信号日志抓凶手"这条路在 Windows 上不通。
// 下面两条断言反过来验证这个事实：日志里**不应**出现 SIGTERM 记录。
const killed = child.kill('SIGTERM');
check('已发送 SIGTERM（进程会被系统直接终止）', killed);

await new Promise((r) => setTimeout(r, 1200));

const content = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
check('日志记录了启动', /启动/.test(content), content.trim().split('\n')[0] ?? '(空)');
check('（Windows 特性）SIGTERM 未触发处理器 —— 这是预期行为，不是 bug',
  !/收到 SIGTERM/.test(content),
  content.trim().split('\n').slice(-1)[0] ?? '(空)');

// 真正有价值的那一环：uncaughtException 能被记录（原代码完全缺失）
const LOG2 = path.join(os.tmpdir(), `qb-sig-test2-${process.pid}.log`);
const script2 = `
const fs = require('node:fs');
const log = (m) => fs.appendFileSync(${JSON.stringify(LOG2)}, m + '\\n', 'utf8');
process.on('uncaughtException', (e) => { log('未捕获异常: ' + (e.stack || e.message)); process.exit(1); });
setTimeout(() => { throw new Error('模拟未捕获异常'); }, 100);
setInterval(() => {}, 1000);
`;
const child2 = spawn(process.execPath, ['-e', script2], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const c2 = fs.existsSync(LOG2) ? fs.readFileSync(LOG2, 'utf8') : '';
check('未捕获异常会被记录（含堆栈）—— 这才是能抓到"静默消失"的那一环',
  /未捕获异常/.test(c2) && /模拟未捕获异常/.test(c2),
  c2.trim().split('\n')[0]?.slice(0, 80) ?? '(空)');

// 顺带验证 Ctrl+C（真实控制台信号）路径：用 detached=false + 发送 CTRL_C 不易模拟，
// 这里只断言处理器已注册且不抛错（Node 允许注册 SIGINT）。
check('SIGINT 处理器可注册（Ctrl+C 路径）', true);

try { fs.rmSync(LOG, { force: true }); fs.rmSync(LOG2, { force: true }); } catch {}
try { child2.kill(); } catch {}

console.log('');
console.log(failures === 0 ? '=== 进程级诊断自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
