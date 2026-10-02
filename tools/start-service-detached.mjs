// 以「脱离父进程」的方式启动服务，避免进程生命期被调起它的 shell/任务绑住。
//
// 背景：直接用 pwsh 调 launcher 启动 SnowLuma 时，若那条命令随后被取消（job_kill），
// 已启动的服务会跟着一起消失 —— 进程挂在调用者的进程树里。
// 这里用 `Start-Process -WindowStyle Hidden` 让 launcher 脱离当前作业，
// 再用轮询等待端口就绪（不依赖 launcher 的返回，避免它自身卡住时误判失败）。
//
// 用法: node tools/start-service-detached.mjs <snowluma|bridge|dsh>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['snowluma', 'bridge', 'dsh'].includes(target)) {
  console.error('用法: node tools/start-service-detached.mjs <snowluma|bridge|dsh>');
  process.exit(2);
}

const PORTS = { snowluma: [3000, 3001], bridge: [3100], dsh: [3780] }[target];

function portUp(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(900);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}

const allUp = async () => {
  for (const p of PORTS) if (!(await portUp(p))) return false;
  return true;
};

if (await allUp()) {
  console.log(`[start-detached] ${target} 已在运行（${PORTS.join('/')} 在监听），无需启动。`);
  process.exit(0);
}

console.log(`[start-detached] 以脱离方式启动 ${target} …`);
const ps = path.join(ROOT, 'tools', 'qq-bridge-launcher.ps1');
// 脱离式：不继承 stdio、隐藏窗口、独立进程
const child = spawn('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', ps,
  '-Action', 'start', '-Target', target
], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
void spawnSync; void fs;

// 轮询端口（最多 90 秒），不依赖 launcher 返回
const deadline = Date.now() + 90_000;
let up = false;
while (Date.now() < deadline) {
  if (await allUp()) { up = true; break; }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(up
  ? `[start-detached] ✅ ${target} 已就绪（端口 ${PORTS.join('/')} 在监听）`
  : `[start-detached] ❌ 90 秒内未就绪，请查看 state/bridge.log 或 launcher 日志`);
process.exit(up ? 0 : 1);
