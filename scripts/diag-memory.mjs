// meow-memory 记忆库诊断工具（合并了原先 6 个 diag-memory-*.mjs 一次性脚本）。
//
// 为什么需要它：meow-memory 的记忆库是「按工作区各存一份」的 SQLite，工具调用返回成功
// 不代表条目真的落库（相似内容会被去重合并），所以需要能直接读库核对。
//
// 用法：
//   node scripts/diag-memory.mjs                      # 汇总（表统计 + 最近条目 + 非 active）
//   node scripts/diag-memory.mjs --scan               # 发现并汇总所有记忆库
//   node scripts/diag-memory.mjs --recent 20          # 最近 20 条
//   node scripts/diag-memory.mjs --project qq-bridge  # 只看某个 project
//   node scripts/diag-memory.mjs --level lesson       # 只看某个 level
//   node scripts/diag-memory.mjs --status archived    # 只看某个状态
//   node scripts/diag-memory.mjs --db <path>          # 指定库文件
//   node scripts/diag-memory.mjs --json               # 输出 JSON（便于再加工）
//
// 只读：一律以 readOnly 打开，绝不修改记忆库。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';

const LEVELS = ['soul', 'user', 'rules', 'fact', 'lesson', 'topic', 'project'];

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      scan: { type: 'boolean', default: false },
      recent: { type: 'string', default: '8' },
      project: { type: 'string' },
      level: { type: 'string' },
      status: { type: 'string' },
      db: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false, short: 'h' }
    },
    allowPositionals: true
  }));
} catch (error) {
  console.error(`参数错误：${error.message}`);
  process.exit(2);
}

if (opts.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (error) {
  console.error(`node:sqlite 不可用（需要 Node >= 22.13）：${error.message}`);
  process.exit(1);
}

// ── 记忆库发现 ──────────────────────────────────────────────────────────────
// 不硬编码本机路径：从若干根目录按深度受限地找 .dsh-meow/memory.db。
function discoverDatabases() {
  const roots = [
    process.cwd(),
    path.join(os.homedir(), 'Documents'),
    path.join(process.cwd(), 'state')
  ];
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === '.dsh-meow') {
        const dbFile = path.join(full, 'memory.db');
        if (fs.existsSync(dbFile)) found.add(dbFile.replace(/\\/g, '/'));
        continue;
      }
      walk(full, depth + 1);
    }
  };
  for (const r of roots) {
    if (fs.existsSync(r)) walk(r, 0);
  }
  return [...found].sort();
}

function openDb(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function countOf(db, table, where = '', params = []) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).n;
  } catch {
    return 0;
  }
}

// 统一的汇总：表统计 + 最近条目 + 非 active 明细
function summarize(file, { recent, project, level, status }) {
  const db = openDb(file);
  if (!db) return { file, error: '打开失败（不是 SQLite 或权限不足）' };

  const levels = LEVELS.filter((t) => tableExists(db, t));
  const tables = {};
  for (const t of levels) {
    tables[t] = {
      total: countOf(db, t),
      active: countOf(db, t, "status = 'active'"),
      archived: countOf(db, t, "status = 'archived'"),
      stale: countOf(db, t, "status = 'stale'")
    };
  }

  // 最近条目：按 id 倒序（meow-memory 的 id 单调递增，等价于时间序）
  const union = levels
    .map((t) => {
      const cols = columnsOf(db, t);
      const proj = cols.includes('project') ? 'project' : "'' AS project";
      return `SELECT '${t}' AS tbl, id, status, ${proj}, content FROM ${t}`;
    })
    .join(' UNION ALL ');

  const where = [];
  const params = [];
  if (project) { where.push('project = ?'); params.push(project); }
  if (level) { where.push('tbl = ?'); params.push(level); }
  if (status) { where.push('status = ?'); params.push(status); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  let rows = [];
  try {
    rows = db.prepare(`SELECT * FROM (${union})${whereSql} ORDER BY id DESC LIMIT ?`).all(...params, Number(recent) || 8);
  } catch { rows = []; }

  // 非 active 明细：**同一套过滤条件也要应用**，否则一旦带上 --level/--project，
  // 这段会把不相关的条目也列出来，看起来像过滤失效。
  //
  // status 语义：未指定 → 列出所有非 active；'active' → 不列（只看活跃条目时无意义）；
  // 'all' → 列出所有非 active；其他具体值 → 只列该状态。
  const showNonActive = status === undefined || status === 'all' || status !== 'active';
  const nonActive = [];
  if (showNonActive) {
    for (const t of levels) {
      if (level && t !== level) continue;
      const cols = columnsOf(db, t);
      const hasProject = cols.includes('project');
      const where2 = ["status != 'active'"];
      const params2 = [];
      if (project && hasProject) { where2.push('project = ?'); params2.push(project); }
      if (status && status !== 'all') { where2.push('status = ?'); params2.push(status); }
      try {
        const sel = `SELECT id, status, content${hasProject ? ', project' : ", '' AS project"} FROM ${t} WHERE ${where2.join(' AND ')}`;
        for (const r of db.prepare(sel).all(...params2)) nonActive.push({ tbl: t, ...r });
      } catch {}
    }
  }

  db.close();
  return { file, levels, tables, recent: rows, nonActive };
}

function fmt(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function printSummary(s) {
  console.log('='.repeat(72));
  console.log(s.file);
  if (s.error) { console.log(`  ${s.error}`); return; }
  console.log(`  大小 ${(fs.statSync(s.file).size / 1024).toFixed(0)} KB`);

  const totals = { total: 0, active: 0, archived: 0, stale: 0 };
  for (const t of s.levels) {
    const v = s.tables[t];
    if (!v.total) continue;
    for (const k of Object.keys(totals)) totals[k] += v[k];
    console.log(`  ${t.padEnd(8)} 共 ${String(v.total).padStart(3)} | active ${String(v.active).padStart(3)} | archived ${String(v.archived).padStart(2)} | stale ${String(v.stale).padStart(2)}`);
  }
  console.log(`  ${'合计'.padEnd(7)} 共 ${String(totals.total).padStart(3)} | active ${String(totals.active).padStart(3)} | archived ${String(totals.archived).padStart(2)} | stale ${String(totals.stale).padStart(2)}`);

  if (s.recent.length) {
    console.log('');
    console.log('  --- 最近条目 ---');
    for (const r of s.recent) {
      console.log(`    [${String(r.id).slice(0, 12)}] ${r.tbl}/${r.status} ${r.project || ''} | ${fmt(r.content, 58)}`);
    }
  }
  if (s.nonActive.length) {
    console.log('');
    console.log(`  --- 非 active（${s.nonActive.length} 条）---`);
    for (const r of s.nonActive) {
      console.log(`    [${String(r.id).slice(0, 12)}] ${r.tbl}/${r.status}${r.project ? ` ${r.project}` : ''} | ${fmt(r.content, 52)}`);
    }
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const filter = {
  recent: opts.recent,
  project: opts.project,
  level: opts.level,
  status: opts.status
};

// 目标库的选取：
//   --db <path>  精确指定
//   否则自动发现 —— 记忆库按工作区各存一份，当前工作区不一定有，
//   所以默认就把找得到的都列出来，避免"默认模式查了个空"的困惑。
const targets = opts.db ? [path.resolve(opts.db)] : discoverDatabases();

if (!targets.length) {
  console.log('未发现任何记忆库（搜索 .dsh-meow/memory.db）。');
  console.log('可用 --db <path> 直接指定库文件。');
  process.exit(1);
}

const results = [];
for (const file of targets) {
  if (!fs.existsSync(file)) { results.push({ file: file.replace(/\\/g, '/'), error: '文件不存在' }); continue; }
  results.push(summarize(file.replace(/\\/g, '/'), filter));
}

if (opts.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  if (opts.scan) console.log(`发现 ${results.length} 个记忆库\n`);
  for (const r of results) {
    printSummary(r);
    console.log('');
  }
}

// 只有确实读到了库才算成功：便于脚本化使用（例如 CI 里断言"记忆库存在且可读"）。
const readable = results.filter((r) => !r.error).length;
if (!readable) {
  for (const r of results) console.error(`无法读取记忆库：${r.file}${r.error ? `（${r.error}）` : ''}`);
}
process.exit(readable > 0 ? 0 : 1);
