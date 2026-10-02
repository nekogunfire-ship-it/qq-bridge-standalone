// 桌面版静态一致性检查（不需要 Electron）：
//   1. app.js 引用的 DOM id 在 index.html 里都存在
//   2. app.js 调用的 window.desktop.* 方法都在 preload.cjs 里暴露
//   3. preload.cjs 的 ipcRenderer.invoke 通道都在 main.mjs 里注册
//   4. main.mjs 用到的 lib 模块导出都存在
// 这几类错在运行时只会表现为"点了没反应"，静态查出来最省事。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const html = read('desktop/renderer/index.html');
const appJs = read('desktop/renderer/app.js');
const preload = read('desktop/preload.cjs');
const mainJs = read('desktop/main.mjs');

// ── 1. DOM id ───────────────────────────────────────────────────────────────
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
check('app.js 引用的 DOM id 都存在', missingIds.length === 0,
  missingIds.length ? `缺失: ${missingIds.join(', ')}` : `${usedIds.size} 个 id`);

// ── 2. preload 暴露面 ───────────────────────────────────────────────────────
const exposed = new Set([...preload.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]));
const called = new Set([...appJs.matchAll(/window\.desktop\.([a-zA-Z]+)/g)].map((m) => m[1]));
const missingApi = [...called].filter((m) => !exposed.has(m));
check('app.js 调用的方法都已在 preload 暴露', missingApi.length === 0,
  missingApi.length ? `未暴露: ${missingApi.join(', ')}` : `${called.size} 个方法`);

// ── 3. IPC 通道 ─────────────────────────────────────────────────────────────
const handled = new Set([...mainJs.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]));
const missingChannels = [...invoked].filter((c) => !handled.has(c));
check('preload 的 IPC 通道都已在主进程注册', missingChannels.length === 0,
  missingChannels.length ? `未注册: ${missingChannels.join(', ')}` : `${invoked.size} 个通道`);

// 主进程推送的通道也要在 preload 里被监听
const pushed = new Set([...mainJs.matchAll(/broadcast\('([^']+)'/g)].map((m) => m[1]));
const listened = new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]));
const unlistened = [...pushed].filter((c) => !listened.has(c));
check('主进程推送的通道都有渲染层监听', unlistened.length === 0,
  unlistened.length ? `未监听: ${unlistened.join(', ')}` : `${pushed.size} 个推送通道`);

// ── 4. lib 导出 ─────────────────────────────────────────────────────────────
const requiredExports = {
  'desktop/lib/launcher.js': ['runLauncher', 'launcherStatus', 'launcherDiagnose', 'launcherStartAll', 'launcherStopAll', 'launcherRestartAll'],
  'desktop/lib/health.js': ['healthCheck', 'probePort', 'readConfig'],
  'desktop/lib/settings.js': ['loadSettings', 'saveSettings', 'saveSettingsDebounced', 'writeSettingsSync', 'resetSettings', 'SETTINGS_PATH']
};
for (const [file, names] of Object.entries(requiredExports)) {
  const src = read(file);
  const missing = names.filter((n) => !new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${n}\\b`).test(src));
  check(`${path.basename(file)} 导出完整`, missing.length === 0, missing.length ? `缺失: ${missing.join(', ')}` : `${names.length} 个导出`);
}

// ── 5. main.mjs 引用的 lib 函数确实被导出 ───────────────────────────────────
const mainImports = [...mainJs.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/lib\/([^']+)'/g)];
for (const m of mainImports) {
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const file = `desktop/lib/${m[2]}`;
  const src = read(file);
  const missing = names.filter((n) => !new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${n}\\b`).test(src));
  check(`main.mjs 从 ${path.basename(file)} 导入的函数存在`, missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}` : names.join(', '));
}

// ── 6. 危险面：渲染层不应有 node 能力 ───────────────────────────────────────
check('渲染层未使用 require/process（保持无 node 权限）',
  !/\brequire\(|\bprocess\.(env|exit)/.test(appJs));
check('CSP 已声明（禁止外部脚本与内联脚本）',
  /Content-Security-Policy/.test(html) && /script-src 'self'/.test(html));

// 架构变更（2026-09-25）：控制台改为**独立窗口**打开，不再用 iframe 内嵌
// （iframe 受 X-Frame-Options + CSP frame-src + 跨源三重限制，实测持续黑屏）。
// 因此不再要求 frame-src；改为守住两点：① 不再残留 iframe；② 有打开独立窗口的通道。
const cspText = (html.match(/Content-Security-Policy"[^>]*content="([^"]*)"/) ?? [])[1] ?? '';
check('不再使用 iframe 内嵌（已改为独立窗口）',
  !/<iframe/i.test(html) && !/frame-src/i.test(cspText),
  /<iframe/i.test(html) ? '仍存在 <iframe>' : (cspText ? `CSP=${cspText}` : '(未取到 CSP)'));
check('已暴露打开独立控制台窗口的 IPC',
  /openConsoleWindow/.test(appJs) && /console:openWindow/.test(mainJs),
  `app.js=${/openConsoleWindow/.test(appJs)} main.mjs=${/console:openWindow/.test(mainJs)}`);
check('CSP 未放行任意来源（不放行 * 通配）',
  !/(default-src|frame-src|connect-src|script-src)[^;"]*"[^;"]*\*/.test(cspText)
  && !/\*\s*;/.test(cspText),
  cspText || '(未取到 CSP)');

// ── 7. hidden 属性必须真的能隐藏元素 ────────────────────────────────────────
// 作者样式表里的 `display:` 与浏览器默认的 [hidden]{display:none} 同优先级，
// 会覆盖 hidden 属性 —— 实测导致「进度条在操作成功后不消失」。
// 因此必须有 [hidden]{display:none!important} 这条护栏。
const css = read('desktop/renderer/style.css');
const hasHiddenGuard = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(css);
check('CSS 有 [hidden]{display:none!important} 护栏', hasHiddenGuard);

// 用到 hidden 的元素，其类选择器不应声明 display（否则必须靠上面那条护栏兜住）
const hiddenTargets = [...html.matchAll(/id="([^"]+)"[^>]*\bhidden\b/g)].map((m) => m[1]);
const displayClasses = [...css.matchAll(/\.([a-z0-9_-]+)\s*\{[^}]*display\s*:/gi)].map((m) => m[1]);
const risky = hiddenTargets.filter((id) => {
  // 该 id 元素的 class 列表里是否有声明了 display 的类
  const tag = (html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`)) ?? [''])[0];
  const classes = (tag.match(/class="([^"]+)"/) ?? [])[1]?.split(/\s+/) ?? [];
  return classes.some((c) => displayClasses.includes(c));
});
check('带 hidden 的元素若其类声明了 display，则已被护栏覆盖',
  risky.length === 0 || hasHiddenGuard,
  risky.length ? `风险元素: ${risky.join(', ')}` : `${hiddenTargets.length} 个 hidden 元素`);

console.log('');
console.log(failures === 0 ? '=== 桌面版静态检查全部通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
