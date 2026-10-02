// 长期记忆 —— direct 模式用：**跨会话、可检索、自由文本**。
//
// 为什么要它：桥接**已有**的 `qq_memory_*` 是**按会话**的结构化状态
// （`state/social-v2.json` 里的 activeTopic / pendingThought / memberImpression），
// 只服务当前那个会话、不能跨会话检索、也不是自由文本。
// 而 meow-memory（DSH 的长期记忆插件）在 direct 下**根本不存在** ——
// 于是"直连 AI API"的机器人**跨会话不记事**。这是脱钩后唯一真正的功能缺口。
//
// 设计取舍：
//   · **自建 SQLite**（Node 22 自带 `node:sqlite`，无第三方依赖）——
//     不去写 meow-memory 的库：那是 DSH 插件的私有 schema（七层表 + dream/window 账本），
//     桥接往里写会与它的假设打架。**同一种能力、两个独立实现**，比"猜别人的 schema"安全。
//   · **中文检索靠二元组（bigram）**，不做分词 —— 中文没有词边界，bigram 是够用的近似
//     （meow-memory 也是这么做的）。ASCII 部分按词。
//   · **scope**：'global' 或会话 key（`group:xxx` / `private:xxx`）。
//     检索时**本会话的 + global 的**都算，别的会话不算（跨群串记忆比不记更糟）。
//   · 记忆是**给模型看的文本**，所以写入一律过一遍脱敏（别把 key/令牌记进去）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  keywords    TEXT    NOT NULL DEFAULT '',
  importance  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope, status);
`;

export const KINDS = ['fact', 'preference', 'event', 'impression', 'lesson'];

/** 中文按二元组、ASCII 按词 —— 中文没有词边界，bigram 是够用的近似 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  for (const seg of s.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 脱敏：记忆是给模型看的文本，别把凭据写进去（与桥接其它地方的脱敏口径一致） */
export function redactForMemory(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '<key>')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <token>')
    .replace(/(token|secret|password|apiKey|authToken)\s*[:=]\s*[A-Za-z0-9._-]{8,}/gi, '$1=<redacted>')
    .trim();
}

/**
 * 打开（或创建）长期记忆库。
 * @param {{file: string, log?: Function}} o
 */
export function openLongMemory({ file, log = () => {} } = {}) {
  if (!file) throw new Error('openLongMemory 需要 file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  log(`[long-memory] 已打开 ${file}`);

  const now = () => Date.now();

  /** 写一条（同 scope 下内容完全相同 → 视为更新，不堆重复） */
  function remember({ scope = 'global', kind = 'fact', content, keywords, importance = 1 } = {}) {
    const text = redactForMemory(content);
    if (!text) return { ok: false, error: 'content 不能为空' };
    const k = String(kind);
    if (!KINDS.includes(k)) return { ok: false, error: `kind 必须是 ${KINDS.join(' / ')}` };
    const kws = (Array.isArray(keywords) && keywords.length ? keywords : tokenize(text))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 24).join(' ');
    const imp = Math.max(1, Math.min(4, Number(importance) || 1));

    const dup = db.prepare(
      'SELECT id FROM notes WHERE scope = ? AND content = ? AND status = ? LIMIT 1'
    ).get(String(scope), text, 'active');
    if (dup) {
      db.prepare('UPDATE notes SET keywords = ?, importance = ?, updated_at = ? WHERE id = ?')
        .run(kws, imp, now(), dup.id);
      return { ok: true, id: dup.id, updated: true };
    }
    const info = db.prepare(
      'INSERT INTO notes (scope, kind, content, keywords, importance, created_at, updated_at, status) VALUES (?,?,?,?,?,?,?,?)'
    ).run(String(scope), k, text, kws, imp, now(), now(), 'active');
    return { ok: true, id: Number(info.lastInsertRowid), updated: false };
  }

  /**
   * 按相关度检索。scope 命中范围 = 传入的 scope **加上** 'global'（不跨别的会话）。
   * 打分：关键词命中 3 / 正文命中 1，乘以 importance 权重，再乘时间衰减。
   */
  function search({ query = '', scope = 'global', limit = 5, includeGlobal = true } = {}) {
    const toks = tokenize(query);
    const scopes = includeGlobal && scope !== 'global' ? [String(scope), 'global'] : [String(scope)];
    const placeholders = scopes.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM notes WHERE status = 'active' AND scope IN (${placeholders})`
    ).all(...scopes);
    const nowMs = now();
    const DAY = 86400000;
    const scored = [];
    for (const r of rows) {
      const kw = String(r.keywords ?? '').toLowerCase();
      const body = String(r.content ?? '').toLowerCase();
      let score = 0;
      for (const t of toks) {
        if (!t) continue;
        if (kw.split(/\s+/).includes(t)) score += 3;
        else if (kw.includes(t)) score += 2;
        if (body.includes(t)) score += 1;
      }
      if (score === 0) {
        // 没有关键词命中时，只让"很重要的"记忆兜底进来（比如全局偏好），
        // 否则就是把整库都塞给模型。
        if (Number(r.importance) >= 3) score = 0.5;
        else continue;
      }
      const ageDays = Math.max(0, (nowMs - Number(r.updated_at)) / DAY);
      const decay = 1 / (1 + ageDays / 30);          // 30 天衰减一半左右
      const weight = 1 + (Number(r.importance) - 1) * 0.35;
      scored.push({ ...r, score: score * decay * weight });
    }
    scored.sort((a, b) => b.score - a.score || Number(b.updated_at) - Number(a.updated_at));
    return scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 5)));
  }

  function list({ scope, limit = 50 } = {}) {
    const sql = scope
      ? "SELECT * FROM notes WHERE status = 'active' AND scope = ? ORDER BY updated_at DESC LIMIT ?"
      : "SELECT * FROM notes WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?";
    return scope ? db.prepare(sql).all(String(scope), Number(limit)) : db.prepare(sql).all(Number(limit));
  }

  /** 归档（不是物理删除 —— 记错的东西留痕比抹掉更安全） */
  function forget({ id } = {}) {
    const n = Number(id);
    if (!n) return { ok: false, error: 'forget 需要 id' };
    const info = db.prepare("UPDATE notes SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(now(), n);
    return { ok: info.changes > 0, changes: Number(info.changes) };
  }

  function stats() {
    const row = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM notes").get();
    return { total: Number(row.total ?? 0), active: Number(row.active ?? 0) };
  }

  return { remember, search, list, forget, stats, close: () => db.close(), file };
}

/** 把检索结果渲染成给模型看的一段文本（没有命中就返回空串，不要塞一句废话） */
export function renderMemoryBlock(notes, { maxChars = 1200 } = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const n of notes) {
    const line = `- [${n.kind}] ${String(n.content).trim()}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return ['【你记得的事】（长期记忆里与你这次要处理的事相关的部分）', ...lines].join('\n');
}
