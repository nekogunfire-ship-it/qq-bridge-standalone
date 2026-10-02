// direct 模式的**操作规程提示词** —— 运行时从 DSH 的 agent preset 里读出来。
//
// 为什么需要它：`roles/<角色>.md` 只是**角色卡**（说话方式、梗、表情包习惯），
// 而"怎么在这个系统里干活"是写在 preset 里的（**173 行**），包括最关键的几条：
//   · 你的文本输出只是思考过程，【不会自动发送到 QQ】—— 要发言必须调用发送工具
//   · 回合结束要收尾：调用 qq_set_wake_config 或 qq_mark_read
//   · 回复后不要立刻结束：先 qq_wait_for_messages
//   · 空格不是分句符号、分条发送规则、看图/引用/合并转发的用法…
// 缺了这些，reserved2 下的模型会"打完字以为发出去了"、回合结束不设唤醒条件
// （护栏立刻开始报警/重置）、用空格分句被群友看到一堆碎句。
//
// ⚠️ **刻意不复制那份文本**：复制会与 DSH 侧慢慢分叉（改了 preset 忘了改这边）。
//    这里直接读 preset 的 YAML、取出 `persona.config.prefix`、做两处转换。
//    代价是"依赖 preset 的结构"——所以下面有结构校验，结构变了会明确报错而不是静默给空提示词。
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * 操作规程的读取源：**`prompts/*.md`**（纯 Markdown，与 DSH 无关）。
 *
 * 为什么不再直接读 dsh/agent-presets 下的 agent.cordis.yml：
 *   那份 YAML 是 **DSH 侧的产物**，只有 DSH 会去读它。direct 去读它，就等于
 *   "删掉 `dsh/` 目录 direct 就起不来" —— **"与 DSH 完全脱钩"这句话在 direct 下并不成立**。
 *   而两边的内容又必须**一模一样**（同一段操作规程）。
 *   ⇒ 采用「源 + 镜像 + 防漂移护栏」：direct 读 `prompts/`，DSH 读 preset，
 *     两边由 `tools/sync-preset-prompt.mjs --check` 断言逐字节一致。
 */
export const DEFAULT_PROMPT = 'prompts/qq-chat-v2.md';

/**
 * **按模式选规程** —— 必须如此，两份文本的含义**相反**：
 *   · `qq-chat`（2079 字符）：里面**没有**"文本不会自动发送"那句 —— 因为 chat 模式下
 *     桥接会自动转发 AI 的文本，说了反而错；
 *   · `qq-chat-v2`（14196 字符）：二代仿真用，明确写着"要发言必须调用发送工具"。
 * 用错一份会让模型对"自己说的话会不会被发出去"产生完全相反的理解。
 */
export const PROMPT_BY_MODE = {
  chat: 'prompts/qq-chat.md',
  reserved2: 'prompts/qq-chat-v2.md',
  // closed-agent 是 DSH 专有模式（direct 下已明确提示不支持），兜底给 chat 那份
  'closed-agent': 'prompts/qq-chat.md'
};

/** 按当前模式载入对应的操作规程提示词 */
export function loadQqProtocolForMode({ root, model = 'AI', mode = 'chat' } = {}) {
  const presetRel = PROMPT_BY_MODE[mode] ?? DEFAULT_PROMPT;
  const r = loadQqProtocol({ root, model, presetRel });
  return { ...r, mode, presetRel };
}

/**
 * 把 preset 里的 prefix 转成 direct 模式可用的系统提示词。
 *
 * 两处转换：
 *  ① **去掉 MCP 工具名前缀**：preset 里写的是 `mcp__snowluma__qq_send_message`
 *     （DSH 的命名方式），而 direct 模式下工具名就是 `qq_send_message`。
 *     不去掉的话模型会去调一个不存在的工具名。
 *  ② **换掉开头那句**：原文是 "You are a coding agent powered by the {{model}} model." ——
 *     那是给 DSH 的通用 agent 用的；在 QQ 机器人场景里说自己是 coding agent 会误导。
 *
 * @param {object} o
 * @param {string} o.root        仓库根
 * @param {string} [o.model]     用于替换 {{model}}
 * @param {string} [o.presetRel] preset 路径（相对 root）
 * @returns {{ ok: boolean, text: string, error?: string, stats?: object }}
 */
export function loadQqProtocol({ root, model = 'AI', presetRel = DEFAULT_PROMPT } = {}) {
  const file = path.join(root, presetRel);
  let prefix;
  try {
    prefix = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, text: '', error: `读不到操作规程文件：${file}（${e?.message ?? e}）` };
  }
  // 去掉末尾换行（抽取时补过一个），再校验非空。
  prefix = prefix.replace(/\s+$/, '');
  if (!prefix.trim()) {
    // **不要静默返回空提示词** —— 那会让机器人"看起来在跑、实际没规程"。
    return { ok: false, text: '', error: `操作规程文件是空的：${file}` };
  }
  // 防"改错了地方"：这份纯文本不该再出现 YAML 的块标量记号。
  if (/^\s*prefix:\s*>-/m.test(prefix) || /^\s*-\s*id:\s*persona\s*$/m.test(prefix)) {
    return { ok: false, text: '', error: `${file} 看起来是 preset YAML 而不是纯规程文本（结构不符）` };
  }

  const mcpRefs = (prefix.match(/mcp__[a-z-]+__/g) ?? []).length;
  let text = prefix
    // ① 去掉 mcp__<server>__ 前缀，让工具名与 direct 模式注册的名字一致
    .replace(/mcp__[a-z-]+__/g, '')
    // ② 开头那句是 DSH 通用 agent 的自我介绍，QQ 机器人场景下换掉
    .replace(/^You are a coding agent powered by the \{\{model\}\} model\.\s*/m, '')
    .replace(/\{\{model\}\}/g, String(model));

  text = text.trim();

  return {
    ok: true,
    text,
    stats: { chars: text.length, mcpRefsStripped: mcpRefs, source: presetRel }
  };
}
