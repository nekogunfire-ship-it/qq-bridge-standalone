// 卸载计划的自检。
//
// 卸载是"写错了没有第二次机会"的操作，所以这里重点守两类行为：
//   1. **默认绝不能删东西** —— 不传 --execute 时必须只盘点（用真实 inventory 验证只读）；
//   2. **数据模式的差异必须正确** —— keep 不删数据 / archive 先备份 / purge 才真删；
//      以及 --remove-source 之前源码必须保留在计划里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, buildPlan, formatPlan, ROOT } from '../tools/uninstall-core.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── 1. 盘点只读：跑前后关键文件的 mtime / 存在性不变 ─────────────────────────
const probe = path.join(ROOT, 'state', 'bridge.log');
const before = fs.existsSync(probe) ? fs.statSync(probe).mtimeMs : null;
const inv = inventory();
const after = fs.existsSync(probe) ? fs.statSync(probe).mtimeMs : null;
check('inventory() 不修改任何文件（state/bridge.log mtime 不变）', before === after,
  before === after ? '未改动' : `${before} → ${after}`);

check('盘点出仓库路径', inv.repo === ROOT, inv.repo);
check('盘点出两处 node_modules（根 + 桌面）', inv.nodeModules.length === 2,
  inv.nodeModules.map((x) => `${path.basename(path.dirname(x.path))}=${x.exists}`).join(' '));
check('盘点到 DSH 注入标记块或明确报告未找到',
  typeof inv.dsh.patch.found === 'boolean',
  inv.dsh.patch.found ? `第 ${inv.dsh.patch.begin}~${inv.dsh.patch.end} 行` : '未找到标记块');
check('盘点列出第三方依赖并标出存在性',
  inv.thirdParty.length === 3 && inv.thirdParty.every((t) => typeof t.exists === 'boolean'),
  inv.thirdParty.map((t) => `${t.label}=${t.exists ? '有' : '无'}`).join(', '));

// ── 2. 三种数据模式的差异 ────────────────────────────────────────────────────
const keep = buildPlan(inv, { dataMode: 'keep' });
const archive = buildPlan(inv, { dataMode: 'archive' });
const purge = buildPlan(inv, { dataMode: 'purge' });

const kindsOf = (plan) => plan.steps.map((s) => s.kind);
check('keep 模式：数据步骤是「保留」而不是删除',
  keep.steps.some((s) => s.kind === 'keep' && /保留用户数据/.test(s.title)));
check('archive 模式：数据步骤是「归档」', archive.steps.some((s) => s.kind === 'archive'));
check('purge 模式：数据步骤是「删除」', purge.steps.some((s) => s.kind === 'remove' && /彻底删除用户数据/.test(s.title)));

check('keep 释放空间最小（不释放数据体积）', keep.freeingBytes < archive.freeingBytes,
  `keep=${Math.round(keep.freeingBytes / 1048576)}MB archive=${Math.round(archive.freeingBytes / 1048576)}MB`);
check('purge 释放空间 >= archive（归档只是移动，仍占盘）', purge.freeingBytes >= archive.freeingBytes);

// ── 3. 源码保留/删除 ─────────────────────────────────────────────────────────
check('默认保留源码（计划里明确写出「保留源码」）',
  keep.steps.some((s) => s.kind === 'keep' && /保留源码/.test(s.title)));
check('--remove-source 时改为删除源码目录',
  keep.removeSource === false
  && buildPlan(inv, { removeSource: true }).steps.some((s) => /删除源码目录/.test(s.title)));

// ── 4. 计划必须包含"先停服务"（否则 node_modules 删不掉）──────────────────────
check('计划第一步是停止服务（顺序不能调）',
  /停止服务/.test(keep.steps[0].title), keep.steps[0].title);
check('停止服务排在删除依赖之前',
  keep.steps.findIndex((s) => /停止服务/.test(s.title))
  < keep.steps.findIndex((s) => /node_modules/.test(s.title)));

// ── 5. 第三方依赖只提示、不删除 ──────────────────────────────────────────────
for (const [name, plan] of [['keep', keep], ['archive', archive], ['purge', purge]]) {
  check(`${name} 模式不把第三方列入删除`, !plan.steps.some((s) => s.kind === 'remove' && /第三方/.test(s.title)));
}
check('计划里有一行专门说明第三方不动',
  keep.steps.some((s) => s.kind === 'keep' && /第三方依赖/.test(s.title)));

// ── 6. 输出可读性：每步都有标题，formatPlan 能渲染 ───────────────────────────
check('每步都有标题', keep.steps.every((s) => s.title && s.title.length > 0));
const text = formatPlan(keep);
check('formatPlan 输出行数合理（含每步与总估算）',
  text.split('\n').length >= keep.steps.length && /预计释放空间/.test(text));

console.log('');
console.log(failures === 0 ? '=== 卸载计划自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
