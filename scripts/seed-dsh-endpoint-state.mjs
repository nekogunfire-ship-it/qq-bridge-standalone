// 播种 DSH 端点状态：把「已知的上一个端点」写进状态文件，
// 这样下一次体检就能把刚发生过的重启识别为"端点变化"并留下记录。
//
// 用途：dsh-watch 监测功能是事后加的，之前发生的掉线没有基准可比。若已知
// 重启前后的端点（例如从 manager.log 或对话上下文里读到），可以据此补一次记录。
//
// 用法: node scripts/seed-dsh-endpoint-state.mjs <上一个端点>
//   例: node scripts/seed-dsh-endpoint-state.mjs http://127.0.0.1:57203
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state', 'dsh-endpoint-state.json');

const previous = process.argv[2];
if (!previous) {
  console.error('用法: node scripts/seed-dsh-endpoint-state.mjs <上一个端点 URL>');
  process.exit(2);
}

const norm = String(previous).replace(/\?.*$/, '').replace(/\/+$/, '');
const now = Date.now();
// downSince 设为一个较早的时刻，让"期间不可用"有合理数值（由调用方在体检前手动核对）
const state = { url: norm, lastUrl: norm, seenAt: now, downSince: null };

fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
console.log(`已播种状态：lastUrl=${norm}`);
console.log('下次运行桌面版体检（或 node scripts/test-desktop-core.mjs）时，');
console.log('若当前 DSH 端点不同，就会在 state/dsh-restart.log 里记下这次变化。');
