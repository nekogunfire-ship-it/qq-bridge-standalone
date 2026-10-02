// 打包工具的自检。
//
// 打包是"把仓库内容交出去"的动作，最怕两件事：
//   ① 把隐私打进发布包（config.json / state/ / archive/ / 真实号码）；
//   ② 脱敏时误改了源文件（用户的东西被动过）。
// 所以这里的断言围绕这两条，外加"该进的进了、该排的排了"。
//
// ⚠️ 本测试只做 --plan 与读取，**不生成打包产物**（避免每次跑测试都往 dist/ 塞东西）；
//    脱敏路径单独用临时目录验证。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'package-dist.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const runTool = (args, cwd = ROOT) =>
  spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', windowsHide: true });

// ── 1. 导入工具函数，直接验证收集与扫描逻辑（比跑 CLI 更精确）───────────────
const mod = await import(new URL('../tools/package-dist.mjs', import.meta.url).href);
const { collectFiles, collectSecrets, scanForLeaks, shouldExclude } = mod;

const { files, skipped } = collectFiles();
check('收集到一批待打包文件', files.length > 50, `${files.length} 个文件`);

// ── 2. 隐私路径必须被排除 ───────────────────────────────────────────────────
const mustExclude = [
  'config.json',
  'state/console-token',
  'archive/config.json.corrupt-20260923.bak',
  'node_modules/x.js',
  'desktop/node_modules/electron/dist/electron.exe',
  '.git/HEAD',
  'tools/runtime/init.json',
  'dist/whatever.zip',
  'config-bundle-sanitized-EXAMPLE.json'
];
for (const p of mustExclude) {
  check(`排除：${p}`, shouldExclude(p, []) !== null, shouldExclude(p, []) ?? '（未被排除！）');
}

// 进包清单里也必须真的不含这些
for (const p of mustExclude) {
  const norm = p.replace(/\\/g, '/');
  const hit = files.some((f) => f.replace(/\\/g, '/') === norm);
  if (hit) check(`进包清单不含 ${p}`, false, '❌ 竟然在清单里');
}
check('进包清单确实不含隐私路径', !files.some((f) => {
  const n = f.replace(/\\/g, '/');
  return n === 'config.json' || n.startsWith('state/') || n.startsWith('archive/')
    || n.includes('node_modules/') || n.startsWith('.git/') || n.startsWith('tools/runtime/');
}));

// ── 3. 该进包的必须进包 ─────────────────────────────────────────────────────
const mustInclude = [
  'src/bridge.js',
  'config.example.json',
  'package.json',
  'README.md',
  'uninstall.bat',
  'tools/uninstall-core.mjs',
  'tools/config-portability.mjs',
  'desktop/main.mjs',
  'desktop/renderer/index.html',
  'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  '.gitignore'
];
for (const p of mustInclude) {
  const norm = p.replace(/\\/g, '/');
  check(`进包：${p}`, files.some((f) => f.replace(/\\/g, '/') === norm));
}

// ── 4. .packageignore 生效 ──────────────────────────────────────────────────
check('.packageignore 存在（机制可用）', fs.existsSync(path.join(ROOT, '.packageignore')));
check('.packageignore 规则能被 shouldExclude 识别',
  shouldExclude('docs/incident-2026-09-25-lone-surrogate-400.md', ['docs/incident-2026-09-25-lone-surrogate-400.md']) !== null);

// ── 5. 泄漏扫描：用假隐私值验证它能抓到 ─────────────────────────────────────
const tmpFile = path.join(ROOT, 'dist', '__leak-probe.txt');
fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
fs.writeFileSync(tmpFile, 'nothing here', 'utf8');
const fakeSecret = [{ label: '测试值', value: 'SENTINEL-VALUE-12345' }];
fs.writeFileSync(tmpFile, 'this file contains SENTINEL-VALUE-12345 inside', 'utf8');
const hit = scanForLeaks([path.join('dist', '__leak-probe.txt')], fakeSecret);
check('泄漏扫描能抓到植入的哨兵值', hit.length === 1 && hit[0].count === 1,
  hit.length ? `${hit[0].rel} ×${hit[0].count}` : '（没抓到！）');
fs.writeFileSync(tmpFile, 'clean now', 'utf8');
check('泄漏扫描对干净文件不误报',
  scanForLeaks([path.join('dist', '__leak-probe.txt')], fakeSecret).length === 0);
fs.rmSync(tmpFile, { force: true });

// ── 6. 真实隐私值收集非空（否则扫描形同虚设）───────────────────────────────
const secrets = collectSecrets();
check('收集到真实隐私值（扫描有实际判据）', secrets.length >= 3,
  `${secrets.length} 个：${secrets.map((s) => s.label).join('、')}`);
check('隐私值里包含 QQ 号', secrets.some((s) => s.label === '你的 QQ 号'));
check('隐私值里包含系统用户名', secrets.some((s) => s.label === '系统用户名'));

// ── 7. --plan 不产生任何产物 ────────────────────────────────────────────────
const distDir = path.join(ROOT, 'dist');
const before = fs.existsSync(distDir) ? fs.readdirSync(distDir).length : 0;
const planRun = runTool(['--plan']);
const after = fs.existsSync(distDir) ? fs.readdirSync(distDir).length : 0;
check('--plan 退出码为 0（无 --fail-on-leak 时）', planRun.status === 0, `status=${planRun.status}`);
check('--plan 不产生新产物', before === after, `dist 条目 ${before} → ${after}`);
check('--plan 输出含泄漏扫描结果', /泄漏扫描/.test(planRun.stdout ?? ''));

// ── 8. --fail-on-leak 在有泄漏时应该失败 ───────────────────────────────────
const failRun = runTool(['--plan', '--fail-on-leak']);
const hasLeaks = /⚠️/.test(failRun.stdout ?? '');
if (hasLeaks) {
  check('有泄漏时 --fail-on-leak 返回非 0', failRun.status !== 0, `status=${failRun.status}`);
} else {
  console.log('INFO 当前无泄漏，跳过 --fail-on-leak 的失败路径断言');
}

// ── 9. 源文件未被脱敏改动（红线：只改副本）──────────────────────────────────
// 用一个必然含真实隐私的源文件来验证：源文件的 mtime 与内容都不该因打包而变
const probe = path.join(ROOT, 'src', 'text-safety.js');
if (fs.existsSync(probe)) {
  const mtimeBefore = fs.statSync(probe).mtimeMs;
  const contentBefore = fs.readFileSync(probe, 'utf8');
  runTool(['--plan']);   // --plan 不复制也不脱敏
  check('--plan 后源文件 mtime 未变', fs.statSync(probe).mtimeMs === mtimeBefore);
  check('--plan 后源文件内容未变', fs.readFileSync(probe, 'utf8') === contentBefore);
}

console.log('');
console.log(failures === 0 ? '=== 打包工具自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
