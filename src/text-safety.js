// 文本安全：代理项（surrogate）与“按长度截断”的坑。
//
// 事故背景（2026-09-25，group:200000002 整个会话持续 400）：
// QQ 消息里的 emoji 在 UTF-16 里是两个码元（🐇 = \uD83D\uDC07）。桥接用
// String.slice(0, 80) / slice(0, 200) / slice(-200) 按码元截断时，可能正好切在代理对
// 中间，留下“孤立代理项”（如单独的 \uD83D）。这种文本一旦进入 DSH 会话历史：
//   1. DSH 把历史序列化成 JSON 发给 DeepSeek（/anthropic/v1/messages）；
//   2. JSON.stringify 会把孤立代理项写成 \ud83d 这种单飞转义，DeepSeek 的解析器直接 400，
//      且错误体是纯文本（"Failed to parse the request body as JSON: ... unexpected end of
//      hex escape"）——DSH 读不到 error.message，只能显示「DeepSeek Messages request failed (400)」；
//   3. 这条消息永久留在会话历史里 → 该会话之后每一轮请求都失败（群里表现为机器人彻底失声，
//      只会看到 ⚠️ agent 处理出错）。
// 所以：凡是会进 prompt / 存状态 / 交给 agent 的文本，一律用 safeSlice / safeSliceTail
// 截断，并在投递前用 stripLoneSurrogates 兜底。
//
// 用法约定：
//   safeSlice(str, n)      —— 取前 n 个码元，绝不劈开代理对
//   safeSliceTail(str, n)  —— 取后 n 个码元，同样不劈开（起点是低代理项时后移一位）
//   stripLoneSurrogates(s) —— 去掉已存在的孤立代理项（历史脏数据/外部输入兜底）
//   stripLoneSurrogatesDeep(v) —— 递归清理对象/数组里的字符串（状态文件加载用）

const LONE_SURROGATE_SOURCE = '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';
const LONE_SURROGATE_TEST = new RegExp(LONE_SURROGATE_SOURCE, 'u');
const LONE_SURROGATE_GLOBAL = new RegExp(LONE_SURROGATE_SOURCE, 'gu');

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

/** 文本里是否存在孤立代理项（半个 emoji）。非字符串一律返回 false。 */
export function hasLoneSurrogate(value) {
  return typeof value === 'string' && LONE_SURROGATE_TEST.test(value);
}

/**
 * 去掉孤立代理项（直接删除，不替换成替换字符）。
 * 非字符串原样返回，方便直接套在任意字段上。
 */
export function stripLoneSurrogates(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!LONE_SURROGATE_TEST.test(value)) return value;
  return value.replace(LONE_SURROGATE_GLOBAL, '');
}

/** 取前 max 个码元，绝不劈开代理对；顺带清掉本来就存在的孤立代理项。 */
export function safeSlice(value, max) {
  const str = typeof value === 'string' ? value : String(value ?? '');
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (str.length <= limit) return stripLoneSurrogates(str);
  let end = Math.trunc(limit);
  const code = str.charCodeAt(end - 1);
  // 结尾正好是高代理项：说明 emoji 被劈开了，退一位把它丢掉。
  if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) end -= 1;
  return stripLoneSurrogates(str.slice(0, end));
}

/** 取后 max 个码元，绝不劈开代理对（起点是低代理项时后移一位）。 */
export function safeSliceTail(value, max) {
  const str = typeof value === 'string' ? value : String(value ?? '');
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (str.length <= limit) return stripLoneSurrogates(str);
  let start = str.length - Math.trunc(limit);
  const code = str.charCodeAt(start);
  // 起点正好是低代理项：说明 emoji 被劈开了，往后挪一位。
  if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) start += 1;
  return stripLoneSurrogates(str.slice(start));
}

/** 递归清理对象/数组里的所有字符串（状态文件加载、外部 JSON 兜底用）。 */
export function stripLoneSurrogatesDeep(value) {
  if (typeof value === 'string') return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map((item) => stripLoneSurrogatesDeep(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = stripLoneSurrogatesDeep(item);
    return out;
  }
  return value;
}
