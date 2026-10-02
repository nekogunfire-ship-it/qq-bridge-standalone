// DSH 重启监测：把「DSH 端点变化」这个信号变成可见的记录。
//
// 为什么需要：用户抱怨过两次「DSH 掉线」。DSH 重启时端口会变（如 57203 → 59935），
// 桥接会短暂重连、用户网页端会断开。而这件事过去只能靠翻 manager.log 才知道——
// manager.log 里是「已退出 code=5」这类底层信息，用户看不懂，我也难判断根因。
//
// 做法：每次体检记录当前 DSH 端点；下次体检发现端点变了，就写一条带时间与前后端点的
// 记录到 state/dsh-restart.log。这样"什么时候掉过线、掉了多久"一目了然，也就不必
// 再去猜是不是自己某个操作造成的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_FILE = path.join(ROOT, 'state', 'dsh-restart.log');
const DEFAULT_STATE = path.join(ROOT, 'state', 'dsh-endpoint-state.json');

let logFile = DEFAULT_FILE;
let stateFile = DEFAULT_STATE;

/** 覆盖日志与状态文件路径（仅供测试使用；不重定向的话测试会污染生产状态）。传 null 恢复默认。 */
export function setDshRestartLogFile(file) {
  logFile = file ?? DEFAULT_FILE;
}

export function setDshStateFile(file) {
  stateFile = file ?? DEFAULT_STATE;
}

export function dshRestartLogFile() {
  return logFile;
}

export function dshStateFile() {
  return stateFile;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {}
}

/**
 * 观察一次 DSH 端点。返回 { changed, previous, current, downSince }。
 * previous/current 形如 "http://127.0.0.1:63223"；url 为空表示当时 DSH 不可用。
 */
export function observeDshEndpoint(url) {
  const now = Date.now();
  // 归一化：去掉 query（含令牌，不该落盘）与末尾斜杠，避免同一端点被判成不同
  const normalize = (u) => (u ? String(u).replace(/\?.*$/, '').replace(/\/+$/, '') : null);
  const current = normalize(url);
  const prev = readState();

  // 首次观察：建立基准，不算变化
  if (!prev) {
    writeState({ url: current, lastUrl: current, seenAt: now, downSince: current ? null : now });
    return { changed: false, previous: null, current, first: true };
  }

  // lastUrl 保存"最后一次见到的端点"，即使中途 DSH 不可用也不丢 ——
  // 否则端点变化（= 重启）会被误判成"恢复"，丢掉最关键的信号。
  const lastUrl = prev.lastUrl ?? prev.url ?? null;
  const wasDown = prev.url == null;
  const downSince = current ? null : (prev.downSince ?? now);

  let event = null;
  if (current && lastUrl && current !== lastUrl) {
    event = 'changed';
  } else if (!current && prev.url) {
    event = 'down';
  } else if (current && wasDown) {
    event = 'recovered';
  }

  const downForSec = prev.downSince ? Math.round((now - prev.downSince) / 1000) : null;
  if (event) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const stamp = new Date().toISOString();
      const suffix = downForSec != null && downForSec > 0 ? `（期间不可用约 ${downForSec}s）` : '';
      const text = {
        changed: `${stamp} DSH 端点变化（已重启）：${lastUrl} → ${current}${suffix}`,
        down: `${stamp} DSH 变为不可用（原 ${lastUrl}）`,
        recovered: `${stamp} DSH 恢复可用：${current}${suffix}`
      }[event];
      fs.appendFileSync(logFile, `${text}\n`, 'utf8');
    } catch {}
  }

  const nextLast = current ?? lastUrl;
  writeState({ url: current, lastUrl: nextLast, seenAt: now, downSince: downSince ?? null });
  return {
    changed: event === 'changed',
    event,
    previous: lastUrl,
    current,
    downSince: downSince ?? null,
    downForSec
  };
}

/** 读取最近的重启记录，供 UI 展示。 */
export function readDshRestartLog(limit = 40) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    return text.trim().split('\n').filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}
