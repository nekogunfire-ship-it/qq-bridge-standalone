// 安全地查看 config.json 的某个段落 —— **绝不打印原文件**。
//
// 存在的理由（2026-09-26 的真实事故）：
// 我想给用户看 runtime 段现状，用了 `Get-Content config.json | Select -First 7`，
// 结果把 `"apiKey": "sk-…"` **明文打进了会话记录** —— 而会话记录会落盘且**无法移除**，
// 唯一补救是让用户撤销并重建那把 key。
//
// 根源不是"不知道要打码"，而是**在"只是给你看一眼"这种低戒备场景下**，
// 之前定的规矩失效了。所以把正确做法做成一条命令，而不是靠记得：
//
//   node tools/show-config-safe.mjs              # 默认打码敏感字段
//   node tools/show-config-safe.mjs --keys       # 只看顶层键名（连值都不显示）
//   node tools/show-config-safe.mjs runtime      # 只看某一段
//
// 打码规则与 `describeDirectConfig()` / 预检工具保持一致（只露前 4 位）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function argValue(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; }
const has = (n) => process.argv.includes(n);

const ROOT = path.resolve(argValue('--root') ?? REPO);
const CFG = path.join(ROOT, 'config.json');

// 名字**以这些词结尾**的键才算敏感字段。
// ⚠️ 不能写成"包含 key" —— `mustReplyKeywords` / `recommendedKeywords` 这类**聊天的关键词列表**
//    会被误判成密钥，而它们的值是中文词，打码后视图就没用了（自检当场抓到过这个误判）。
const SECRET_KEY_RE = /(key|token|secret|password|passwd|credential|cookie|auth)$/i;
// QQ 号也是隐私（本项目的邮件/打包工具都把它当隐私处理：ownerQQ、allow/deny 名单）
const QQ_LIKE_RE = /^\d{5,12}$/;
// 只有**足够长**的值才允许露前几位：
// ⚠️ 我第一版无脑 `slice(0,4)`，结果 `在吗` 这种 2 字符的值被"打码"后**原样显示** ——
//    等于没打。短值一律整体遮蔽。（自检的"输出里不能出现完整值"断言抓到的）
const MIN_LEN_TO_PEEK = 12;

/** 递归打码：敏感键只露前 4 位（且仅当值足够长）；纯数字的 QQ 号也打码 */
function mask(value, keyName = '') {
  if (Array.isArray(value)) return value.map((v) => mask(v, keyName));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mask(v, k);
    return out;
  }
  if (typeof value === 'string' && value) {
    if (SECRET_KEY_RE.test(keyName)) {
      return value.length >= MIN_LEN_TO_PEEK
        ? `${value.slice(0, 4)}…（${value.length} 字符，已打码）`
        : `***（${value.length} 字符，已打码）`;
    }
    if (QQ_LIKE_RE.test(value)) return `${value.slice(0, 2)}***${value.slice(-2)}（QQ 号，已打码）`;
  }
  return value;
}

let cfg;
let hadBom = false;
try {
  let text = fs.readFileSync(CFG, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) { hadBom = true; text = text.slice(1); }
  cfg = JSON.parse(text);
} catch (e) {
  console.error(`❌ 读不了 config.json：${e?.message ?? e}`);
  process.exit(1);
}

console.log(`=== config.json 安全视图（敏感字段已打码）===`);
console.log(`  文件：${CFG}`);
if (hadBom) console.log('  注：文件带 UTF-8 BOM（桥接能正常读）');
console.log('');

if (has('--keys')) {
  console.log(`  顶层键 ${Object.keys(cfg).length} 个：`);
  for (const k of Object.keys(cfg)) console.log(`    ${k}`);
  process.exit(0);
}

const section = process.argv.slice(2).find((a) => !a.startsWith('--'));
const view = section ? { [section]: cfg[section] } : cfg;
if (section && cfg[section] === undefined) {
  console.error(`❌ 没有名为 ${section} 的段。可用段：${Object.keys(cfg).join(', ')}`);
  process.exit(1);
}
console.log(JSON.stringify(mask(view), null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
console.log('');
console.log('（本工具只读；所有 token/key/secret 类字段已打码。不要用 cat / Get-Content 直接看配置文件。）');
