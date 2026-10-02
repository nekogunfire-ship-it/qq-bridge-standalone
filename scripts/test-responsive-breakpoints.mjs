// 「响应式断点必须可达」的护栏。
//
// 起因（2026-09-26，UI 步骤 D）：我给活动流写了一条 `@media (max-width: 720px)`，
// 而**主窗口的 minWidth 是 900** —— 那条规则**永远不会触发**，是纯死代码。
// 这类错误没有任何现有测试会发现（CSS 语法合法、选择器也真实存在），
// 只有把"断点"与"窗口实际能被缩到多窄"对照起来才看得出来。
//
// 所以这条测试守两件事：
//   ① 每条 max-width 断点都必须 ≥ 主窗口的 minWidth（否则不可达）
//   ② 那一档必须"够得着"—— 断点若远大于 minWidth（比如 2000px）也没意义，会提示
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'desktop', 'main.mjs');
const CSS = path.join(ROOT, 'desktop', 'renderer', 'style.css');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── 取主窗口的 minWidth ─────────────────────────────────────────────────────
// main.mjs 里有**两个**窗口（主窗口 + 控制台窗口），minWidth 各不同。
// 用主窗口独有的标记 `settings.window?.width` 定位到它，再找最近的 minWidth ——
// 比"取第一个"或"取最大的"都可靠。
const mainSrc = fs.readFileSync(MAIN, 'utf8');
const anchor = mainSrc.indexOf('settings.window?.width');
check('能在 main.mjs 里定位主窗口的创建代码', anchor > 0, `偏移 ${anchor}`);
const nearMain = mainSrc.slice(anchor, anchor + 600);
const minW = Number((nearMain.match(/minWidth:\s*(\d+)/) ?? [])[1] ?? 0);
check('取到主窗口的 minWidth', minW > 0, `${minW}px`);
const minH = Number((nearMain.match(/minHeight:\s*(\d+)/) ?? [])[1] ?? 0);
console.log(`  （参考：主窗口最小 ${minW}x${minH}；控制台窗口是另一套页面与自己的最小值）`);

// ── 取 style.css 里所有 max-width 断点 ─────────────────────────────────────
const css = fs.readFileSync(CSS, 'utf8');
const breaks = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
check('style.css 里至少有一条 max-width 断点', breaks.length > 0, `${breaks.length} 条`);

// ① 可达性：断点必须 ≥ minWidth
const unreachable = breaks.filter((b) => b < minW);
check('⚠️ 所有 max-width 断点都可达（≥ 主窗口 minWidth）',
  unreachable.length === 0,
  unreachable.length
    ? `不可达：${unreachable.join(', ')}px —— 窗口最窄只能到 ${minW}px，这些规则永远不会触发`
    : `${breaks.join(', ')}px 全部 ≥ ${minW}px`);

// ② 有效性：断点也不该远大于 minWidth（否则那一档几乎用不上）
const tooHigh = breaks.filter((b) => b > minW + 600);
check('断点没有离谱地高于 minWidth（否则那一档形同虚设）',
  tooHigh.length === 0,
  tooHigh.length ? `过高：${tooHigh.join(', ')}px` : `最高断点 ${Math.max(...breaks)}px，与 ${minW}px 相称`);

// ③ 分档要有序（读代码时容易看出层次）
const sorted = [...breaks].sort((a, b) => b - a);
check('断点在文件里是按"从宽到窄"或"从窄到宽"有序排列的',
  JSON.stringify(breaks) === JSON.stringify(sorted) || JSON.stringify(breaks) === JSON.stringify([...sorted].reverse()),
  breaks.join(' → '));

// ④ 活动流那份改动确实挂在了可达的断点上（回归：别再退回 720）
const actBlock = css.slice(css.indexOf('.act-row {'));
const actBreak = Number((css.match(/@media \(max-width:\s*(\d+)px\) \{\s*\.act-row/) ?? [])[1] ?? 0);
check('活动流的窄窗口规则挂在可达断点上', actBreak >= minW || actBreak === 0,
  actBreak ? `${actBreak}px` : '（没有单独为 .act-row 写断点）');
check('活动流用了 grid 布局（窄窗口靠改列数适配）', /\.act-row \{[\s\S]{0,200}display:\s*grid/.test(css));

console.log('');
console.log(failures === 0 ? '=== 响应式断点自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
