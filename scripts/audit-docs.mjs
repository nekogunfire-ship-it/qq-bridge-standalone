// 文档审计：找出"写着但已经不对"的地方。
//
// 做这个是因为 README 有 27.8 KB 且近期改动很大，而它同时要承担两个角色：
// ① 自己看的说明书；② 分发时收件人的入口。文档里一条失效的路径引用，
// 对收件人来说就是"按说明做但报错"。
//
// 检查项：
//   1. **失效路径引用**：文档里 `反引号` 包起来的仓库内路径，实际是否存在
//   2. **孤儿文档**：没有被任何其它文档引用的 .md（用户在意这一点，见 .gitignore 里的注释）
//   3. **失效的 npm 脚本引用**：文档里写 `npm run xxx`，package.json 里是否真有
//   4. **失效的文档间链接**：`[文字](路径)` 指向的 md 是否存在
//   5. **个人信息**：docs/ 与 README 里是否含真实 QQ 号 / 群号（脱敏准备）
//   6. **陈旧标记**：TODO / FIXME / 待补充 之类
//
// 用法: node scripts/audit-docs.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

// 收集所有文档（排除运行时目录与依赖）
// ⚠️ 要按**路径段**排除，不能只匹配开头：desktop/node_modules/ 这类嵌套依赖
//    会让审计结果被几百个第三方 README 淹没（第一次跑就踩到了）。
const EXCLUDE_SEGMENTS = new Set(['node_modules', 'state', 'archive', 'dist', '.git']);

function collectDocs() {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (rel.split('/').some((seg) => EXCLUDE_SEGMENTS.has(seg))) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      if (e.isFile() && e.name.endsWith('.md')) out.push({ rel, abs });
    }
  };
  walk(ROOT);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const docs = collectDocs();
const docSet = new Set(docs.map((d) => d.rel));

// ── 隐私值（从真实配置现取，与打包工具的思路一致）──────────────────────────
function realSecrets() {
  const out = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.ownerQQ) out.push({ label: '你的 QQ 号', value: String(cfg.ownerQQ) });
    for (const g of cfg.allow?.groups ?? []) out.push({ label: '群白名单', value: String(g) });
    for (const p of cfg.allow?.private ?? []) out.push({ label: '私聊白名单', value: String(p) });
  } catch { /* 没配置就跳过这项检查 */ }
  return out;
}
const secrets = realSecrets();

// ── npm 脚本清单 ───────────────────────────────────────────────────────────
let npmScripts = new Set();
try {
  npmScripts = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {}));
} catch {}

// 把文档里的相对链接解析成相对仓库根的路径
function resolveRel(docRel, link) {
  const docDir = path.dirname(docRel);
  const joined = path.posix.normalize(path.posix.join(docDir, link.replace(/\\/g, '/')));
  return joined.replace(/^\.\//, '');
}

// 运行时状态文件的名字：文档里写它们是对的，但它们不在版本库里（state/ 被 gitignore），
// 所以**不能**当成"失效引用"。第一版审计在这里制造了大量误报。
const RUNTIME_BASENAMES = new Set([
  'mode.json', 'current-role.json', 'bridge.log', 'console-token', 'social-v2.json',
  'slang.json', 'tool-calls.jsonl', 'desktop.log', 'desktop-settings.json',
  'dsh-restart.log', 'dsh-endpoint-state.json', 'bridge.lock', 'electron-profile'
]);

/** 引用是否可能指向仓库内（用于过滤外部路径与纯文件名） */
function isRepoLocalCandidate(cand) {
  if (!cand) return false;
  if (cand.startsWith('~')) return false;                       // ~/.dsh/... 在用户主目录
  if (/^[a-zA-Z]:[\\/]/.test(cand)) return false;               // D:\... 绝对路径
  if (cand.startsWith('/') || cand.startsWith('\\')) return false; // 绝对路径
  if (cand.includes('${') || cand.includes('<')) return false;  // 模板变量/占位
  if (cand.startsWith('...') || cand.startsWith('…')) return false; // 省略号前缀
  if (/^\.[a-z0-9]+$/i.test(cand)) return false;                // 纯扩展名（.bat/.ps1/.png）
  if (cand.includes('/state/') || cand.startsWith('state/')) return false; // 运行时目录
  return true;
}

/**
 * 解析引用：先按"相对本文档所在目录"，再按"相对仓库根"，最后按"同名文件存在于仓库任意处"。
 * 返回命中的仓库内相对路径，或 null。
 *
 * ⚠️ 必须做这三层，否则误报会把真问题淹没：`desktop/README.md` 里写 `main.mjs`
 * 指的是 `desktop/main.mjs`（相对本文档），只按仓库根解析就会全部报"不存在"。
 */
const allRepoFiles = null; // 延迟构建
let repoFileIndex = null;
function buildRepoFileIndex() {
  if (repoFileIndex) return repoFileIndex;
  const names = new Map(); // basename -> [relPath]
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (rel.split('/').some((seg) => EXCLUDE_SEGMENTS.has(seg))) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      const list = names.get(e.name) ?? [];
      list.push(rel);
      names.set(e.name, list);
    }
  };
  walk(ROOT);
  repoFileIndex = names;
  return names;
}

function resolveRef(docRel, cand) {
  if (!isRepoLocalCandidate(cand)) return { ok: true, why: '外部/运行时/纯扩展名，跳过' };
  const base = path.posix.basename(cand);
  if (RUNTIME_BASENAMES.has(base)) return { ok: true, why: '运行时状态文件，跳过' };
  const fromDocDir = resolveRel(docRel, cand);
  for (const p of [fromDocDir, cand]) {
    if (p && fs.existsSync(path.join(ROOT, p))) return { ok: true, path: p };
  }
  // 纯文件名（无目录部分）：只要仓库里存在同名文件就算命中（文档常这样简称）
  if (!cand.includes('/')) {
    const list = buildRepoFileIndex().get(cand);
    if (list?.length) return { ok: true, path: list[0] };
  }
  return { ok: false };
}

/**
 * 这一行是不是在"说明某东西已被移除/归档"？
 *
 * 文档里合法地会出现"`npm run xxx` 已移除，改用 yyy"这种句子 —— 里面的旧名字
 * 当然找不到，但那是**正确的写法**。不加这个判断，审计会把解释文字本身报成问题
 * （修完文档后我立刻踩到：失效引用数反而涨了）。
 */
const REMOVAL_MARKERS = /(已移除|已归档|已废弃|已取消|不再|原本|原先|曾经|改为|替代|移除|归档|废弃|deprecated|removed)/;
function lineIsAboutRemoval(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return REMOVAL_MARKERS.test(line);
}

// 仓库里真实存在的一级目录名 —— 用来判断一个引用"是不是明确指向仓库内"
const TOP_DIRS = new Set(
  fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name.toLowerCase())
);

/**
 * 协议名（不是文件路径）—— JSON-RPC / MCP 的方法名长得就像路径，
 * 而且恰好以仓库真实存在的目录名开头（`tools/list` 撞上 `tools/`）。
 * 不排除掉就会被误报成"引用了不存在的文件"。
 */
const PROTOCOL_NAMES = new Set([
  'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list',
  'resources/templates/list', 'notifications/initialized', 'completion/complete'
]);

/**
 * 区分置信度：
 *   high = 引用路径里带了**仓库真实存在的一级目录**（如 `scripts/foo.mjs`），
 *          那它明确在指仓库内的东西，不存在就是真失效；
 *   low  = 裸文件名（`dsh.cmd`、`launcher.bat`）或指向外部目录（`lib/client.js`），
 *          很可能指外部程序（SnowLuma / DSH 自己的文件）或协议名（`tools/list`），
 *          **只作提示、不计入问题数** —— 否则真问题会被噪音淹没。
 */
function confidenceOf(cand) {
  if (PROTOCOL_NAMES.has(cand.toLowerCase())) return 'protocol';
  const first = cand.split('/')[0].toLowerCase();
  return TOP_DIRS.has(first) ? 'high' : 'low';
}
// ── 逐文档分析 ─────────────────────────────────────────────────────────────
// 只有在"看起来就是仓库内路径"时才检查存在性，避免把示例、外部 URL、
// 运行时生成的文件误判为失效引用。
const RUNTIME_OK = [
  'state/', 'dist/', 'archive/', 'node_modules/', 'config.json',
  'desktop/node_modules', '.git/'
];
const looksLikeRepoPath = (s) =>
  /\.(mjs|js|cjs|json|md|bat|cmd|ps1|yml|yaml|html|png|ico|txt|sln)$/i.test(s)
  || /^(src|scripts|tools|desktop|dsh|plugins|public|docs|roles|assets)\//.test(s);

const problems = {
  brokenPaths: [],
  unconfirmedPaths: [],
  brokenLinks: [],
  badNpm: [],
  orphanDocs: [],
  secrets: [],
  staleMarks: []
};
const referenced = new Set();
const perDoc = [];

for (const d of docs) {
  const text = fs.readFileSync(d.abs, 'utf8');
  const isTemplate = d.rel.endsWith('config.example.json'); // 只为防御，md 不会是
  void isTemplate;

  // 1) 反引号里的路径
  const codeSpans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  for (const span of codeSpans) {
    // 去掉命令行前缀，只留路径
    let cand = span
      .replace(/^(node|npm run|powershell -ExecutionPolicy Bypass -File|cd \/d)\s+/i, '')
      .replace(/\s+.*$/, '')
      .replace(/^["']|["']$/g, '')
      .replace(/^\.\//, '')
      .replace(/\\(?=[\w\u4e00-\u9fff])/g, '/')
      .trim();
    if (!cand || cand.includes('://') || cand.startsWith('-')) continue;
    if (!looksLikeRepoPath(cand)) continue;
    if (RUNTIME_OK.some((p) => cand.startsWith(p))) continue;
    // 去掉尾部标点
    cand = cand.replace(/[，。、；：)）]+$/, '');
    if (cand.endsWith('/') || cand.includes('*') || cand.includes('…')) continue;
    const res = resolveRef(d.rel, cand);
    if (!res.ok && !lineIsAboutRemoval(text, text.indexOf(span))) {
      // 按置信度分流：明确指向仓库目录的才算问题，裸文件名/外部目录只作提示
      if (confidenceOf(cand) === 'high') problems.brokenPaths.push({ doc: d.rel, ref: cand });
      else problems.unconfirmedPaths.push({ doc: d.rel, ref: cand });
    } else if (res.path?.endsWith('.md')) {
      referenced.add(res.path);
    }
  }

  // 2) 文档间链接 [文字](路径.md)
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+\.md)(#[^)]*)?\)/g)) {
    const resolved = m[1].startsWith('/') ? m[1].slice(1) : resolveRel(d.rel, m[1]);
    if (docSet.has(resolved)) { referenced.add(resolved); continue; }
    if (fs.existsSync(path.join(ROOT, resolved))) { referenced.add(resolved); continue; }
    problems.brokenLinks.push({ doc: d.rel, ref: m[1] });
  }

  // 3) npm run xxx
  for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    const name = m[1];
    if (npmScripts.has(name)) continue;
    if (lineIsAboutRemoval(text, m.index)) continue;
    problems.badNpm.push({ doc: d.rel, script: name });
  }

  // 4) 隐私值
  for (const s of secrets) {
    if (text.includes(s.value)) problems.secrets.push({ doc: d.rel, label: s.label, count: text.split(s.value).length - 1 });
  }

  // 5) 陈旧标记
  for (const m of text.matchAll(/^.*\b(TODO|FIXME|XXX|待补充|待填|占位)\b.*$/gm)) {
    problems.staleMarks.push({ doc: d.rel, line: m[0].trim().slice(0, 100) });
  }

  perDoc.push({ rel: d.rel, bytes: fs.statSync(d.abs).size, lines: text.split('\n').length });
}

// 6) 孤儿文档：没有被任何文档引用（README 与自己是例外）
//
// `roles/*.md` 不算文档：它们是**角色设定数据**，由程序读取、本来就无需被文档引用。
// 把数据文件当"孤儿文档"报出来只会制造噪音。
const ORPHAN_EXEMPT = [/^roles\/.+\.md$/, /^README\.md$/, /^desktop\/node_modules\//];
for (const d of docs) {
  if (ORPHAN_EXEMPT.some((re) => re.test(d.rel))) continue;
  if (referenced.has(d.rel)) continue;
  problems.orphanDocs.push(d.rel);
}

// ── 输出 ───────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify({ docs: perDoc, problems }, null, 2));
  process.exit(0);
}

console.log('=== 文档审计 ===');
console.log('');
console.log(`  文档 ${docs.length} 个，合计 ${(perDoc.reduce((a, d) => a + d.bytes, 0) / 1024).toFixed(1)} KB`);
console.log('');
for (const d of perDoc.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`    ${d.rel.padEnd(48)} ${String(Math.round(d.bytes / 1024)).padStart(4)} KB  ${String(d.lines).padStart(5)} 行`);
}
console.log('');

const section = (title, list, fmt, hint) => {
  console.log(`--- ${title}：${list.length} 处 ---`);
  if (!list.length) {
    console.log('    ✅ 无问题');
  } else {
    for (const it of list.slice(0, 25)) console.log(`    · ${fmt(it)}`);
    if (list.length > 25) console.log(`    … 另有 ${list.length - 25} 处`);
    if (hint) console.log(`    → ${hint}`);
  }
  console.log('');
};

section('失效的仓库内路径引用', problems.brokenPaths,
  (x) => `${x.doc}  引用了不存在的 \`${x.ref}\``,
  '按文档操作会报"找不到文件"，应改成真实路径或删掉该引用');
section('失效的文档间链接', problems.brokenLinks,
  (x) => `${x.doc}  →  ${x.ref}`);
section('失效的 npm 脚本引用', problems.badNpm,
  (x) => `${x.doc}  写了 \`npm run ${x.script}\`，但 package.json 里没有`,
  '收件人会照抄命令并失败');
section('孤儿文档（没被任何文档引用）', problems.orphanDocs,
  (x) => x,
  '要么从 README 链上，要么明确它只是内部笔记（.gitignore 注释里提过这个取舍）');
section('个人信息（脱敏准备）', problems.secrets,
  (x) => `${x.doc}  含「${x.label}」（${x.count} 次）`,
  '打包时用 --redact 替换占位符，或加进 .packageignore');
section('陈旧标记', problems.staleMarks,
  (x) => `${x.doc}: ${x.line}`);

// 低置信提示单独列：这些"找不到"很可能是外部程序的文件或协议名，不是文档的错。
// 列出来是为了"不漏掉可能的问题"，但不计入待处理数。
if (problems.unconfirmedPaths.length) {
  const uniq = [...new Set(problems.unconfirmedPaths.map((x) => x.ref))];
  console.log(`--- 提示：以下引用在仓库里找不到（多半是外部程序的文件或协议名，未计入问题）---`);
  for (const r of uniq.slice(0, 20)) {
    const docsWith = [...new Set(problems.unconfirmedPaths.filter((x) => x.ref === r).map((x) => x.doc))];
    console.log(`    · \`${r}\`  ← ${docsWith.join(', ')}`);
  }
  if (uniq.length > 20) console.log(`    … 另有 ${uniq.length - 20} 个`);
  console.log('');
}

// 待处理数只统计真问题（不含低置信提示）
const REAL_BUCKETS = ['brokenPaths', 'brokenLinks', 'badNpm', 'orphanDocs', 'secrets', 'staleMarks'];
const total = REAL_BUCKETS.reduce((a, k) => a + problems[k].length, 0);
console.log(total === 0 ? '=== 文档审计通过：未发现问题 ===' : `=== 共 ${total} 处待处理 ===`);
