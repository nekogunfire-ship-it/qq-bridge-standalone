// 生命周期日志的自检：确认 mark 记录的是**各自调用时**的时间戳。
//
// 背景：早先的实现在结尾统一读 Date.now()，导致所有 mark 拿到同一个值、
// 在时间线里显示成完全相同的 +X.Xs（用户实测贴出的日志就是三个相同的 +91.8s），
// 时间线因此失去"哪一步慢"的诊断价值。
//
// ⚠️ 本测试**必须把日志写到临时文件**：早先直接写生产日志，结果用户打开
//「操作时间线」看到 [自检-时序] 第一步/第二步 混在真实操作里（已污染过用户的日志）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startLifecycleRun,
  readLifecycleLog,
  setLifecycleLogFile,
  lifecycleLogFile
} from '../desktop/lib/lifecycle-log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_LOG = path.join(ROOT, 'state', 'desktop-lifecycle.log');

// 关键：把日志指向临时文件，绝不写生产日志
const TMP_LOG = path.join(os.tmpdir(), `qbd-lifecycle-test-${process.pid}.log`);
fs.rmSync(TMP_LOG, { force: true });
setLifecycleLogFile(TMP_LOG);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 记录测试开始前生产日志里的自检条目数，结束时对比，确保没有新增
const countProdTestRuns = () => {
  try {
    const t = fs.readFileSync(PROD_LOG, 'utf8');
    return (t.match(/\[自检-时序\] 开始/g) ?? []).length;
  } catch {
    return 0;
  }
};
const prodTestRunsBefore = countProdTestRuns();

try {
  check('日志路径已被重定向到临时文件', lifecycleLogFile() === TMP_LOG, lifecycleLogFile());

  const run = startLifecycleRun('自检-时序');

  // 制造三段可区分耗时
  await new Promise((r) => setTimeout(r, 120));
  run.mark('第一步');
  await new Promise((r) => setTimeout(r, 260));
  run.mark('第二步');
  await new Promise((r) => setTimeout(r, 130));
  const summary = run.done({ ok: true });

  check('mark 返回递增的耗时', summary.marks.length === 2
    && summary.marks[0].ms < summary.marks[1].ms,
    summary.marks.map((m) => `${m.label}=${m.ms}ms`).join(' '));

  check('相邻 mark 的差值约等于实际等待（不是同一个时间戳）',
    summary.marks[1].ms - summary.marks[0].ms >= 200,
    `差值 ${summary.marks[1].ms - summary.marks[0].ms}ms（期望 ≥200ms）`);

  check('每个 mark 都带独立 ISO 时间戳',
    summary.marks.every((m) => typeof m.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(m.at))
    && summary.marks[0].at !== summary.marks[1].at,
    summary.marks.map((m) => m.at).join(' | '));

  check('总耗时大于最后一步的耗时',
    summary.totalMs > summary.marks[summary.marks.length - 1].ms,
    `total=${summary.totalMs}ms last=${summary.marks[summary.marks.length - 1].ms}ms`);

  const written = fs.readFileSync(TMP_LOG, 'utf8');
  const deltas = [...written.matchAll(/\+(\d+\.\d)s /g)].map((m) => m[1]);
  check('日志里各步骤耗时互不相同（不是同一个值重复）',
    new Set(deltas).size >= 2, deltas.join(', '));

  check('readLifecycleLog 能读回内容（已过滤自检条目）',
    readLifecycleLog(10).length === 0,
    '临时日志里全是自检条目，读取时应被过滤掉 → 返回 0 条是正确的');

  // 生产日志必须没有被本次测试写入 —— 这是本测试最重要的护栏
  const prodTestRunsAfter = countProdTestRuns();
  check('本次测试没有向生产日志写入新条目',
    prodTestRunsAfter === prodTestRunsBefore,
    `测试前 ${prodTestRunsBefore} 条 → 测试后 ${prodTestRunsAfter} 条`);
} finally {
  try { fs.rmSync(TMP_LOG, { force: true }); } catch {}
  setLifecycleLogFile(null);
}

console.log('');
console.log(failures === 0 ? '=== 生命周期日志自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
