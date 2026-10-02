// 操作规程提示词的**唯一读取源**搬到 `prompts/` —— 让 direct 运行时不再依赖 `dsh/` 目录。
//
// 为什么要有这个工具：
//   direct 模式需要那段"操作规程"（173 行）才能正确工作。它原本**只存在于**
//   `dsh/agent-presets/*/agent.cordis.yml` 的 `persona.config.prefix` 里 ——
//   于是"与 DSH 完全脱钩"这句话在 direct 下并不成立：**删掉 `dsh/` 目录，direct 就起不来**。
//
//   但那份 YAML 又不能不要：DSH 自己读它，而 DSH 路径用户仍在用（网页端）。
//   ⇒ 采用「**源 + 镜像 + 防漂移护栏**」：
//     · `prompts/*.md` 是 **direct 的读取源**（纯 Markdown，与 DSH 无关）
//     · preset 的 YAML 保持原样（DSH 侧的产物，不去改写它 —— 改写有牵连 DSH 的风险）
//     · 本工具 `--check` 断言两边**逐字节一致**；不一致就报错，不给"悄悄分叉"的机会
//
// 用法：
//   node tools/sync-preset-prompt.mjs --check      只比对（默认），不一致非 0 退出
//   node tools/sync-preset-prompt.mjs --extract    从 preset 里抽出文本 → 覆盖 prompts/*.md
//   node tools/sync-preset-prompt.mjs --print      打印两边的长度与首行（排查用，不写文件）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 两个 preset ↔ 两个 prompts 文件的对应关系（与 qq-prompt.mjs 的 PRESET_BY_MODE 对齐） */
export const PROMPT_SOURCES = {
  chat: { preset: 'dsh/agent-presets/qq-chat/agent.cordis.yml', md: 'prompts/qq-chat.md' },
  reserved2: { preset: 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml', md: 'prompts/qq-chat-v2.md' }
};

/** 从 preset YAML 里取出 `persona.config.prefix`（结构不符时明确报错，不静默给空串） */
export function readPrefixFromPreset(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`找不到 preset：${rel}`);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  // ⚠️ preset 的顶层是**数组**（每个元素是一个 cordis 插件项，`- id: persona`），
  //    不是对象 —— 想当然写成 `doc.persona.config.prefix` 会一路 undefined。
  if (!Array.isArray(doc)) throw new Error(`preset 结构不符：${rel} 的顶层不是数组`);
  const persona = doc.find((x) => x && x.id === 'persona');
  const prefix = persona?.config?.prefix;
  if (typeof prefix !== 'string' || !prefix.trim()) {
    throw new Error(`preset 结构不符：${rel} 里读不到 persona.config.prefix`);
  }
  return prefix;
}

export function readPromptMd(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`找不到操作规程文件：${rel}`);
  return fs.readFileSync(file, 'utf8');
}

/** 归一化：只比"内容"，忽略行尾差异与首尾空白 —— 但**不忽略中间任何一个字符** */
export const normalize = (s) => String(s).replace(/\r\n/g, '\n').trim();

export function compareAll() {
  const rows = [];
  for (const [mode, { preset, md }] of Object.entries(PROMPT_SOURCES)) {
    const fromPreset = normalize(readPrefixFromPreset(preset));
    let fromMd = null;
    let error = null;
    try { fromMd = normalize(readPromptMd(md)); } catch (e) { error = e.message; }
    rows.push({
      mode, preset, md, fromPreset, fromMd, error,
      same: fromMd != null && fromPreset === fromMd
    });
  }
  return rows;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const rows = compareAll();
  const bad = rows.filter((r) => !r.same);

  if (args.includes('--extract')) {
    for (const r of rows) {
      const out = path.join(ROOT, r.md);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, r.fromPreset + '\n', 'utf8');
      console.log(`  已写出 ${r.md}  （${r.fromPreset.length} 字符，来源 ${r.preset}）`);
    }
    console.log('  完成。改完请再跑一次 --check 确认一致。');
  } else if (args.includes('--print')) {
    for (const r of rows) {
      console.log(`  [${r.mode}] preset ${r.fromPreset.length} 字符 / md ${r.fromMd == null ? `(缺失: ${r.error})` : r.fromMd.length + ' 字符'}`);
      console.log(`      preset 首行: ${r.fromPreset.split('\n')[0].slice(0, 60)}`);
      if (r.fromMd) console.log(`      md     首行: ${r.fromMd.split('\n')[0].slice(0, 60)}`);
    }
  } else {
    for (const r of rows) {
      console.log(`  ${r.same ? 'OK  ' : 'FAIL'} [${r.mode}] ${r.md} ${r.same ? '与 preset 一致' : '与 preset 不一致'}` +
        (r.error ? ` —— ${r.error}` : ''));
    }
    if (bad.length) {
      console.error(`\n  ${bad.length} 处漂移：prompts/*.md 与 preset 里的那段文本对不上了。`);
      console.error('  改了一边就要同步另一边：node tools/sync-preset-prompt.mjs --extract');
      console.error('  （刻意不做自动同步 —— 悄悄改掉 DSH 侧的产物风险更大。）');
      process.exit(1);
    }
    console.log('\n  操作规程与 preset 一致（direct 读 prompts/，DSH 读 preset，两边同一份内容）。');
  }
}
