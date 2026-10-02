// UI 采集脚本的自检。
//
// 采集脚本是**以字符串形式**存进 desktop/lib/ui-probe.js、再送进渲染层执行的，
// 所以它有两个普通代码没有的风险：
//   ① 字符串里的语法错误在构建期完全看不出来（`node --check` 只查外层文件）；
//   ② 它引用的 id/选择器一旦在 index.html 里被改名，采集就会静默少数据
//      （而不是报错）—— 那正是"看不到界面还拿不到数据"的最坏情况。
//
// 这里把字符串抠出来做这两件事的检查。不需要 Electron、不需要 JS DOM。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'desktop', 'lib', 'ui-probe.js');
const HTML = path.join(ROOT, 'desktop', 'renderer', 'index.html');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const src = fs.readFileSync(PROBE, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

// ── 1. 抠出采集脚本 ─────────────────────────────────────────────────────────
const m = src.match(/const COLLECT_SCRIPT = `([\s\S]*?)\n\}\)\(\)`;/);
if (!m) {
  console.error('❌ 没能在 ui-probe.js 里定位 COLLECT_SCRIPT（模板字符串边界变了？）');
  process.exit(1);
}
const body = `${m[1]}\n})()`;
check('抠出采集脚本', body.length > 500, `${body.length} 字符`);

// ── 2. 语法检查（这是普通 node --check 覆盖不到的部分）──────────────────────
let syntaxOk = true;
let syntaxErr = '';
try { new Function(body); } catch (e) { syntaxOk = false; syntaxErr = e.message; }
check('采集脚本本身语法正常', syntaxOk, syntaxErr);

// ── 3. 它引用的选择器必须都存在于 index.html ────────────────────────────────
//    注意：采集脚本里用的是**变量**（`getElementById(id)`、`querySelector(sel)`），
//    选择器本身躺在 VIEWS / KEYS 这些**数组字面量**里。所以要从字符串字面量里找，
//    而不是从函数调用的参数里找（我第一版就是这么找错、结果查出 0 个）。
const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
const classesInHtml = new Set(
  [...html.matchAll(/class="([^"]+)"/g)].flatMap((x) => x[1].split(/\s+/)).filter(Boolean)
);

const selIdLiterals = [...new Set([...body.matchAll(/'#([A-Za-z0-9_-]+)'/g)].map((x) => x[1]))];
const classLiterals = [...new Set([...body.matchAll(/'\.([A-Za-z0-9_-]+)'/g)].map((x) => x[1]))];
// 分区 id 是裸字符串（VIEWS 数组），单独从分区循环里取
const viewIdLiterals = ['viewOverview', 'viewMonitor', 'viewSettings'].filter((v) => body.includes(`'${v}'`));

check('从采集脚本里提取到 id 选择器', selIdLiterals.length >= 8, `${selIdLiterals.length} 个：${selIdLiterals.slice(0, 5).join(', ')}…`);
const missingIds = selIdLiterals.filter((id) => !idsInHtml.has(id));
check('引用的 #id 选择器全部存在于 index.html', missingIds.length === 0,
  missingIds.length ? `缺失：${missingIds.join(', ')}` : `${selIdLiterals.length} 个全部命中`);

check('从采集脚本里提取到类选择器', classLiterals.length >= 2, classLiterals.join(', '));

// 类选择器分两种，校验方式不同：
//   · **静态**的（index.html 里就有）→ 必须能在 index.html 找到
//   · **动态**的（JS 运行时创建，如 .act-row）→ 静态文件里当然没有，要去 app.js 找它被创建
// 我第一版把两种混在一起，检查工具于是报了 .act-row "缺失" —— 那是误报，因为它没区分这两类。
const appSrcForClasses = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer', 'app.js'), 'utf8');
const missingCls = [];
const dynamicCls = [];
for (const c of classLiterals) {
  if (classesInHtml.has(c)) continue;
  // 动态创建：className 赋值或 classList.add
  if (new RegExp(`className\\s*=\\s*['"\`][^'"\`]*\\b${c}\\b`).test(appSrcForClasses)
    || new RegExp(`classList\\.add\\([^)]*['"\`]${c}['"\`]`).test(appSrcForClasses)) {
    dynamicCls.push(c);
    continue;
  }
  missingCls.push(c);
}
check('引用的 .class 选择器都存在（静态的在 html 里，动态的在 app.js 里被创建）',
  missingCls.length === 0,
  missingCls.length ? `缺失：${missingCls.join(', ')}`
    : `${classLiterals.length} 个命中（其中动态创建 ${dynamicCls.length} 个：${dynamicCls.join(', ') || '无'}）`);

check('采集脚本覆盖了三个分区 id', viewIdLiterals.length === 3, viewIdLiterals.join(', '));

// ── 4. 三个分区的 id 必须都在（分区改名会让采集目标全空）────────────────────
for (const id of ['viewOverview', 'viewMonitor', 'viewSettings']) {
  check(`分区 ${id} 在 index.html 中存在`, idsInHtml.has(id));
  check(`采集脚本覆盖了 ${id}`, body.includes(id));
}

// ── 5. 类选择器也要存在（.settings-grid / .panel-danger / .titlebar / .tabs）──
const classSels = [...new Set([...body.matchAll(/querySelector\('\.([A-Za-z0-9_-]+)'\)/g)].map((x) => x[1]))];
for (const cls of classSels) {
  check(`类选择器 .${cls} 在 index.html 中存在`, new RegExp(`class="[^"]*\\b${cls}\\b`).test(html));
}

// ── 6. 测量隐藏分区的写法必须成对（显示 → 量 → 还原），否则界面会被永久改状态 ──
check('采集脚本会临时显示隐藏分区以便测量（否则量到 0×0）',
  /el\.hidden = false/.test(body) && /el\.hidden = original/.test(body));
check('为测量临时显示的分区会被还原',
  /for \(const v of shownForMeasure\) v\.hidden = true;/.test(body));

// ── 7. summarize 的输出包含关键信息（日志里要看得懂）────────────────────────
for (const key of ['视口', '溢出', 'RendererPure']) {
  check(`summarize 输出包含「${key}」`, src.includes(key));
}

console.log('');
console.log(failures === 0 ? '=== UI 采集脚本自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
