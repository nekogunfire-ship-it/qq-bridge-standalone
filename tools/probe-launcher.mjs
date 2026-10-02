// 用我们的封装调 launcher，看实际拿到什么（含退出码与原始输出）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherStatus, launcherDiagnose, runLauncher } from '../desktop/lib/launcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const [label, fn] of [['status', launcherStatus], ['diagnose', launcherDiagnose]]) {
  const r = await fn(ROOT);
  console.log(`--- ${label} ---`);
  console.log(`  ok=${r.ok} exitCode=${r.exitCode} payload=${r.payload ? 'JSON' : 'null'} error=${r.error ?? '-'}`);
  if (r.payload) console.log(`  顶层字段: ${Object.keys(r.payload).join(', ')}`);
  const so = (r.stdout ?? '').trim();
  console.log(`  stdout 前 120 字: ${so.slice(0, 120).replace(/\s+/g, ' ') || '(空)'}`);
  const se = (r.stderr ?? '').trim();
  if (se) console.log(`  stderr 前 200 字: ${se.slice(0, 200).replace(/\s+/g, ' ')}`);
  console.log('');
}

// 单独试一次原始调用，确认 CLI 形态
const raw = await runLauncher(ROOT, 'status');
console.log(`--- 原始调用 --- ok=${raw.ok} exitCode=${raw.exitCode}`);
