// 清理生命周期日志里的自检污染行。
//
// 背景：test-desktop-lifecycle-log.mjs 早先直接调用生产日志写入，把 [自检-时序]
// 条目混进了用户的操作时间线（用户打开「操作时间线」看到"第一步/第二步"）。
// 测试已改为写临时文件并加了护栏，这里负责清掉历史污染。
//
// 只删自检行，真实操作记录（restartBridgeOnly / startAll / stopAll / restartAll）原样保留。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'state', 'desktop-lifecycle.log');

if (!fs.existsSync(LOG)) {
  console.log('日志不存在，无需清理：', LOG);
  process.exit(0);
}

const before = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim());
const kept = before.filter((l) => !l.includes('[自检'));
const removed = before.length - kept.length;

if (removed === 0) {
  console.log('没有自检污染行，无需清理。');
  process.exit(0);
}

// 备份一份再写，避免误删无法恢复
const backup = `${LOG}.before-cleanup`;
if (!fs.existsSync(backup)) fs.copyFileSync(LOG, backup);

fs.writeFileSync(LOG, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');

console.log(`已清理 ${removed} 行自检记录，保留 ${kept.length} 行真实操作记录。`);
console.log(`原文件已备份为 ${path.basename(backup)}`);
console.log('');
console.log('--- 清理后的内容 ---');
for (const line of kept) console.log(`  ${line}`);
