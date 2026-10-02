// direct 模式的**操作规程提示词**自检。
//
// 这件事的关键性：`roles/<角色>.md` 只是角色卡（说话方式/梗/表情包），而"怎么在这个系统里干活"
// 写在 DSH 的 agent preset 里（173 行），包括：
//   · 你的文本输出只是思考过程，**不会自动发送到 QQ** —— 要发言必须调用发送工具
//   · 回合结束要收尾：qq_set_wake_config 或 qq_mark_read
//   · 回复后不要立刻结束：先 qq_wait_for_messages
//   · 空格不是分句符号、分条发送规则…
// 缺了它，reserved2 下的模型会"打完字以为发出去了"、回合结束不设唤醒条件（护栏立刻报警/重置）。
//
// 这里守四件事：
//   ① 能真的从 preset 里读出来（结构依赖被显式检查，不是静默给空提示词）
//   ② MCP 工具名前缀被去掉（否则模型会去调 `mcp__snowluma__qq_send_message` 这种不存在的名字）
//   ③ **按模式选对 preset** —— chat 与 reserved2 那两段的含义**相反**，选错会让模型
//      对"自己说的话会不会被发出去"产生完全相反的理解
//   ④ 关键指令确实在文本里
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQqProtocol, loadQqProtocolForMode, PROMPT_BY_MODE } from '../src/agent-runtime/qq-prompt.mjs';
// 防漂移护栏：prompts/*.md 与 preset YAML 里那段文本必须逐字节一致
import { compareAll } from '../tools/sync-preset-prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── ① 能读出来 ──────────────────────────────────────────────────────────────
const v2 = loadQqProtocol({ root: ROOT, model: 'deepseek-chat' });
check('① 能从 preset 读出国情规程', v2.ok, v2.error ?? `${v2.stats.chars} 字符`);
check('① 文本量合理（>5000 字符，说明没读到空的）', (v2.stats?.chars ?? 0) > 5000, String(v2.stats?.chars));
check('① 报告了去掉多少 MCP 前缀', (v2.stats?.mcpRefsStripped ?? 0) > 0, String(v2.stats?.mcpRefsStripped));

// ── ② 工具名前缀被去掉 ──────────────────────────────────────────────────────
check('② 文本里不再有 mcp__ 前缀', !/mcp__/.test(v2.text),
  (v2.text.match(/mcp__[a-z-]+__\w+/g) ?? []).slice(0, 3).join(', ') || '干净');
check('② 工具名变成了裸名（qq_send_message 等）',
  /\bqq_send_message\b/.test(v2.text) && /\bqq_set_wake_config\b/.test(v2.text));

// ── ③ 按模式选对规程文件（这条最重要：两段内容含义相反）──────────────────────
const chatP = loadQqProtocolForMode({ root: ROOT, model: 'm', mode: 'chat' });
const v2P = loadQqProtocolForMode({ root: ROOT, model: 'm', mode: 'reserved2' });
check('③ chat 模式用 qq-chat', chatP.presetRel === PROMPT_BY_MODE.chat, chatP.presetRel);
check('③ reserved2 模式用 qq-chat-v2', v2P.presetRel === PROMPT_BY_MODE.reserved2, v2P.presetRel);
check('③ chat 那段的文本量与 reserved2 明显不同（证明选的是不同文件）',
  chatP.stats?.chars !== v2P.stats?.chars, `chat ${chatP.stats?.chars} vs reserved2 ${v2P.stats?.chars}`);
check('⚠️ chat 模式下**没有**"文本不会自动发送"那句（chat 下桥接会自动转发，说了就错）',
  !chatP.text.includes('不会自动发送'), '（正确：chat 段不含该句）');
check('⚠️ reserved2 模式下**有**"文本不会自动发送"那句',
  v2P.text.includes('不会自动发送'));

// ── ④ 关键指令在文本里 ──────────────────────────────────────────────────────
for (const k of ['不会自动发送到 QQ', 'qq_mark_read', 'qq_set_wake_config', '空格不是分句符号']) {
  check(`④ reserved2 规程含关键指令「${k}」`, v2.text.includes(k));
}

// ── ⑤ 结构变化时要**明确报错**，不能静默给空提示词 ──────────────────────────
// 用**真实会犯的那个错**来验：把读取路径指回 preset YAML（而不是 prompts/*.md）。
// （原先拿 package.json 当反例是不对的 —— 它既不是空的、也不像 preset YAML，
//   本来就不该被那道护栏拦下；护栏要防的是"指向了 preset"。）
const bad = loadQqProtocol({ root: ROOT, presetRel: 'dsh/agent-presets/qq-chat/agent.cordis.yml' });
check('⑤ 指向 preset YAML 时明确报错（而不是把 YAML 当规程喂给模型）',
  bad.ok === false && /结构不符/.test(bad.error ?? ''), bad.error ?? '(没有报错？)');
const missing = loadQqProtocol({ root: ROOT, presetRel: 'no/such/file.md' });
check('⑤ 规程文件不存在时明确报错', missing.ok === false && /读不到/.test(missing.error ?? ''));

// ── ⑥ 没有硬编码副本 + 与 preset 不漂移 ─────────────────────────────────────
// 这两条防的是"有人图省事把那段文本复制进来" —— 那样两边就会慢慢分叉。
// ⚠️ 必须先**剥掉注释**再查：我第一版直接 includes() 就报了 FAIL，
//    因为模块顶部的**注释**里引用了一句规程原文（"不会自动发送到 QQ"）——
//    那是解释，不是硬编码。检查工具自己造成的误报。（同族教训：检查工具要先治误报）
const srcRaw = fs.readFileSync(path.join(ROOT, 'src/agent-runtime/qq-prompt.mjs'), 'utf8');
const src = srcRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
  .replace(/^\s*\/\/.*$/gm, '');         // 行注释
check('⑥ 模块**代码**里没有硬编码那段规程文本（必须是运行时从文件读）',
  !src.includes('不会自动发送到 QQ') && !src.includes('空格不是分句符号'),
  '（是运行时读取，无副本）');
// ★ direct 读 prompts/、DSH 读 preset YAML —— 两份必须一致，否则就是"悄悄分叉"
for (const r of compareAll()) {
  check(`★ ⑥ ${r.md} 与 preset 里那段文本逐字节一致（防漂移）`, r.same,
    r.error ?? (r.same ? `同为 ${r.fromPreset.length} 字符` : `md ${r.fromMd?.length} vs preset ${r.fromPreset.length}`));
}
check('★ ⑥ 规程读取源不再指向 dsh/ 目录（direct 与 DSH 解耦的判据）',
  !Object.values(PROMPT_BY_MODE).some((p) => p.startsWith('dsh/')),
  Object.values(PROMPT_BY_MODE).join(', '));

console.log('');
console.log(failures === 0 ? '=== 操作规程提示词自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
