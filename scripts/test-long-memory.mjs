// 长期记忆自检 —— 全程用**临时库文件**，绝不碰真实的 state/long-memory.db。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLongMemory, tokenize, redactForMemory, renderMemoryBlock, KINDS } from '../src/agent-runtime/long-memory.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-lm-'));
const FILE = path.join(DIR, 'long-memory.db');
const lm = openLongMemory({ file: FILE });

// ── ① 写入与读回 ────────────────────────────────────────────────────────────
const a = lm.remember({ scope: 'group:111', kind: 'fact', content: '群主养了一只叫豆豆的橘猫', importance: 2 });
check('① 写入成功并返回 id', a.ok === true && a.id > 0, `id=${a.id} updated=${a.updated}`);
check('① 库里确实有一条', lm.stats().active === 1, JSON.stringify(lm.stats()));

// ── ② 同 scope 同内容 → 更新而不是堆重复 ────────────────────────────────────
const a2 = lm.remember({ scope: 'group:111', kind: 'fact', content: '群主养了一只叫豆豆的橘猫', importance: 3 });
check('② 重复写入是 update（不新增行）', a2.updated === true && a2.id === a.id, `id=${a2.id} stats=${JSON.stringify(lm.stats())}`);
check('② 重复写入确实更新了 importance',
  lm.list({ scope: 'group:111' })[0].importance === 3);

// ── ③ 中文二元组检索能命中 ──────────────────────────────────────────────────
const hit = lm.search({ query: '豆豆', scope: 'group:111' });
check('③ 中文关键词能检索到', hit.length >= 1 && hit[0].content.includes('豆豆'), hit.map((h) => h.content).join(' | '));
// ⚠️ 这条必须用一个**干净的 scope**：上面 ② 把 group:111 那条的 importance 提到了 3，
//    而"importance≥3 即使关键词不命中也有兜底"是**刻意设计**（全局偏好要总能被看到）。
//    在同一个 scope 里验"无关查询返回空"会与那条设计打架 —— 是测试选错了地方，不是实现错了。
lm.remember({ scope: 'group:333', kind: 'event', content: '今天是周三', importance: 1 });
const noHit = lm.search({ query: '完全不相关的火星话题', scope: 'group:333' });
check('③ 无关查询不返回低分记忆（importance<3 不兜底）', noHit.length === 0, `返回 ${noHit.length} 条`);

// ── ④ scope 隔离：别的会话记的事，这个会话不该看到 ──────────────────────────
lm.remember({ scope: 'group:222', kind: 'event', content: '隔壁群在讨论豆豆的猫粮牌子' });
const cross = lm.search({ query: '豆豆', scope: 'group:111' });
check('★ ④ 检索不到**别的会话**的记忆（跨群串记忆比不记更糟）',
  cross.every((n) => n.scope !== 'group:222'), cross.map((n) => n.scope).join(','));

// ── ⑤ global 的记忆对所有会话可见 ───────────────────────────────────────────
lm.remember({ scope: 'global', kind: 'preference', content: '用户不喜欢被叫"您"，直接说你就好', importance: 3 });
const fromGlobal = lm.search({ query: '称呼 说话', scope: 'group:111' });
check('★ ⑤ global 的记忆能被任意会话检索到', fromGlobal.some((n) => n.scope === 'global'),
  fromGlobal.map((n) => n.scope).join(',') || '(没返回)');
check('⑤ 高 importance 的记忆即使关键词不命中也有兜底',
  fromGlobal.length >= 1, `${fromGlobal.length} 条`);

// ── ⑥ 排序：关键词命中 > 正文命中；importance 越高越靠前 ─────────────────────
lm.remember({ scope: 'group:111', kind: 'fact', content: '豆豆是只猫', keywords: ['占位'] });
lm.remember({ scope: 'group:111', kind: 'fact', content: '无关内容', keywords: ['豆豆', '猫'], importance: 4 });
const ranked = lm.search({ query: '豆豆', scope: 'group:111', limit: 3 });
check('⑥ 关键词命中排在前面（而不是只看时间）',
  ranked.length >= 1 && String(ranked[0].keywords).includes('豆豆'),
  ranked.map((r) => `imp${r.importance}:${String(r.keywords).slice(0, 12)}`).join(' | '));

// ── ⑦ 脱敏：凭据不该进记忆 ──────────────────────────────────────────────────
check('⑦ sk- 开头的密钥被打码', !/sk-[A-Za-z0-9_-]{8,}/.test(redactForMemory('我的 key 是 sk-abcdefghijklmn 这样')));
check('⑦ token= 形式的凭据被打码', /<redacted>/.test(redactForMemory('authToken=abcdefgh12345')));
lm.remember({ scope: 'group:111', kind: 'fact', content: 'apiKey=sk-live-abcdefghijklmn' });
const saved = lm.list({ scope: 'group:111' }).map((n) => n.content).join('\n');
check('★ ⑦ 写进库的内容也不含明文密钥', !/sk-live-abcdefghijklmn/.test(saved));

// ── ⑧ 坏输入要明确拒绝，而不是静默写坏 ──────────────────────────────────────
check('⑧ 空 content 被拒', lm.remember({ scope: 'group:111', content: '   ' }).ok === false);
check('⑧ 非法 kind 被拒', lm.remember({ scope: 'group:111', content: 'x', kind: '瞎写的' }).ok === false);
check(`⑧ kind 白名单是受控的（${KINDS.join('/')}）`, KINDS.length >= 4);
check('⑧ forget 缺 id 被拒', lm.forget({}).ok === false);

// ── ⑨ forget 是**归档**不是物理删除 ─────────────────────────────────────────
const f = lm.forget({ id: a.id });
check('⑨ forget 成功', f.ok === true, JSON.stringify(f));
check('★ ⑨ forget 之后仍然找得到那一行（归档而非抹掉）',
  lm.list({ scope: 'group:111' }).every((n) => n.id !== a.id) &&
  lm.stats().total > lm.stats().active,
  `total=${lm.stats().total} active=${lm.stats().active}`);

// ── ⑩ 给模型看的那段文本 ────────────────────────────────────────────────────
check('⑩ 没有命中时返回空串（不塞一句废话给模型）', renderMemoryBlock([]) === '');
const block = renderMemoryBlock(lm.search({ query: '豆豆', scope: 'group:111' }));
check('⑩ 有命中时带标题与条目', block.includes('【你记得的事】') && block.includes('- ['), block.split('\n')[0]);
check('⑩ 超长时有字符上限（不把上下文撑爆）', renderMemoryBlock(new Array(50).fill({ kind: 'fact', content: 'x'.repeat(200) })).length <= 1300);

// ── ⑪ HTTP/MCP 会话隔离接线 ────────────────────────────────────────────────
// 数据库层的 scope 隔离还不够：agent 端点也必须把 token 绑定到 key，并拒绝模型
// 自己伪造另一个 scope。这里做静态接线回归，行为层由 direct 沙箱测试覆盖。
const bridgeSource = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const mcpSource = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
check('★ ⑪ agent 写长期记忆时 scope 只能是当前会话或 global',
  bridgeSource.includes("agentToken && scope !== key && scope !== 'global'"));
check('★ ⑪ agent 查长期记忆必须校验 key/token 且 scope 等于 key',
  bridgeSource.includes('!key || !agentTokenOk(key, agentToken)')
  && bridgeSource.includes('agentToken && scope !== key'));
check('★ ⑪ MCP 检索请求显式携带 token 所属 key',
  mcpSource.includes("new URLSearchParams({ q: String(query ?? ''), key, scope: key })"));

// ── ⑫ 落盘后重开还在（这才是"长期"）─────────────────────────────────────────
const before = lm.stats().active;
lm.close();
const lm2 = openLongMemory({ file: FILE });
check('★ ⑫ 关掉再打开，记忆还在', lm2.stats().active === before, `${lm2.stats().active} vs ${before}`);
lm2.close();

// 清理
fs.rmSync(DIR, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? '=== 长期记忆自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
