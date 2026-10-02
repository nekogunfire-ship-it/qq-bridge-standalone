// `tools/show-config-safe.mjs` 的自检 —— 这个工具的存在本身就是为了**防止密钥泄漏**，
// 所以它必须被断言守住："输出里不能出现任何完整密钥/QQ 号"。
//
// 直接对**真实 config.json** 跑（只读），因为要验的正是"真实文件里的真实密钥不会漏出去"。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'show-config-safe.mjs');
const CFG = path.join(ROOT, 'config.json');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const run = (args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

// ── 从真实配置里取出"不许出现"的值 ──────────────────────────────────────────
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = null; }
if (!cfg) {
  console.log('SKIP 读不到 config.json，跳过（这是真实仓库的自检）');
  process.exit(0);
}

/** 收集所有"敏感的完整字符串"（密钥类 + QQ 号类）
 *  ⚠️ 敏感键的判据必须是"**以** key/token/… 结尾" ——
 *     写成"包含 key"会把 `mustReplyKeywords`（聊天的关键词列表）误当成密钥，
 *     而那只是普通配置，打码它反而让视图失去意义。（我第一版就写错了）*/
const secrets = [];
const QQ_RE = /^\d{5,12}$/;
const SECRET_RE = /(key|token|secret|password|passwd|credential|cookie|auth)$/i;
(function walk(v, k = '') {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, k));
  if (v && typeof v === 'object') return Object.entries(v).forEach(([kk, vv]) => walk(vv, kk));
  if (typeof v !== 'string' || v.length < 5) return;
  if (SECRET_RE.test(k) || QQ_RE.test(v)) secrets.push({ key: k, val: v });
})(cfg);

check('从真实配置里取到了若干敏感值（否则这个测试没意义）', secrets.length > 0, `${secrets.length} 个`);

// ── 全量输出：不许出现任何敏感完整值 ───────────────────────────────────────
const full = run([]);
check('默认模式退出码 0', full.status === 0, `退出码 ${full.status}`);
const leaked = secrets.filter((s) => full.out.includes(s.val));
check('默认输出里**没有任何**完整密钥/QQ 号', leaked.length === 0,
  leaked.length ? `泄漏：${leaked.map((l) => l.key).join(', ')}` : `${secrets.length} 个全部被遮住`);

// ── 单段输出（runtime）也不许漏 ─────────────────────────────────────────────
const rt = run(['runtime']);
if (cfg.runtime) {
  const rtSecrets = secrets.filter((s) => s.key === 'apiKey' || s.key === 'token');
  const rtLeak = rtSecrets.filter((s) => rt.out.includes(s.val));
  check('runtime 段输出里没有完整密钥', rtLeak.length === 0,
    rtLeak.length ? '泄漏！' : '已打码');
  check('打码后仍能看出"这里填了值"（不是完全隐藏，便于判断配没配）',
    /已打码/.test(rt.out), '（含"已打码"标记）');
}

// ── --keys 模式：连值都不显示 ───────────────────────────────────────────────
const keys = run(['--keys']);
check('--keys 退出码 0', keys.status === 0);
check('--keys 只列键名，不显示任何值',
  secrets.every((s) => !keys.out.includes(s.val)), '没有任何值出现');
check('--keys 列出了全部顶层键',
  Object.keys(cfg).every((k) => keys.out.includes(k)), `${Object.keys(cfg).length} 个`);

// ── 不存在的段要明确报错 ────────────────────────────────────────────────────
const bad = run(['no-such-section']);
check('不存在的段明确报错且非 0 退出', bad.status !== 0 && /没有名为/.test(bad.out));

console.log('');
console.log(failures === 0 ? '=== 安全配置视图自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
