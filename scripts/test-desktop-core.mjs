// desktop 核心模块自检（不需要 Electron）：
//   - launcher 封装能取到状态
//   - health 体检能跑通并给出结构化结果
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launcherStatus, launcherDiagnose } from '../desktop/lib/launcher.js';
import { healthCheck, probePort, readConfig } from '../desktop/lib/health.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── 配置读取 ────────────────────────────────────────────────────────────────
const cfg = readConfig(ROOT);
check('能读到 config.json', cfg != null);
check('config.json 声明 ownerQQ 字段（公开模板允许为空）',
  cfg != null && Object.prototype.hasOwnProperty.call(cfg, 'ownerQQ'),
  cfg?.ownerQQ ? '本机已配置（不输出明文）' : '脱敏/首次安装状态');

// ── 端口探测 ────────────────────────────────────────────────────────────────
// ⚠️ **自己起监听来验，不要去探用户真实桥接的 3100** ——
// 原来那版是这样写的：
//     check('probePort 对监听中的端口返回 true', (await probePort('127.0.0.1', 3100)) === true);
// 于是**测试的通过与否取决于外部运行状态**：用户当时正好在重启桥接，端口短暂关闭，
// 探针 1200ms 超时 → 偶发失败（实测全量跑时失败过一次，单独跑又通过）。
// 现在改成"临时监听一个空闲端口 → 探它 → 关掉"，断言只依赖自己，不受外部影响。
const tmpServer = net.createServer();
await new Promise((resolve) => tmpServer.listen(0, '127.0.0.1', resolve));
const tmpPort = tmpServer.address().port;
try {
  check('probePort 对监听中的端口返回 true', (await probePort('127.0.0.1', tmpPort)) === true, `自建监听 ${tmpPort}`);
} finally {
  await new Promise((resolve) => tmpServer.close(resolve));
}
// 关掉之后再探一次：顺便验证"端口关了就返回 false"，比探一个固定死端口更有信息量
check('端口关闭后 probePort 返回 false', (await probePort('127.0.0.1', tmpPort)) === false);
check('probePort 对未监听端口返回 false', (await probePort('127.0.0.1', 59999)) === false);

// ── launcher 状态 ───────────────────────────────────────────────────────────
const st = await launcherStatus(ROOT);
check('launcher status 执行成功', st.ok, `exit=${st.exitCode}`);
check('launcher status 返回 JSON', st.payload != null, st.payload ? Object.keys(st.payload).slice(0, 8).join(',') : 'null');

// ── 体检 ────────────────────────────────────────────────────────────────────
const health = await healthCheck(ROOT);
check('体检返回 overall', ['ok', 'degraded', 'error'].includes(health.overall), health.overall);
// 体检要覆盖"这个运行时真正需要的东西"。
// ⚠️ 这条断言原来写死 `['config','bridge','dsh','snowluma']` —— 那是「DSH 永远是四项关键服务之一」
//    的旧假设。用户选 direct 之后它就不成立了（机器人根本不经过 DSH），
//    而界面还在据此报红说"没有 DSH，AI 不会回复任何消息" —— 正是"界面在说假话"的来源。
const runtimeType = cfg?.runtime?.type === 'direct' ? 'direct' : 'dsh';
const needKeys = runtimeType === 'direct'
  ? ['config', 'bridge', 'runtime', 'snowluma']
  : ['config', 'bridge', 'dsh', 'snowluma'];
check(`体检覆盖该运行时需要的服务（${runtimeType} → ${needKeys.join('+')}）`,
  needKeys.every((k) => health.items.some((i) => i.key === k)),
  health.items.map((i) => `${i.key}:${i.status}`).join(' '));
check('每项都有说明文字', health.items.every((i) => typeof i.detail === 'string' && i.detail.length > 0));
check('体检结果不暴露完整 ownerQQ', !cfg?.ownerQQ || !JSON.stringify(health).includes(String(cfg.ownerQQ)));
check('失败项都带可操作按钮',
  health.items.filter((i) => i.status === 'error').every((i) => i.actions.length > 0),
  health.items.filter((i) => i.status === 'error').map((i) => i.key).join(',') || '(无失败项)');

// ── ★ direct 下 DSH 缺失**不该**让整体变红（用户反馈"还是与 DSH 强行绑定"的根因之一）──
// 用死端口模拟"机器上根本没有 DSH"，不动用户真实在跑的那份。
const noDsh = await healthCheck(ROOT, { dshManagerPort: 39199 });
if (runtimeType === 'direct') {
  check('★ direct 模式下 DSH 不在线时**根本不出现 dsh 项**（不提才叫不绑）',
    !noDsh.items.some((i) => i.key === 'dsh'),
    noDsh.items.map((i) => i.key).join(','));
  check('★ direct 模式下有「AI 运行时」项，且写明是直连',
    (() => { const it = noDsh.items.find((i) => i.key === 'runtime'); return Boolean(it) && /直连/.test(it.detail); })(),
    noDsh.items.find((i) => i.key === 'runtime')?.detail ?? '(没有该项)');
} else {
  console.log('INFO 当前配置是挂 DSH，跳过 direct 专用断言');
}

// ── ★ 反向：挂 DSH 时它**仍然**是关键项，该报错就报错（别把脱钩做成"什么都不管了"）──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-health-'));
try {
  fs.writeFileSync(path.join(tmpRoot, 'config.json'), JSON.stringify({
    ownerQQ: '1', snowluma: { wsUrl: 'ws://127.0.0.1:3001' }, runtime: { type: 'dsh' }
  }), 'utf8');
  const asDsh = await healthCheck(tmpRoot, { dshManagerPort: 39199, snowlumaPort: 39198, consolePort: 39197 });
  const dshItem = asDsh.items.find((i) => i.key === 'dsh');
  check('★ 挂 DSH 时它仍是关键项（DSH 不在线 → 整体 error）',
    asDsh.overall === 'error' && dshItem?.status === 'error' && !dshItem.optional,
    `overall=${asDsh.overall} dsh=${dshItem?.status}`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ── 图标：候选必须**真的存在** ────────────────────────────────────────────────
// 这条护栏是有来历的：托盘/窗口原来的候选是 dsh-0.1.13.ico / assets/icon.png /
// public/favicon.ico —— **三个都不存在**，于是 Tray 一直拿到 `createEmpty()`，
// 托盘上是空的，而**没有任何东西会报警**（`nativeImage` 不抛异常）。
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.mjs'), 'utf8');
const iconFn = mainSrc.match(/function trayIcon\([\s\S]*?\n\}/)?.[0] ?? '';
check('主进程里能找到 trayIcon() 定义', iconFn.length > 0);
// ⚠️ 判据要**先剥掉注释**：注释里合法地会写"原来引用的是 dsh-xxx.ico（已失效）"来解释历史，
//    直接全文匹配会把它当成"还在引用"—— 误报，而且会逼着人删掉那句有用的注释。
//    （同族教训：文档审计把"⚠️ 已移除 xxx"这句话本身报成失效引用。）
const iconCode = iconFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('不再引用 DSH 的图标（脱钩残留）', !/dsh-[\d.]*\.ico/i.test(iconCode),
  (iconCode.match(/dsh-[\d.]*\.ico/gi) ?? []).join(',') || '(代码里没有；注释里提到过属正常)');
// 把候选里的 'assets', 'xxx' 抠出来逐个查在不在
const candNames = [...iconCode.matchAll(/path\.join\(ROOT,\s*'([^']+)',\s*'([^']+)'\)/g)]
  .map((m) => path.join(ROOT, m[1], m[2]));
check('trayIcon 的候选里至少有 2 个仓库内路径', candNames.length >= 2, candNames.map((p) => path.basename(p)).join(','));
check('★ 图标候选至少有一个真实存在（否则托盘是空图标）',
  candNames.some((p) => fs.existsSync(p)),
  candNames.map((p) => `${path.basename(p)}:${fs.existsSync(p) ? '有' : '无'}`).join(' '));
for (const rel of ['assets/app-icon.png', 'assets/tray-icon.png']) {
  const p = path.join(ROOT, rel);
  const ok = fs.existsSync(p) && fs.readFileSync(p).subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  check(`${rel} 存在且是合法 PNG`, ok);
}
console.log('');
console.log('--- 体检结果 ---');
console.log(`overall: ${health.overall}`);
for (const i of health.items) {
  const mark = { ok: '✅', warn: '⚠️ ', error: '❌', off: '⭕' }[i.status] ?? '?';
  console.log(`  ${mark} ${i.label.padEnd(18)} ${i.detail}${i.actions.length ? `  [${i.actions.map((a) => a.label).join('/')}]` : ''}`);
}

console.log('');
console.log(failures === 0 ? '=== desktop 核心模块自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
