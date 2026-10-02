// 列出记忆库里指定层的 active 条目（id / 子类 / 重要性 / 长度 / 开头），
// 用于 dream 整理时精确核对"哪些条目还没被归档"。
//
// 用法: node scripts/diag-memory-list.mjs [层=project|topic|lesson|fact|user] [project名]
import { DatabaseSync } from 'node:sqlite';

const level = process.argv[2] ?? 'project';
const projectFilter = process.argv[3] ?? null;
const DB = 'C:/Users/ExampleUser/Documents/.dsh-meow/memory.db';

const db = new DatabaseSync(DB, { readOnly: true });
const cols = db.prepare(`PRAGMA table_info(${level})`).all().map((c) => c.name);
const hasProject = cols.includes('project');
const hasSub = cols.includes('subcategory');

const where = ["status = 'active'"];
const params = [];
if (projectFilter && hasProject) { where.push('project = ?'); params.push(projectFilter); }

const sql = `SELECT id, importance,
  ${hasSub ? 'subcategory' : "'' AS subcategory"},
  ${hasProject ? 'project' : "'' AS project"},
  length(content) AS len, substr(content, 1, 56) AS head
  FROM ${level} WHERE ${where.join(' AND ')} ORDER BY ${hasSub ? 'subcategory, ' : ''}id`;

const rows = db.prepare(sql).all(...params);
console.log(`=== ${level} 层 active${projectFilter ? `（project=${projectFilter}）` : ''} ===`);
let total = 0;
for (const r of rows) {
  total += r.len;
  console.log(`  [${String(r.id).slice(0, 12)}] ${String(r.subcategory || '-').padEnd(10)} imp=${r.importance} len=${String(r.len).padStart(4)} | ${String(r.head).replace(/\s+/g, ' ')}`);
}
console.log('');
console.log(`  合计 ${rows.length} 条，总字符数 ${total}`);
db.close();
