// 卸载执行的**沙箱实跑**验证。
//
// 为什么需要：`execute()` 的删除逻辑在此前从未真跑过 —— 演练测试只覆盖"计划生成"。
// 而它要删 400 MB 依赖与用户数据，第一次就跑真的风险太大。所以这里：
//   ① 造一个**完全隔离的假仓库**（含假的 node_modules / state / config.json / DSH 配置 / 桌面快捷方式）；
//   ② 用环境变量把卸载核心的视线**全部指向沙箱**（DSH_HOME、USERPROFILE）；
//   ③ 真跑 execute()，然后逐项断言"该删的删了、该留的留着"。
//
// 关键：全程不触碰真实仓库、真实 DSH 配置、真实桌面。若任何断言失败，说明 execute()
// 的删除逻辑有 bug —— 那种 bug 在真实环境里是不可逆的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), `qb-uninstall-sandbox-${process.pid}`);
const FAKE_REPO = path.join(SANDBOX, 'repo');
const FAKE_HOME = path.join(SANDBOX, 'home');
const FAKE_DSH = path.join(SANDBOX, 'dshhome');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function mk(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

// ── 1. 搭建沙箱 ─────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });

// 假仓库：依赖（要被删）+ 源码（默认保留）+ 数据（看模式）
mk(path.join(FAKE_REPO, 'node_modules', 'some-pkg', 'index.js'), 'x'.repeat(2000));
mk(path.join(FAKE_REPO, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'), 'y'.repeat(5000));
mk(path.join(FAKE_REPO, 'src', 'bridge.js'), '// bridge');
mk(path.join(FAKE_REPO, 'scripts', 'lib', 'copy-dir.mjs'), '// copy');
mk(path.join(FAKE_REPO, 'tools', 'uninstall-core.mjs'), '// core');
mk(path.join(FAKE_REPO, 'state', 'bridge.log'), 'log');
mk(path.join(FAKE_REPO, 'state', 'social-v2.json'), '{"sessions":{}}');
mk(path.join(FAKE_REPO, 'config.json'), '{"ownerQQ":"123"}');
mk(path.join(FAKE_REPO, '.git', 'HEAD'), 'ref: refs/heads/main');

// 假 DSH 配置：带 BEGIN/END 标记块，块外内容必须保持不动。
// ⚠️ 块内必须写**指向本沙箱的绝对路径**：卸载端有归属检查（只摘除指向自己目录的注入），
//    写相对路径会被正确判为"另一份安装的"而跳过 —— 真实的 cordis.patch.yml 里就是绝对路径。
const patchFile = path.join(FAKE_DSH, 'profiles', 'web', 'cordis.patch.yml');
mk(patchFile, [
  'top-level: keep-me',
  '# === qq-bridge MCP BEGIN ===',
  '- id: mcp-snowluma',
  `  args: ['${path.join(FAKE_REPO, 'src', 'mcp-snowluma-safe.js')}']`,
  '# === qq-bridge MCP END ===',
  'bottom-level: keep-me-too'
].join('\n'));
mk(path.join(FAKE_DSH, 'profiles', 'web', 'node_modules', '@local', 'dsh-qq-preset', 'index.js'), '// preset');

// 假桌面：两个本项目的快捷方式 + 一个无关的（不应被删）。
// 模拟 .lnk 内嵌目标路径，否则 fail-closed 的归属检查会正确地拒绝删除。
mk(path.join(FAKE_HOME, 'Desktop', 'QQ 桥接控制台.lnk'), `lnk:${FAKE_REPO}\\start.bat`);
mk(path.join(FAKE_HOME, 'Desktop', '重启桥接并让画图工具生效.lnk'), `lnk:${FAKE_REPO}\\restart.bat`);
mk(path.join(FAKE_HOME, 'Desktop', 'Steam.lnk'), 'lnk');

check('沙箱已搭建', fs.existsSync(FAKE_REPO) && fs.existsSync(FAKE_DSH) && fs.existsSync(FAKE_HOME));

// ── 2. 在沙箱里跑真实核心 ───────────────────────────────────────────────────
// 🔴 关键：必须用 `--root` 把"要卸载的目标"指向沙箱。
//    早先这里只改了 DSH_HOME / USERPROFILE 就以为隔离好了，而核心的 ROOT 是按脚本位置
//    硬算的 → 测试作用在**真实仓库**上，删掉了用户的 config.json 与 node_modules。
//    （config.json 被 gitignore，无法从版本库恢复 —— 这就是那次事故的代价。）
//
//    因此现在：① 目标根显式注入；② **第一条断言就校验"作用对象确实是沙箱"**，
//    不通过就立即退出，绝不带着失败继续往下跑。
function runCore(args) {
  return spawnSync(process.execPath, [path.join(REPO, 'tools', 'uninstall-core.mjs'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      DSH_HOME: FAKE_DSH,
      USERPROFILE: FAKE_HOME
    }
  });
}

// ── 2a. 守卫：先确认它真的会作用在沙箱上 ────────────────────────────────────
const guardDry = runCore(['--root', FAKE_REPO, '--keep-data']);
const guardOut = (guardDry.stdout ?? '') + (guardDry.stderr ?? '');
const rootLine = (guardOut.match(/仓库:\s*(.+)/) ?? [])[1]?.trim() ?? '';
const realRepo = REPO;
if (path.resolve(rootLine) !== path.resolve(FAKE_REPO)) {
  console.error('');
  console.error('🛑 中止：作用对象不是沙箱！');
  console.error(`   期望: ${FAKE_REPO}`);
  console.error(`   实际: ${rootLine || '(未解析到)'}`);
  console.error('   这条守卫是为了防止再次误删真实仓库。请先修好 --root 传递再跑本测试。');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
if (path.resolve(rootLine) === path.resolve(realRepo)) {
  console.error('🛑 中止：作用对象竟然是真实仓库！');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
check('守卫通过：核心作用在沙箱路径（不是真实仓库）', true, rootLine);

// 顺带确认沙箱里确实有我们造的假依赖（否则后面的"已删除"断言会假通过）
check('沙箱里确实存在待删的假依赖',
  fs.existsSync(path.join(FAKE_REPO, 'node_modules'))
  && fs.existsSync(path.join(FAKE_REPO, 'desktop', 'node_modules')));

// 真跑：keep 模式（保留数据、保留源码）
const run = runCore(['--root', FAKE_REPO, '--keep-data', '--execute', '--elevated-ok']);
const out = (run.stdout ?? '') + (run.stderr ?? '');

// ── 3. 断言：该删的删了 ─────────────────────────────────────────────────────
check('根 node_modules 已删除', !fs.existsSync(path.join(FAKE_REPO, 'node_modules')));
check('desktop/node_modules 已删除', !fs.existsSync(path.join(FAKE_REPO, 'desktop', 'node_modules')));
check('DSH 标记块已摘除', !fs.readFileSync(patchFile, 'utf8').includes('qq-bridge MCP BEGIN'));
check('DSH 配置文件**块外内容完好**',
  fs.readFileSync(patchFile, 'utf8').includes('top-level: keep-me')
  && fs.readFileSync(patchFile, 'utf8').includes('bottom-level: keep-me-too'),
  fs.readFileSync(patchFile, 'utf8').replace(/\n/g, ' | '));
check('DSH 配置改写前有备份', fs.existsSync(`${patchFile}.before-qq-bridge-uninstall`));
check('DSH preset 副本已删除',
  !fs.existsSync(path.join(FAKE_DSH, 'profiles', 'web', 'node_modules', '@local', 'dsh-qq-preset')));
check('桌面快捷方式已删除',
  !fs.existsSync(path.join(FAKE_HOME, 'Desktop', 'QQ 桥接控制台.lnk'))
  && !fs.existsSync(path.join(FAKE_HOME, 'Desktop', '重启桥接并让画图工具生效.lnk')));
check('无关的快捷方式**未被误删**', fs.existsSync(path.join(FAKE_HOME, 'Desktop', 'Steam.lnk')));

// ── 4. 断言：该留的留着 ─────────────────────────────────────────────────────
check('源码保留（src）', fs.existsSync(path.join(FAKE_REPO, 'src', 'bridge.js')));
check('git 目录保留', fs.existsSync(path.join(FAKE_REPO, '.git', 'HEAD')));
check('keep 模式：state 保留', fs.existsSync(path.join(FAKE_REPO, 'state', 'social-v2.json')));
check('keep 模式：config.json 保留', fs.existsSync(path.join(FAKE_REPO, 'config.json')));
check('卸载核心自身仍在（否则无法再运行）', fs.existsSync(path.join(REPO, 'tools', 'uninstall-core.mjs')));

// ── 5. 报告可读性 ───────────────────────────────────────────────────────────
check('执行报告列出了各步骤结果', /✅|⚠️/.test(out) && /完成：\d+\/\d+ 步成功/.test(out),
  (out.match(/完成：\d+\/\d+ 步成功/) ?? ['(未找到完成行)'])[0]);
check('报告提示第三方未被改动', /第三方/.test(out));
check('任一步失败时核心返回非零退出码，避免误报成功', run.status !== 0,
  `status=${run.status}（沙箱故意不提供 launcher）`);

// ── 6. purge 模式：数据应被删除 ─────────────────────────────────────────────
const run2 = runCore(['--root', FAKE_REPO, '--purge-data', '--execute', '--elevated-ok']);
void run2;
check('purge 模式：state 已删除', !fs.existsSync(path.join(FAKE_REPO, 'state')));
check('purge 模式：config.json 已删除', !fs.existsSync(path.join(FAKE_REPO, 'config.json')));
check('purge 模式下源码仍保留（未加 --remove-source）',
  fs.existsSync(path.join(FAKE_REPO, 'src', 'bridge.js')));

// ── 7. archive 模式：应先备份再删 ───────────────────────────────────────────
// 重建数据以便测 archive
mk(path.join(FAKE_REPO, 'state', 'social-v2.json'), '{"archived":true}');
mk(path.join(FAKE_REPO, 'config.json'), '{"keep":"me"}');
const run3 = runCore(['--root', FAKE_REPO, '--archive-data', '--execute', '--elevated-ok']);
void run3;
const archiveRoot = path.join(FAKE_REPO, 'archive');
const archivedDirs = fs.existsSync(archiveRoot)
  ? fs.readdirSync(archiveRoot).filter((n) => n.startsWith('uninstall-'))
  : [];
check('archive 模式：创建了 archive/uninstall-<时间戳>', archivedDirs.length > 0,
  archivedDirs.join(', ') || '(无)');
check('archive 模式：数据已备份（不是直接销毁）',
  archivedDirs.some((d) => fs.existsSync(path.join(archiveRoot, d, 'state', 'social-v2.json'))),
  archivedDirs.map((d) => fs.readdirSync(path.join(archiveRoot, d)).join('+')).join(' / '));
check('archive 模式：确认完整归档后删除原 state', !fs.existsSync(path.join(FAKE_REPO, 'state')));
check('archive 模式：确认完整归档后删除原 config.json', !fs.existsSync(path.join(FAKE_REPO, 'config.json')));

// ── 收尾 ────────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? '=== 卸载执行沙箱实跑通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
