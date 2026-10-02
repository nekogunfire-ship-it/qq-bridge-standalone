// 桥接/网关生命周期管理：封装 tools/qq-bridge-launcher.ps1。
//
// 为什么走 launcher 而不是自己 spawn node：
//   launcher 是仓库的权威启动器，已实现 startAll/stopAll/restartAll/status/diagnose/logs，
//   并且停止进程时**不需要管理员权限**（实测通过）。桌面应用只做调用与展示，
//   不复制这套逻辑，避免两处状态判断不一致。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LAUNCHER = path.join('tools', 'qq-bridge-launcher.ps1');

// launcher 输出的 JSON 里带 BOM / 非 JSON 前缀时，取最后一个完整 JSON 对象。
function extractJson(text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  return null;
}

/**
 * 调用 launcher 的某个 Action。
 * @param {string} root 仓库根目录（仅用于 cwd —— launcher 自身用 $PSScriptRoot 推导路径，
 *                      所以**不要**传 -Root，它没有这个参数）
 * @param {string} action status | diagnose | logs | startAll | stopAll | restartAll | start | stop | syncEndpoint | openDsh
 * @param {{ target?: 'dsh'|'snowluma'|'bridge', logName?: string, tail?: number, timeoutMs?: number, powershell?: string }} [options]
 */
// 为什么用 -OutFile + stdio:'ignore' 而不是管道抓 stdout：
//
//   launcher 在 start/stop/restart 时会用 Start-Process 拉起**常驻**进程（桥接/DSH）。
//   那些进程会**继承父进程的管道句柄**，于是管道永远等不到 EOF，node 的 'close' 事件
//   永不触发 —— 表现为「launcher 超时（90s）」，而实际上桥接已经重启成功了
//   （实测：时间线报失败 91.8s，但桥接 PID 已变、日志有新的「桥接已启动」；
//    同样的命令在终端里同步跑只要 1.2 秒）。
//
//   这个坑此前在 restart 脚本上踩过一次（当时的修法是「Start-Process + 输出重定向到
//   文件 + 轮询」），这里是同一个坑的复发。launcher 自带 -OutFile（写 UTF-8 无 BOM 的
//   JSON），正好用来彻底绕开管道：把输出写文件，进程退出或超时后再读文件。
export function runLauncher(root, action, options = {}) {
  const { target, logName, tail, timeoutMs = 180_000, powershell = 'powershell.exe' } = options;

  // 结果是一次性 IPC 文件，不是项目状态。放系统临时目录可支持只读安装目录，
  // 也避免权限不足时 launcher 已成功、桌面端却只能得到 null payload。
  const outFile = path.join(os.tmpdir(), `qq-bridge-launcher-${process.pid}-${Date.now().toString(36)}.json`);
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, LAUNCHER),
    '-Action', action,
    '-OutFile', outFile
  ];
  if (target) args.push('-Target', target);
  if (logName) args.push('-LogName', logName);
  if (Number.isInteger(tail)) args.push('-Tail', String(tail));

  return new Promise((resolve) => {
    let child;
    try {
      // stdio:'ignore' —— 不建立任何管道，常驻子进程无从继承
      child = spawn(powershell, args, { cwd: root, windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, action, error: `无法启动 launcher：${error?.message ?? error}` });
      return;
    }

    let settled = false;
    const finish = (note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const payload = readOutFile(outFile);
      const code = child.exitCode;
      resolve({
        ok: payload?.ok === true || code === 0,
        action,
        exitCode: code,
        payload,
        // -OutFile 模式下没有 stdout/stderr；保留字段以兼容既有调用方
        stdout: payload ? JSON.stringify(payload) : '',
        stderr: '',
        note
      });
    };

    const timer = setTimeout(() => {
      // 超时：进程可能卡住，但输出文件往往已经写好 —— 先尝试读它再下结论
      const payload = readOutFile(outFile);
      try { child.kill(); } catch {}
      if (settled) return;
      settled = true;
      resolve({
        ok: payload?.ok === true,
        action,
        exitCode: child.exitCode,
        payload,
        stdout: payload ? JSON.stringify(payload) : '',
        stderr: '',
        timedOut: !payload,
        error: payload ? undefined : `launcher 超时（${Math.round(timeoutMs / 1000)}s）且未产出结果文件`
      });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, action, error: `launcher 执行失败：${error?.message ?? error}` });
    });
    child.on('close', (code) => finish(`进程退出码 ${code}`));
  });
}

function readOutFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = extractJson(text);
    try { fs.rmSync(file, { force: true }); } catch {}
    return parsed;
  } catch {
    return null;
  }
}


// 语义化的便捷封装：UI 直接调这些
export const launcherStatus = (root, o) => runLauncher(root, 'status', { ...o, timeoutMs: o?.timeoutMs ?? 30_000 });
export const launcherDiagnose = (root, o) => runLauncher(root, 'diagnose', { ...o, timeoutMs: o?.timeoutMs ?? 60_000 });
export const launcherStartAll = (root, o) => runLauncher(root, 'startAll', o);
export const launcherStopAll = (root, o) => runLauncher(root, 'stopAll', { ...o, timeoutMs: o?.timeoutMs ?? 60_000 });
export const launcherRestartAll = (root, o) => runLauncher(root, 'restartAll', o);

// ComfyUI（出图服务，可选）。冷启动要 30~60 秒加载底模才开始监听 8188，
// 所以这里给的时间预算比其它动作宽；端口先起来的话会立刻返回。
export const launcherStartComfy = (root, o) => runLauncher(root, 'start', { target: 'comfy', timeoutMs: o?.timeoutMs ?? 180_000, ...o });
export const launcherStopComfy = (root, o) => runLauncher(root, 'stop', { target: 'comfy', timeoutMs: o?.timeoutMs ?? 60_000, ...o });

// ── 分档重启 ────────────────────────────────────────────────────────────────
//
// restartAll 实测约 2 分 35 秒（stopAll → 等端口 → startAll，内部多个 60s 等待），
// 而且**连 DSH 一起重启**——DSH 是用户网页端的宿主，重启它会打断正在使用的会话。
// 所以拆成两档：
//   bridgeOnly：只重启桥接（stop bridge → start bridge）。改桥接代码时够用，
//               快得多，且不碰 DSH / SnowLuma。
//   full      ：全量重启（含 DSH）。只在需要 DSH 重新挂载 MCP 工具面时用。
export async function launcherRestartBridgeOnly(root, options = {}) {
  const t0 = Date.now();
  const stop = await runLauncher(root, 'stop', { ...options, target: 'bridge', timeoutMs: options.timeoutMs ?? 45_000 });
  const steps = [{ step: 'stop bridge', ok: stop.ok, ms: Date.now() - t0, error: stop.error }];
  if (!stop.ok) {
    return { ok: false, action: 'restartBridgeOnly', error: stop.error ?? '停止桥接失败', steps, elapsedMs: Date.now() - t0 };
  }
  const t1 = Date.now();
  const start = await runLauncher(root, 'start', { ...options, target: 'bridge', timeoutMs: options.timeoutMs ?? 90_000 });
  steps.push({ step: 'start bridge', ok: start.ok, ms: Date.now() - t1, error: start.error });
  return {
    ok: start.ok,
    action: 'restartBridgeOnly',
    error: start.ok ? undefined : (start.error ?? '启动桥接失败'),
    payload: start.payload ?? stop.payload,
    stdout: [stop.stdout, start.stdout].filter(Boolean).join('\n'),
    stderr: [stop.stderr, start.stderr].filter(Boolean).join('\n'),
    steps,
    elapsedMs: Date.now() - t0
  };
}
