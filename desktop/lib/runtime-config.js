// 「AI 运行时」这一段的读写核心（主进程用）。
//
// 职责：让桌面界面能查看/切换 dsh 与 direct 两种运行时，而不破坏用户的 config.json。
//
// 为什么单独成模块、并且写得这么谨慎：
//   `config.json` 是**用户的活配置**（含 QQ 号、DSH 令牌、API key），**不在版本控制里**，
//   而且我在这个项目上已经误删过它一次（删了真没了）。所以这里的每一次写入都要求：
//     ① 先备份到 archive/（沿用仓库既有命名 `config.json.before-*`，已被 .gitignore 覆盖）
//     ② **外科式改写** —— 只替换 `runtime` 那一段文本，**不 parse→reserialize**
//        （后者会重排键序、改数字格式、动到用户没让我碰的地方；这条我在改 config 时踩过）
//     ③ 写完立刻校验：JSON 合法 + **其它顶层键一个不少且值完全相同**
//     ④ 任一步不过 → 从备份回滚，并如实报错
//
// 安全：`apiKey` **不回传给渲染层**。读的时候只给 `apiKeySet: true/false`，
//       写的时候"留空 = 不修改"。这样密钥永远不进入渲染进程，也不会被顺手打进日志。
import fs from 'node:fs';
import path from 'node:path';

/** config.json 里 runtime 段的默认值（与 src/bridge.js 的 loadConfig 保持一致） */
export const RUNTIME_DEFAULTS = {
  type: 'dsh',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',
  maxTurns: 20,
  timeoutMs: 120_000
};

/** 合法的运行时类型 */
export const RUNTIME_TYPES = ['dsh', 'direct'];

function configPath(root) { return path.join(root, 'config.json'); }

/** 读文件并剥掉可能的 BOM（桥接的 readJsonSafe 也这么做，这里保持一致） */
function readText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const hadBom = raw.charCodeAt(0) === 0xFEFF;
  return { text: hadBom ? raw.slice(1) : raw, hadBom, raw };
}

/**
 * 读当前运行时配置。**不返回 apiKey 明文**，只返回有没有填。
 * @returns {{ ok: boolean, runtime?: object, apiKeySet?: boolean, configPath: string, error?: string }}
 */
export function readRuntimeConfig(root) {
  const file = configPath(root);
  let parsed;
  let text = '';
  try {
    const r = readText(file);
    text = r.text;
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, configPath: file, error: `读不了 config.json：${e?.message ?? e}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, configPath: file, error: 'config.json 顶层不是一个对象' };
  }
  const rt = (parsed.runtime && typeof parsed.runtime === 'object') ? parsed.runtime : {};
  const { apiKey, ...rest } = rt;
  return {
    ok: true,
    configPath: file,
    configExists: true,
    // 把默认值补上，让界面永远有值可显示；但**不**用默认值覆盖用户已写的值
    runtime: {
      ...RUNTIME_DEFAULTS,
      ...rest,
      type: RUNTIME_TYPES.includes(rest.type) ? rest.type : 'dsh'
    },
    apiKeySet: typeof apiKey === 'string' && apiKey.length > 0,
    // DSH 侧的关键信息（界面要显示"DSH 端点/有没有令牌"，但不回传令牌本身）
    dsh: {
      baseUrl: parsed.dsh?.baseUrl ?? '',
      hasToken: Boolean(parsed.dsh?.authToken)
    }
  };
}

/** 仅供可信主进程执行请求时读取；不要把返回值传给渲染层或日志。 */
export function readRuntimeApiKey(root) {
  const file = configPath(root);
  try {
    const parsed = JSON.parse(readText(file).text);
    const apiKey = parsed?.runtime?.apiKey;
    return typeof apiKey === 'string'
      ? { ok: true, apiKey }
      : { ok: false, apiKey: '', error: 'config.json 里的 apiKey 格式不正确' };
  } catch (e) {
    return { ok: false, apiKey: '', error: `读 config.json 失败：${e?.message ?? e}` };
  }
}

/** runtime 段里"已知字段"的展示顺序（未知字段会排在后面，但**一个都不会丢**） */
const RUNTIME_FIELD_ORDER = [
  'type', 'baseUrl', 'apiKey', 'model',
  // 行为开关：这两个对应"用户亲身遇到过的两件事"（看图看不见 / 对话风格变了）
  'images', 'temperature',
  // 调参与保险
  'maxTurns', 'turnTimeoutMs', 'timeoutMs', 'tools', 'stream', 'maxToolRounds'
];

/**
 * 生成 runtime 段的文本（与文件其余部分同样的缩进/行尾）。
 *
 * ⚠️ 两处曾经写错、代价很大的地方（2026-09-26 被"用户新增了 runtime.images"这件事暴露）：
 *
 * 1. **必须保留未知字段**。第一版只写死 type/baseUrl/apiKey/model(+3 个可选项)，
 *    于是用户自己加的任何配置项（`images`、`tools`、`temperature`…）**一保存就被静默丢掉** ——
 *    这类"界面吃掉用户的配置"是最难排查的：用户不会想到是点了一下保存导致的。
 *    做法：已知字段按顺序排前面，**其余字段原样 JSON 化追加**。
 *
 * 2. **逗号不能手写**。第一版把已知字段写成一个数组、可选项再 `push` 上去，
 *    而数组最后一项（`model`）**没有尾逗号** → 一旦有可选项就拼出
 *    `"model": "m"` 紧接 `"maxTurns": 20,` → **非法 JSON**。
 *    做法：每项都**不带**逗号，统一由 `join(',')` 补 —— 逗号归属交给结构，不靠人记。
 */
function renderRuntimeBlock(runtime, { indent, eol, trailingComma }) {
  const i = indent;
  const j = indent + indent.slice(0, 2);        // 子键比父键多一级
  const keys = [
    ...RUNTIME_FIELD_ORDER.filter((k) => runtime[k] !== undefined),
    ...Object.keys(runtime).filter((k) => !RUNTIME_FIELD_ORDER.includes(k))
  ];
  const body = keys
    .map((k) => `${j}${JSON.stringify(k)}: ${JSON.stringify(runtime[k])}`)
    .join(`,${eol}`);
  return `${i}"runtime": {${eol}${body}${eol}${i}}${trailingComma ? ',' : ''}`;
}

/**
 * 在文本里定位 `"runtime": { ... }` 那一整段的字符区间（含结尾逗号）。
 * 用**大括号配对**扫描而不是正则 —— 值里可能有 `}`（比如 URL 带花括号），正则会切错。
 */
function locateRuntimeBlock(text) {
  const key = /"runtime"\s*:\s*\{/.exec(text);
  if (!key) return null;
  const start = key.index;
  let depth = 0;
  let i = key.index + key[0].length - 1;   // 指向那个 '{'
  let inStr = false;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;            // 括号不配对 → 不猜，直接放弃（由调用方回退）
  let end = i + 1;                          // '}' 之后
  // 吃掉紧随其后的逗号（如果有）
  const after = text.slice(end);
  const commaMatch = /^\s*,/.exec(after);
  if (commaMatch) end += commaMatch[0].length;
  return { start, end };
}

/**
 * 保存 runtime 段。**只动这一段**，其余字节不变。
 *
 * @param {string} root
 * @param {object} patch  { type, baseUrl, model, apiKey?, maxTurns?, ... }
 *        `apiKey` **缺省或空串 = 不修改**（界面留空表示"沿用已保存的"）。
 * @param {object} [opts] { skipBackup?: boolean }
 * @returns {{ ok: boolean, backup?: string, changed?: string[], error?: string }}
 */
export function writeRuntimeConfig(root, patch = {}, opts = {}) {
  const file = configPath(root);
  let original;
  let text;
  let hadBom;
  let parsed;
  try {
    const r = readText(file);
    original = r.raw; text = r.text; hadBom = r.hadBom;
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `读不了 config.json：${e?.message ?? e}` };
  }

  const type = String(patch.type ?? '').trim();
  if (!RUNTIME_TYPES.includes(type)) {
    return { ok: false, error: `runtime.type 必须是 ${RUNTIME_TYPES.join(' 或 ')}，收到 ${JSON.stringify(patch.type)}` };
  }
  const baseUrl = String(patch.baseUrl ?? '').trim();
  const model = String(patch.model ?? '').trim();
  // direct 才需要 baseUrl / model（dsh 模式下它们只是留着备用，允许为空）
  if (type === 'direct') {
    if (!baseUrl) return { ok: false, error: '直连模式必须填 baseUrl' };
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头' };
    if (!model) return { ok: false, error: '直连模式必须填 model' };
  }

  const prev = (parsed.runtime && typeof parsed.runtime === 'object') ? parsed.runtime : {};
  // apiKey：留空 = 沿用已保存的（界面不回传明文，所以留空是常态）
  const apiKey = (typeof patch.apiKey === 'string' && patch.apiKey.length > 0)
    ? patch.apiKey
    : (typeof prev.apiKey === 'string' ? prev.apiKey : '');

  const next = {
    ...prev,
    type,
    baseUrl: baseUrl || prev.baseUrl || RUNTIME_DEFAULTS.baseUrl,
    apiKey,
    model: model || prev.model || RUNTIME_DEFAULTS.model
  };
  if (patch.maxTurns !== undefined) next.maxTurns = Number(patch.maxTurns);
  if (patch.turnTimeoutMs !== undefined) next.turnTimeoutMs = Number(patch.turnTimeoutMs);
  if (patch.timeoutMs !== undefined) next.timeoutMs = Number(patch.timeoutMs);

  // ── 两个"行为开关"（界面上的高级项）────────────────────────────────────────
  // `images`：桥接侧判据是 `rc.images !== false`，也就是**默认开**。
  //   界面上是个复选框，勾了/没勾是明确状态，所以**总是写出来**（`true` 也写）——
  //   自解释，比"靠默认值"清楚。
  if (patch.images !== undefined) next.images = patch.images === true;

  // `temperature`：留空 = 不写这一项（回到"用模型默认"），而不是写 0 ——
  //   0 是个有意义的取值（最保守），不能拿它当"没填"。
  if (patch.temperature !== undefined) {
    const raw = patch.temperature;
    if (raw === null || raw === '' || raw === undefined) {
      delete next.temperature;
    } else {
      const t = Number(raw);
      if (!Number.isFinite(t)) return { ok: false, error: `temperature 不是数字：${JSON.stringify(raw)}` };
      if (t < 0 || t > 2) return { ok: false, error: `temperature 应在 0 ~ 2 之间，收到 ${t}` };
      next.temperature = t;
    }
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = /\n([ \t]+)"/.exec(text);
  const indent = indentMatch ? indentMatch[1] : '  ';

  const block = locateRuntimeBlock(text);
  let output;
  if (block) {
    // 已存在：原样替换（保留它原来的位置与结尾逗号习惯）
    const hadComma = /,\s*$/.test(text.slice(block.start, block.end));
    output = text.slice(0, block.start)
      + renderRuntimeBlock(next, { indent, eol, trailingComma: hadComma })
      + text.slice(block.end);
  } else {
    // 不存在：插到第一个 `{` 之后，**带尾逗号**（因为它后面还有别的键）
    const open = text.indexOf('{');
    if (open < 0) return { ok: false, error: 'config.json 里找不到起始的 {，为安全起见不做写入' };
    const afterOpen = text.slice(open + 1);
    const tailEol = afterOpen.startsWith('\r\n') ? '\r\n' : (afterOpen.startsWith('\n') ? '\n' : '');
    if (!tailEol) return { ok: false, error: '{ 后面不是换行，格式与预期不符，为安全起见不做写入' };
    output = text.slice(0, open + 1) + eol
      + renderRuntimeBlock(next, { indent, eol, trailingComma: true }) + eol
      + afterOpen.slice(tailEol.length);
  }
  output = output.replace(/\r?\n?$/, (m) => (original.endsWith('\n') ? (original.endsWith('\r\n') ? '\r\n' : '\n') : m));

  // ── 写完先自检，再落盘 ────────────────────────────────────────────────────
  let after;
  try { after = JSON.parse(output); } catch (e) {
    return { ok: false, error: `改写后不是合法 JSON（已放弃写入）：${e?.message ?? e}` };
  }
  const beforeKeys = Object.keys(parsed);
  const problems = [];
  for (const k of beforeKeys) {
    if (k === 'runtime') continue;                 // 这一段就是我们要改的
    if (!(k in after)) { problems.push(`顶层键丢失：${k}`); continue; }
    if (JSON.stringify(parsed[k]) !== JSON.stringify(after[k])) problems.push(`键 ${k} 的值被意外改动`);
  }
  // 允许**新增** `runtime` 这一个键（配置里本来没有它时就是这种情况）；
  // 除它之外多出任何顶层键都算异常。我第一版漏了这个例外，于是"给没有 runtime 的配置加一段"
  // 这条正常路径被自己的自检拦下了（测试当场抓到）。
  const added = Object.keys(after).filter((k) => !beforeKeys.includes(k) && k !== 'runtime');
  if (added.length) problems.push(`出现了意外的新顶层键：${added.join(', ')}`);
  if (after.runtime?.type !== type) problems.push('runtime.type 没写对');
  if (problems.length) return { ok: false, error: `自检未通过（已放弃写入）：${problems.join('；')}` };

  // ── 落盘（先备份）────────────────────────────────────────────────────────
  let backup = null;
  if (!opts.skipBackup) {
    try {
      const archive = path.join(root, 'archive');
      fs.mkdirSync(archive, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      backup = path.join(archive, `config.json.before-runtime-${stamp}`);
      fs.writeFileSync(backup, original, 'utf8');
    } catch (e) {
      return { ok: false, error: `备份失败，为安全起见不写入：${e?.message ?? e}` };
    }
  }

  try {
    // 原子写：先写临时文件再改名，避免写一半被打断留下半个配置
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, (hadBom ? '\uFEFF' : '') + output, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    // 写失败就回滚（其实还没成功写进去，但从备份还原一次更稳）
    if (backup) { try { fs.writeFileSync(file, original, 'utf8'); } catch { /* 忽略 */ } }
    return { ok: false, error: `写入失败${backup ? '（已从备份还原）' : ''}：${e?.message ?? e}` };
  }

  // ── 写后再验一次（真的读回来）────────────────────────────────────────────
  try {
    const check = readText(file);
    const back = JSON.parse(check.text);
    if (back.runtime?.type !== type) throw new Error('读回来的 runtime.type 与写入的不一致');
  } catch (e) {
    if (backup) { try { fs.writeFileSync(file, original, 'utf8'); } catch { /* 忽略 */ } }
    return { ok: false, error: `写后校验失败${backup ? '（已从备份还原）' : ''}：${e?.message ?? e}` };
  }

  return { ok: true, backup, changed: ['runtime.type', 'runtime.baseUrl', 'runtime.model'] };
}
