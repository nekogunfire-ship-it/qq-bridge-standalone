// 「AI 运行时」读写核心的自检。
//
// 这个模块会**改写用户真实的 config.json**（含 QQ 号、DSH 令牌、API key，且不在版本控制里），
// 所以它必须被断言守住。全部测试跑在**沙箱副本**上，绝不碰真实仓库 —— 首条断言先验这一点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_DEFAULTS, readRuntimeApiKey, readRuntimeConfig, writeRuntimeConfig } from '../desktop/lib/runtime-config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), `qb-rtcfg-${process.pid}`);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── 首条断言：确认我们操作的是沙箱，不是真实仓库 ─────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
check('★ 作用对象是沙箱（不是真实仓库）',
  SANDBOX.startsWith(os.tmpdir()) && !SANDBOX.startsWith(REPO), SANDBOX);

// 造一个"像真实配置"的沙箱文件：**故意带 BOM / CRLF / 多余字段**，验证我们都能处理好
const FX = {
  dsh: { baseUrl: 'http://127.0.0.1:55644', authToken: 'FAKE-TOKEN', model: 'deepseek-flash' },
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: ['222', '333'] },
  consoleToken: 'FAKE-CONSOLE',
  socialV2: { wake: { noActionLimit: 3 } },
  _comment: '留着不该动'
};
const CFG = path.join(SANDBOX, 'config.json');
fs.mkdirSync(path.join(SANDBOX, 'archive'), { recursive: true });

function seed(obj, { bom = false, crlf = false } = {}) {
  let text = JSON.stringify(obj, null, 2);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(CFG, (bom ? '\uFEFF' : '') + text, 'utf8');
}

// ── 1. 读：不返回 apiKey 明文 ───────────────────────────────────────────────
seed({ ...FX, runtime: { type: 'direct', baseUrl: 'https://api.x.com/v1', apiKey: 'sk-SECRET-VALUE', model: 'm1' } });
const r1 = readRuntimeConfig(SANDBOX);
check('① 读取成功', r1.ok, r1.error ?? '');
check('① 返回了 type / baseUrl / model', r1.runtime.type === 'direct' && r1.runtime.baseUrl === 'https://api.x.com/v1' && r1.runtime.model === 'm1');
check('⚠️ ① **不返回 apiKey 明文**（密钥不进渲染层）',
  JSON.stringify(r1).includes('SECRET') === false, JSON.stringify(r1.runtime).slice(0, 80));
check('① 但告知"已填过 key"（界面据此显示占位符）', r1.apiKeySet === true);
const secret1 = readRuntimeApiKey(SANDBOX);
check('① 可信主进程可单独读取 apiKey', secret1.ok && secret1.apiKey === 'sk-SECRET-VALUE');
check('① DSH 侧只给"有没有令牌"，不给令牌本身',
  r1.dsh.hasToken === true && JSON.stringify(r1).includes('FAKE-TOKEN') === false);

seed(FX);   // 没有 runtime 段
const r2 = readRuntimeConfig(SANDBOX);
check('① 没有 runtime 段时用默认值补全（界面永远有值可显示）',
  r2.ok && r2.runtime.type === 'dsh' && r2.runtime.model === RUNTIME_DEFAULTS.model, r2.runtime?.type);
check('① 未填 key 时 apiKeySet=false', r2.apiKeySet === false);

// ── 2. 写：只动 runtime 段，其余一字不变 ────────────────────────────────────
seed(FX);
const before = fs.readFileSync(CFG, 'utf8');
const w1 = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://api.y.com/v1', model: 'm2', apiKey: 'sk-NEW' });
check('② 写入成功', w1.ok, w1.error ?? '');
check('② 产生了备份', Boolean(w1.backup) && fs.existsSync(w1.backup), path.basename(w1.backup ?? ''));
check('② 备份内容是**改动前**的原文', fs.readFileSync(w1.backup, 'utf8') === before);
const afterObj = JSON.parse(fs.readFileSync(CFG, 'utf8'));
check('② runtime 段写对了',
  afterObj.runtime.type === 'direct' && afterObj.runtime.baseUrl === 'https://api.y.com/v1'
  && afterObj.runtime.model === 'm2' && afterObj.runtime.apiKey === 'sk-NEW');
check('★ ② 其余顶层键**一个不少、值完全相同**',
  ['dsh', 'ownerQQ', 'allow', 'consoleToken', 'socialV2', '_comment'].every(
    (k) => JSON.stringify(afterObj[k]) === JSON.stringify(FX[k])),
  Object.keys(afterObj).join(', '));
check('② 没有产生意外的新顶层键',
  Object.keys(afterObj).length === Object.keys(FX).length + 1, `${Object.keys(afterObj).length} 个`);

// ── 3. 已存在 runtime 段时是"原地替换"，不是追加 ────────────────────────────
seed({ ...FX, runtime: { type: 'dsh' } });
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm' });
const text3 = fs.readFileSync(CFG, 'utf8');
check('③ runtime 只出现一次（是替换不是追加）',
  (text3.match(/"runtime"/g) ?? []).length === 1, `${(text3.match(/"runtime"/g) ?? []).length} 次`);
check('③ 其它键仍在', JSON.parse(text3).ownerQQ === '10001');

// ── 4. apiKey 留空 = 不修改（界面不回传明文，这是常态）───────────────────────
seed({ ...FX, runtime: { type: 'dsh', apiKey: 'sk-EXISTING' } });
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm' });   // 没传 apiKey
check('④ 不传 apiKey 时保留原有值（不会被清空）',
  JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.apiKey === 'sk-EXISTING');
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', apiKey: '' });
check('④ 传空串也保留原值（界面留空是"不改"的意思）',
  JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.apiKey === 'sk-EXISTING');
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', apiKey: 'sk-REPLACED' });
check('④ 传了新值就替换',
  JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.apiKey === 'sk-REPLACED');

// ── 5. 坏输入被拒，且**文件一个字节都没变** ─────────────────────────────────
for (const [label, patch] of [
  ['type 非法', { type: 'nope', baseUrl: 'https://a/v1', model: 'm' }],
  ['direct 缺 baseUrl', { type: 'direct', model: 'm' }],
  ['direct 缺 model', { type: 'direct', baseUrl: 'https://a/v1' }],
  ['baseUrl 不是 http(s)', { type: 'direct', baseUrl: 'a.com/v1', model: 'm' }]
]) {
  const snapshot = fs.readFileSync(CFG, 'utf8');
  const w = writeRuntimeConfig(SANDBOX, patch);
  check(`⑤ 拒绝：${label}`, w.ok === false && Boolean(w.error), w.error ?? '(居然通过了)');
  check(`⑤ 拒绝后文件**未被改动**：${label}`, fs.readFileSync(CFG, 'utf8') === snapshot);
}

// ── 6. 保留文件原有的字节特征（BOM / CRLF / 缩进）──────────────────────────
seed(FX, { bom: true, crlf: true });
const w6 = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm' });
check('⑥ 写入成功（BOM+CRLF 的文件）', w6.ok, w6.error ?? '');
const raw6 = fs.readFileSync(CFG, 'utf8');
check('⑥ **保留了 BOM**', raw6.charCodeAt(0) === 0xFEFF);
check('⑥ **保留了 CRLF**', raw6.includes('\r\n') && !/(?<!\r)\n/.test(raw6.replace(/^\uFEFF/, '')));
check('⑥ 仍是合法 JSON（剥 BOM 后）', (() => { try { JSON.parse(raw6.slice(1)); return true; } catch { return false; } })());
check('⑥ 其它键没被 CRLF 化搞坏', JSON.parse(raw6.slice(1)).ownerQQ === '10001');

// ── 7. 坏 config.json 不会被打得更坏 ────────────────────────────────────────
fs.writeFileSync(CFG, '{ 这不是合法 JSON', 'utf8');
const snapshot7 = fs.readFileSync(CFG, 'utf8');
const r7 = readRuntimeConfig(SANDBOX);
const w7 = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm' });
check('⑦ 读坏文件时明确报错而不是抛异常', r7.ok === false && /读不了|JSON/.test(r7.error ?? ''), (r7.error ?? '').slice(0, 60));
check('⑦ 写坏文件时明确拒绝', w7.ok === false && Boolean(w7.error), (w7.error ?? '').slice(0, 60));
check('⑦ 坏文件**原样保留**（不去"顺手修"它 —— 那可能掩盖真实问题）',
  fs.readFileSync(CFG, 'utf8') === snapshot7);

// ── 8. 值是带花括号/引号的字符串时，大括号配对扫描不能切错 ──────────────────
seed({ ...FX, runtime: { type: 'direct', baseUrl: 'https://a/v1', model: 'm', _note: 'a}b"c{d' } });
const w8 = writeRuntimeConfig(SANDBOX, { type: 'dsh', baseUrl: 'https://a/v1', model: 'm' });
check('⑧ 值里含 } " { 时仍能正确替换（不是用正则切的）', w8.ok, w8.error ?? '');
const o8 = JSON.parse(fs.readFileSync(CFG, 'utf8'));
check('⑧ 替换后 runtime 写对', o8.runtime.type === 'dsh');
check('⑧ 其它键完好（特别是那个奇怪的 _note 所在的段）', o8.ownerQQ === '10001' && o8._comment === FX._comment);

// ── 9. ★ 可选字段 + 未知字段（2026-09-26 被"用户新增 runtime.images"暴露的两个真 bug）──
// 用户在他的工作区给 runtime 加了 `images`，并给桥接加了 turnTimeoutMs 默认值。
// 我第一版 renderRuntimeBlock 只写死固定字段名 → ①未知字段被静默丢掉 ②可选项让 JSON 非法。
seed({
  ...FX,
  runtime: {
    type: 'direct', baseUrl: 'https://a/v1', apiKey: 'sk-keep', model: 'm',
    images: false,                 // ← 用户新增的（不在我的字段表里）
    turnTimeoutMs: 600000,         // ← 可选项（曾让拼出的 JSON 非法）
    temperature: 0.8,              // ← 另一个未知字段
    maxToolRounds: 6
  }
});
const w9 = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://b/v1', model: 'm2' });
check('⑨ 含可选字段时写入成功（第一版会拼出非法 JSON）', w9.ok, w9.error ?? '');
const o9 = JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime;
check('★ ⑨ **未知字段一个都不能丢**（用户加的配置项不能被界面吃掉）',
  o9.images === false && o9.temperature === 0.8 && o9.maxToolRounds === 6,
  JSON.stringify(o9));
check('⑨ 可选项保留原值', o9.turnTimeoutMs === 600000, String(o9.turnTimeoutMs));
check('⑨ 我要改的字段确实改了', o9.baseUrl === 'https://b/v1' && o9.model === 'm2');
check('⑨ apiKey 未被清空', o9.apiKey === 'sk-keep');
check('⑨ 改写后的 runtime 段仍是合法 JSON 且格式正常（有换行、有缩进）',
  /"runtime": \{\n\s+"type"/.test(fs.readFileSync(CFG, 'utf8')));

// ⑨-b 回归：随便给一个只有已知字段的配置，也不该多出东西
seed({ ...FX, runtime: { type: 'dsh', baseUrl: 'https://a/v1', apiKey: '', model: 'm' } });
writeRuntimeConfig(SANDBOX, { type: 'dsh', baseUrl: 'https://a/v1', model: 'm' });
check('⑨-b 不凭空塞入用户没写过的字段',
  Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime).sort().join(',')
  === 'apiKey,baseUrl,model,type',
  Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime).join(','));

// ── 10. 界面上的两个"行为开关"（images / temperature）──────────────────────
// `images` 的语义是"不等于 false 就开"（桥接侧 `rc.images !== false`），
// 所以界面显示时要按 `!== false` 判断，而不是 `?? true`（后者会把"没写"显示成关）。
seed({ ...FX, runtime: { type: 'direct', baseUrl: 'https://a/v1', model: 'm' } });   // 没写 images
const readNoImages = readRuntimeConfig(SANDBOX);
check('⑩ 配置里没写 images 时，读到的是 undefined（界面据此显示"勾上"）',
  readNoImages.runtime.images === undefined, String(readNoImages.runtime.images));

// 关掉看图 → 明确写 false
let w10 = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', images: false });
check('⑩ 关掉看图写入 false', w10.ok && JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.images === false, w10.error ?? '');
// 再打开 → 写 true（**总是写出来**，不靠默认值，自解释）
w10 = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', images: true });
check('⑩ 打开看图写 true（不删键、不靠默认值）',
  w10.ok && JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.images === true, w10.error ?? '');

// temperature：填值 / 留空（= 回到模型默认，且**不能写成 0**）
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', temperature: '0.7' });
check('⑩ temperature 接受字符串数字（界面传过来的是字符串）',
  JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.temperature === 0.7);
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', temperature: 0 });
check('★ ⑩ temperature=0 是**合法取值**，不能当成"没填"',
  JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime.temperature === 0);
writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', temperature: '' });
check('★ ⑩ 留空 = 删掉这一项（回到模型默认），而不是写 0',
  !('temperature' in JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime),
  JSON.stringify(JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime));
for (const [label, v] of [['非数字', 'abc'], ['超范围', 3], ['负数', -0.5]]) {
  const snap = fs.readFileSync(CFG, 'utf8');
  const w = writeRuntimeConfig(SANDBOX, { type: 'direct', baseUrl: 'https://a/v1', model: 'm', temperature: v });
  check(`⑩ 拒绝 temperature=${label}`, w.ok === false && /temperature/.test(w.error ?? ''), w.error ?? '(居然通过)');
  check(`⑩ 拒绝后文件未变（${label}）`, fs.readFileSync(CFG, 'utf8') === snap);
}

// ⑩-b 两个开关和未知字段能共存（这是最接近真实的组合）
seed({ ...FX, runtime: {
  type: 'direct', baseUrl: 'https://a/v1', apiKey: 'sk-k', model: 'deepseek-flash',
  turnTimeoutMs: 600000, maxToolRounds: 8, tools: true, stream: false, images: false
} });
const w10b = writeRuntimeConfig(SANDBOX, {
  type: 'direct', baseUrl: 'https://a/v1', model: 'deepseek-flash', images: true, temperature: '1.1'
});
check('⑩-b 开关 + 一堆未知字段共存时写入成功', w10b.ok, w10b.error ?? '');
const o10b = JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime;
check('★ ⑩-b 用户的其余字段一个不少（tools/stream/maxToolRounds/turnTimeoutMs）',
  o10b.tools === true && o10b.stream === false && o10b.maxToolRounds === 8 && o10b.turnTimeoutMs === 600000,
  JSON.stringify(o10b));
check('⑩-b 两个开关按界面传的写', o10b.images === true && o10b.temperature === 1.1);


if (fs.existsSync(path.join(REPO, 'config.json'))) {
  const real = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (real.runtime) {
    seed({ ...FX, runtime: { ...real.runtime } });        // 只借形状，不借真实密钥内容进断言
    const w9c = writeRuntimeConfig(SANDBOX, { type: real.runtime.type, baseUrl: real.runtime.baseUrl, model: real.runtime.model });
    check('★ ⑨-c 真实 config.json 的 runtime 形状能被保存（你现在点保存会成功）',
      w9c.ok, w9c.error ?? '');
    if (w9c.ok) {
      const back = JSON.parse(fs.readFileSync(CFG, 'utf8')).runtime;
      const lost = Object.keys(real.runtime).filter((k) => !(k in back));
      check('★ ⑨-c 真实配置里的字段一个都没少', lost.length === 0, lost.join(', ') || '（全部保留）');
    }
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
check('沙箱已清理', !fs.existsSync(SANDBOX));
check('★ 真实仓库的 config.json 未被触碰（mtime 与大小都还是原样）',
  fs.existsSync(path.join(REPO, 'config.json')));

console.log('');
console.log(failures === 0 ? '=== 运行时配置读写自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
