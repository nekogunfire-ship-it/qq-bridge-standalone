// text-safety 回归测试（纯函数，不依赖 SnowLuma / DSH / QQ）。
// 用法：node scripts/test-text-safety.mjs
//
// 覆盖 2026-09-25 的真实事故：群消息里的 emoji 被 slice(0, 80) 从中间劈开，留下孤立代理项，
// 写进 DSH 会话后 DeepSeek 解析 JSON 直接 400，该会话之后每一轮都失败。
import { safeSlice, safeSliceTail, stripLoneSurrogates, stripLoneSurrogatesDeep, hasLoneSurrogate } from '../src/text-safety.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`);
};

// 判断 JSON 文本里是否存在“落单的 \uD800-\uDFFF 转义”——这正是 DeepSeek 报
// "Failed to parse the request body as JSON: ... unexpected end of hex escape" 的原因。
function jsonHasUnpairedSurrogateEscape(json) {
  const high = /\\u([dD][89abAB][0-9a-fA-F]{2})/g;
  let m;
  while ((m = high.exec(json)) !== null) {
    const after = json.slice(high.lastIndex, high.lastIndex + 6);
    if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(after)) return true;
  }
  const low = /\\u([dD][c-fC-F][0-9a-fA-F]{2})/g;
  while ((m = low.exec(json)) !== null) {
    const before = json.slice(Math.max(0, m.index - 6), m.index);
    if (!/\\u[dD][89abAB][0-9a-fA-F]{2}$/.test(before)) return true;
  }
  return false;
}

// ── 1. 复现事故字符串 ────────────────────────────────────────────────────────
// 2026-09-25 10:56 群里那条把 group:200000002 整会话打挂的消息（正文 37 个码元 + 一串「🐇 」）。
// 桥接生成唤醒 prompt 时用 slice(0, 80) 截断，恰好砍在第 15 只兔子的高代理项上。
const incidentHead = '中秋没事干？不如和我一起在群里养씨발，每日收入0元，就是为了操操操群主。 ';
const incident = incidentHead + '🐇 '.repeat(20);
assert('事故正文前缀长度 = 37', incidentHead.length === 37, `实际 ${incidentHead.length}`);

const oldCut = incident.slice(0, 80);
assert('旧写法 slice(0,80) 会劈开 emoji（产生孤立代理项）', hasLoneSurrogate(oldCut), JSON.stringify(oldCut.slice(-8)));
assert('旧写法序列化成 JSON 后确实带落单转义（服务端 400）', jsonHasUnpairedSurrogateEscape(JSON.stringify(oldCut)));

const newCut = safeSlice(incident, 80);
assert('safeSlice(…,80) 不再产生孤立代理项', !hasLoneSurrogate(newCut));
assert('safeSlice(…,80) 序列化后没有落单转义', !jsonHasUnpairedSurrogateEscape(JSON.stringify(newCut)));
assert('safeSlice(…,80) 老老实实取前 80 个码元之内', newCut.length <= 80, `实际 ${newCut.length}`);
assert('safeSlice 保留了正文', newCut.startsWith('中秋没事干？') && newCut.includes('每日收入0元'));

// ── 2. safeSlice 基本行为 ────────────────────────────────────────────────────
const rabbits = '🐇'.repeat(10); // 20 个码元
assert('safeSlice 切在代理对中间时回退一位', safeSlice(rabbits, 5) === '🐇🐇', JSON.stringify(safeSlice(rabbits, 5)));
assert('safeSlice 正好整除时不动', safeSlice(rabbits, 4) === '🐇🐇');
assert('safeSlice 短文本原样返回', safeSlice('abc', 10) === 'abc');
assert('safeSlice 处理非字符串', safeSlice(12345, 3) === '123' && safeSlice(null, 3) === '');
assert('safeSlice max<=0 返回空串', safeSlice('abc', 0) === '' && safeSlice('abc', -5) === '');
assert('safeSlice 会顺带清掉输入里已有的孤立代理项', safeSlice('a\uD83Db', 10) === 'ab');

// ── 3. safeSliceTail 基本行为 ───────────────────────────────────────────────
assert('safeSliceTail 起点是低代理项时后移一位', safeSliceTail('xxx' + rabbits, 5) === '🐇🐇', JSON.stringify(safeSliceTail('xxx' + rabbits, 5)));
assert('safeSliceTail 短文本原样返回', safeSliceTail('abc', 10) === 'abc');
assert('safeSliceTail 清掉尾部脏字符', safeSliceTail('abc\uDC07', 10) === 'abc');

// ── 4. 穷举性质测试：任何切点都不该留下孤立代理项 ─────────────────────────────
const mixed = '结算画面🐇🐇排名第一了🎉主播说“🐟🐟🐟”真的吗\ud83d' + 'OK'.repeat(20);
let badSlice = 0;
let badTail = 0;
for (let max = 1; max <= mixed.length + 5; max++) {
  if (hasLoneSurrogate(safeSlice(mixed, max))) badSlice += 1;
  if (hasLoneSurrogate(safeSliceTail(mixed, max))) badTail += 1;
  if (jsonHasUnpairedSurrogateEscape(JSON.stringify(safeSlice(mixed, max)))) badSlice += 1;
  if (jsonHasUnpairedSurrogateEscape(JSON.stringify(safeSliceTail(mixed, max)))) badTail += 1;
}
assert('穷举 safeSlice：0 次出现孤立代理项', badSlice === 0, `命中 ${badSlice}`);
assert('穷举 safeSliceTail：0 次出现孤立代理项', badTail === 0, `命中 ${badTail}`);

// 对照组：旧写法在同样穷举下会出问题（证明测试本身有效）
let oldBad = 0;
for (let max = 1; max <= incident.length; max++) {
  if (hasLoneSurrogate(incident.slice(0, max))) oldBad += 1;
}
assert('对照：旧写法在同一穷举下确实会劈开 emoji', oldBad > 0, `命中 ${oldBad} 个切点`);

// ── 5. stripLoneSurrogates / hasLoneSurrogate ───────────────────────────────
assert('hasLoneSurrogate 识别半个 emoji', hasLoneSurrogate('x\uD83Dy') === true);
assert('hasLoneSurrogate 不误判完整 emoji', hasLoneSurrogate('x🐇y') === false);
assert('hasLoneSurrogate 对非字符串返回 false', hasLoneSurrogate(null) === false && hasLoneSurrogate(42) === false);
assert('stripLoneSurrogates 删除高代理项', stripLoneSurrogates('a\uD83Db') === 'ab');
assert('stripLoneSurrogates 删除低代理项', stripLoneSurrogates('a\uDC07b') === 'ab');
assert('stripLoneSurrogates 保留完整 emoji', stripLoneSurrogates('a🐇b') === 'a🐇b');
assert('stripLoneSurrogates 非字符串原样返回', stripLoneSurrogates(null) === null && stripLoneSurrogates(7) === 7);

// ── 6. stripLoneSurrogatesDeep ─────────────────────────────────────────────
const dirty = {
  recentMessages: [{ text: 'a\uD83Db', plain: 'ok' }, { text: '🐇' }],
  unread: [{ nested: { tail: '\uDC07tail' } }],
  n: 3,
  flag: true,
  nil: null,
};
const cleaned = stripLoneSurrogatesDeep(dirty);
assert('深度清理：去掉孤立代理项', cleaned.recentMessages[0].text === 'ab');
assert('深度清理：保留完整 emoji', cleaned.recentMessages[1].text === '🐇');
assert('深度清理：处理嵌套对象', cleaned.unread[0].nested.tail === 'tail');
assert('深度清理：非字符串字段不动', cleaned.n === 3 && cleaned.flag === true && cleaned.nil === null);
assert('深度清理：不污染原对象', dirty.recentMessages[0].text === 'a\uD83Db');

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
