// 生命周期操作日志：记录每次启停/重启的耗时与结果。
//
// 为什么需要：用户点「重启」时如果界面看起来卡住，事后必须能回答
// "它到底跑了多久、卡在哪一步、成功没有"。实测一次 restartAll 约 2 分 35 秒，
// 期间没有任何反馈 —— 有这份时间线就能判断是慢还是真的挂了。
//
// 输出到 state/desktop-lifecycle.log（追加写，便于对比多次操作）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOG = path.join(ROOT, 'state', 'desktop-lifecycle.log');

// 可注入的日志路径：测试必须把它指到临时文件，否则自检数据会混进用户的操作时间线
// （实际发生过：用户打开「操作时间线」看到 [自检-时序] 第一步/第二步，一头雾水）。
let logFile = DEFAULT_LOG;

/** 覆盖日志路径（仅供测试使用）。传 null 恢复默认。 */
export function setLifecycleLogFile(file) {
  logFile = file ?? DEFAULT_LOG;
}

export function lifecycleLogFile() {
  return logFile;
}

function append(line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch {}
}

/** 开一次操作记录，返回 { mark, done }。 */
export function startLifecycleRun(action) {
  const startedAt = Date.now();
  const id = `${new Date().toISOString()} [${action}]`;
  append(`${id} 开始`);
  const marks = [];

  return {
    /** 记录一个中间节点（如"launcher 已返回""体检完成"）。 */
    mark(label) {
      // ⚠️ 必须在**调用时**取时间戳。早先的写法是结尾统一读 Date.now()，
      // 结果所有 mark 拿到同一个值、显示成完全相同的 +X.Xs，时间线失去意义。
      const at = Date.now();
      const delta = at - startedAt;
      marks.push({ label, ms: delta, at: new Date(at).toISOString() });
      append(`${id}   +${(delta / 1000).toFixed(1)}s ${label}`);
      return delta;
    },
    /** 收尾：写结果与总耗时。 */
    done(result) {
      const total = Date.now() - startedAt;
      const ok = result?.ok ? '成功' : '失败';
      append(`${id} 结束（${ok}，总耗时 ${(total / 1000).toFixed(1)}s）${result?.error ? ` 错误=${result.error}` : ''}`);
      return { totalMs: total, marks };
    }
  };
}

/** 读取最近 N 条生命周期日志，供 UI 展示。 */
export function readLifecycleLog(limit = 60) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    // 过滤掉自检条目：即便历史日志里混进过测试数据，也不该展示给用户
    const lines = text.trim().split('\n').filter((l) => !l.includes('[自检'));
    return lines.slice(-limit);
  } catch {
    return [];
  }
}
