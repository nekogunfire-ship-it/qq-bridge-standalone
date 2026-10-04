// QQ 桥接 —— 卸载核心逻辑。
//
// 设计原则（改动前先读）：
//   1. **默认只盘点与打印计划**，什么都不删。真正执行必须显式加 --execute。
//   2. 纯逻辑（inventory / buildPlan）与副作用（execute）分离，前者可单测，
//      后者只在 --execute 时才被调用 —— 卸载这种东西写错了没有第二次机会。
//   3. 每个删除步骤都做成"可单独失败"的条目：一步失败不影响其余步骤，
//      最后统一报告成功/失败，避免"删到一半停住、状态不明"。
//   4. 绝不碰第三方目录（SnowLuma / ComfyUI / DSH 本体），只在报告里提示。
//
// 用法：
//   node tools/uninstall-core.mjs                       # 只盘点 + 打印计划（默认）
//   node tools/uninstall-core.mjs --keep-data           # 计划里注明保留 state/ 与 config.json
//   node tools/uninstall-core.mjs --archive-data        # 数据备份到 archive/ 后再删
//   node tools/uninstall-core.mjs --purge-data          # 数据彻底删除（不可恢复）
//   node tools/uninstall-core.mjs --remove-source       # 连源码一起删（默认只删依赖与产物）
//   node tools/uninstall-core.mjs --execute             # 真正执行（需管理员）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ⚠️ 不要用 fs.cpSync 复制目录：本机实测会让 Node 进程直接 fast-fail
// （NTSTATUS 0xC0000409，无任何输出、异常都来不及触发）。仓库已有安全实现。
import { copyDirRecursive } from '../scripts/lib/copy-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 🔴 代码所在目录（永远指向本脚本自身的仓库）—— 只用于找"随代码发布的模板"等，
// **绝不**用于决定"要删哪里的东西"。
export const CODE_ROOT = path.resolve(__dirname, '..');

// 要卸载的目标根目录。
//
// ⚠️⚠️ 这里是本文件最危险的一行，改它之前务必读完：
//   早先它是 `path.resolve(__dirname, '..')` —— 按脚本位置硬算。结果我写的"沙箱测试"
//   只改了 DSH_HOME / USERPROFILE 就以为隔离好了，**测试实际作用在真实仓库上**，
//   删掉了用户的 config.json（被 gitignore，无法从版本库恢复）与 node_modules。
//
//   因此现在：目标根**必须可注入**。测试用 `--root <沙箱路径>` 或环境变量 QB_UNINSTALL_ROOT
//   指定，并在第一条断言里校验"作用对象确实是沙箱"，否则立即中止。
//   未指定时默认就是本仓库（正常卸载场景）。
function resolveRoot() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith('--root='));
  if (eq) return path.resolve(eq.slice('--root='.length));
  if (process.env.QB_UNINSTALL_ROOT) return path.resolve(process.env.QB_UNINSTALL_ROOT);
  return CODE_ROOT;
}
export const ROOT = resolveRoot();

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = 'web';

// ── 盘点 ────────────────────────────────────────────────────────────────────
function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; files += 1; } catch {}
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

function sizeOf(target) {
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return dirSize(target);
    return { bytes: st.size, files: 1 };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

function readPatchMarkers() {
  const file = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return { file, found: false };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const begin = lines.findIndex((l) => l.includes('qq-bridge MCP BEGIN'));
  const end = lines.findIndex((l) => l.includes('qq-bridge MCP END'));
  return { file, found: begin >= 0 && end >= 0 && end > begin, begin: begin + 1, end: end + 1, totalLines: lines.length };
}

/** 盘点这台机器上与本项目有关的一切。只读，无副作用。 */
export function inventory() {
  const items = {
    repo: ROOT,
    nodeModules: [
      { label: '根目录依赖 node_modules', path: path.join(ROOT, 'node_modules') },
      { label: '桌面版 Electron 依赖 desktop/node_modules', path: path.join(ROOT, 'desktop', 'node_modules') }
    ].map((x) => ({ ...x, exists: fs.existsSync(x.path), ...sizeOf(x.path) })),

    userData: [
      { label: '运行时数据 state/', path: path.join(ROOT, 'state') },
      { label: '配置 config.json', path: path.join(ROOT, 'config.json') }
    ].map((x) => ({ ...x, exists: fs.existsSync(x.path), ...sizeOf(x.path) })),

    // 源码与文档：默认保留（除非 --remove-source）
    source: ['src', 'scripts', 'tools', 'public', 'dsh', 'roles', 'docs', 'archive']
      .map((d) => ({ label: d, path: path.join(ROOT, d), exists: fs.existsSync(path.join(ROOT, d)), ...sizeOf(path.join(ROOT, d)) })),

    dsh: {
      patch: readPatchMarkers(),
      presetDir: path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@local', 'dsh-qq-preset')
    },
    shortcuts: [],
    // 两个都是本项目的组件（已核实）：
    //   · DSH Watchdog   —— 描述「Keep the DSH web child alive and auto-sync the QQ bridge endpoint」
    //   · Bridge Watchdog —— 桥接看门狗（state/slang-agent/bridge-watchdog.ps1）的登录自启任务
    tasks: ['DSH Watchdog', 'Bridge Watchdog', 'qq-bridge-lanuch-once'],
    thirdParty: [
      { label: 'SnowLuma（QQ 网关）', path: 'C:\\SnowLuma' },
      { label: 'ComfyUI（出图引擎）', path: 'E:\\comfyui' },
      { label: 'DSH（AI 宿主）', path: 'D:\\DSH' }
    ].map((x) => ({ ...x, exists: fs.existsSync(x.path) }))
  };

  items.dsh.presetExists = fs.existsSync(items.dsh.presetDir);

  // 桌面快捷方式：扫桌面目录里指向本仓库的 .lnk（避免靠名字猜）
  // 优先用 USERPROFILE 环境变量而不是 os.homedir() —— 这样**测试可以把整个盘查范围
  // 指到一个沙箱目录**（否则沙箱测试会去动真实桌面上的快捷方式）。
  //
  // ⚠️ 但 Windows 上 `USERPROFILE` **永远有值**，所以"没显式覆盖"的调用照样扫真实桌面。
  //    ⇒ 光靠环境变量不够，**每个候选都要核实目标**（`lnkPointsInto`）。
  //    2026-09-26 的事故就是只做了文件名粗筛、执行时也没核实，删掉了用户的快捷方式。
  const home = process.env.USERPROFILE || os.homedir();
  const desktopDirs = [path.join(home, 'Desktop'), path.join(home, '桌面')];
  items.shortcutOwners = {};
  for (const dir of desktopDirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lnk')); } catch { continue; }
    for (const name of names) {
      // 文件名粗筛只是为了少做几次读文件；**去留由 `lnkPointsInto` 决定**
      if (!/QQ|桥接|qq-bridge/i.test(name)) continue;
      const full = path.join(dir, name);
      items.shortcuts.push(full);
      // 'mine' = 指向本 ROOT（可以删）/ 'other' = 指向别处（必须跳过）
      items.shortcutOwners[full] = lnkPointsInto(full) ? 'mine' : 'other';
    }
  }

  return items;
}

// ── 计划 ────────────────────────────────────────────────────────────────────
/**
 * 依据盘点结果与选项生成卸载计划。纯函数（可单测）。
 * dataMode: 'keep' | 'archive' | 'purge'
 */
export function buildPlan(inv, { dataMode = 'keep', removeSource = false } = {}) {
  const steps = [];
  const push = (title, detail, kind = 'remove', bytes = 0) => steps.push({ title, detail, kind, bytes });

  push('停止服务', '桥接（3100）与 SnowLuma（3000/3001）：必须先停，否则 node_modules 被占用无法删除', 'action');
  push('摘除 DSH MCP 注入', inv.dsh.patch.found
    ? `删除 ${inv.dsh.patch.file} 第 ${inv.dsh.patch.begin}~${inv.dsh.patch.end} 行（BEGIN/END 标记块）`
    : '未找到标记块（跳过）', inv.dsh.patch.found ? 'remove' : 'skip');
  push('删除 DSH preset 副本', inv.dsh.presetExists ? inv.dsh.presetDir : '不存在（跳过）',
    inv.dsh.presetExists ? 'remove' : 'skip');
  // 快捷方式：**分开列"会删"和"会跳过"** —— 与计划任务同一套标准。
  // 计划是用户在按确认前唯一能看到的东西，它必须与执行结果一致
  //（否则"计划说会删、执行却跳过"或更糟的"计划没说、执行删了"都是欺骗）。
  const mineShortcuts = inv.shortcuts.filter((s) => (inv.shortcutOwners?.[s] ?? 'mine') === 'mine');
  const foreignShortcuts = inv.shortcuts.filter((s) => inv.shortcutOwners?.[s] === 'other');
  push('删除桌面快捷方式', mineShortcuts.length
    ? mineShortcuts.map((s) => path.basename(s)).join('、')
    : '未发现指向本目录的（跳过）', mineShortcuts.length ? 'remove' : 'skip');
  if (foreignShortcuts.length) {
    push('跳过他人的桌面快捷方式', foreignShortcuts.map((s) => path.basename(s)).join('、')
      + '（不指向本目录，属于别的安装或别家的程序）', 'skip');
  }
  // 计划任务的归属：只删"指向本目录"的那些。
  // 它们是按用户全局注册的，机器上有两份安装时无脑删会破坏另一份。
  // 在**计划阶段**就查出来，好让用户在按下确认前看到"哪些会被跳过"。
  const taskStates = inv.tasks.map((name) => ({ name, owner: taskOwner(name) }));
  const myTasks = taskStates.filter((t) => t.owner === 'mine');
  const foreignTasks = taskStates.filter((t) => t.owner === 'other');
  const unknownTasks = taskStates.filter((t) => t.owner === 'unknown');
  if (myTasks.length) {
    push('删除计划任务', `删除：${myTasks.map((t) => t.name).join('、')}`, 'remove');
  }
  if (foreignTasks.length) {
    push('跳过他人的计划任务',
      `${foreignTasks.map((t) => t.name).join('、')}：指向另一份安装，不属于本次卸载目标（不动）`,
      'keep');
  }
  if (unknownTasks.length) {
    push('跳过归属不明的计划任务',
      `${unknownTasks.map((t) => t.name).join('、')}：无法确认动作路径，为避免误删而不动`,
      'skip');
  }

  for (const nm of inv.nodeModules) {
    push(`删除${nm.label}`, nm.exists ? `${Math.round(nm.bytes / 1024 / 1024)} MB / ${nm.files} 个文件` : '不存在（跳过）',
      nm.exists ? 'remove' : 'skip', nm.bytes);
  }

  // 数据：三选一
  const dataPaths = inv.userData.filter((d) => d.exists).map((d) => d.path);
  const dataBytes = inv.userData.reduce((a, b) => a + b.bytes, 0);
  if (dataMode === 'keep') {
    push('保留用户数据', `保留 ${dataPaths.length} 项（state/ 与 config.json）—— 以后重装可续用`, 'keep', 0);
  } else if (dataMode === 'archive') {
    push('归档用户数据', `先备份到 archive/uninstall-<时间戳>/ 再删除（${Math.round(dataBytes / 1024 / 1024)} MB）`, 'archive', dataBytes);
  } else {
    push('彻底删除用户数据', `直接删除 ${dataPaths.length} 项（对话历史、黑话库、表情等不可恢复）`, 'remove', dataBytes);
  }

  if (removeSource) {
    const srcBytes = inv.source.reduce((a, b) => a + b.bytes, 0);
    push('删除源码目录', 'src / scripts / tools / public / dsh / roles / archive（git 历史一并丢失）', 'remove', srcBytes);
  } else {
    push('保留源码', '保留 src / scripts / tools / public / dsh / roles 与 .git —— 想彻底删除请用 --remove-source', 'keep');
  }

  push('注册表卸载项', '从「设置 → 应用」列表移除本程序条目', 'remove');
  push('第三方依赖（不动）', inv.thirdParty.filter((t) => t.exists).map((t) => t.label).join('、') || '无', 'keep');

  // 归档副本仍留在同一磁盘，不能算作释放空间。
  const freeingBytes = steps.filter((s) => s.kind === 'remove').reduce((a, b) => a + b.bytes, 0);
  return { steps, dataMode, removeSource, freeingBytes };
}

export function formatPlan(plan) {
  const lines = [];
  const mark = { remove: '删', archive: '归档', keep: '留', skip: '跳过', action: '执行' };
  lines.push(`卸载计划（数据模式：${{ keep: '保留', archive: '归档后删除', purge: '彻底删除' }[plan.dataMode]}，源码：${plan.removeSource ? '一并删除' : '保留'}）`);
  lines.push('');
  plan.steps.forEach((s, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. [${mark[s.kind] ?? s.kind}] ${s.title}`);
    if (s.detail) lines.push(`      ${s.detail}`);
  });
  lines.push('');
  lines.push(`  预计释放空间：${Math.round(plan.freeingBytes / 1024 / 1024)} MB`);
  return lines.join('\n');
}

// ── 执行（仅在 --execute 时调用）─────────────────────────────────────────────
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * 跑外部命令并**正确解码输出**。
 *
 * 坑（踩过两次）：`reg query` 与 `schtasks /Query /XML` 都按**控制台代码页**（本机 cp936/GBK）
 * 输出，Node 按 UTF-8 读会把中文变成 U+FFFD。本机路径含中文（`默认工作区`），
 * 于是"拿输出里的路径去和 ROOT 比对"必然失败 —— 表现为任务归属判断整个反过来。
 * 所以：有 UTF-16LE BOM 就按 UTF-16LE 解，否则按 GBK 解（Node 自带 full ICU）。
 */
function runDecoded(cmd, args, { shell = false } = {}) {
  const r = spawnSync(cmd, args, { windowsHide: true, shell });
  const buf = r.stdout ?? Buffer.alloc(0);
  if (!buf.length) return { ok: r.status === 0, out: '' };
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
  } else {
    try { text = new TextDecoder('gbk', { fatal: false }).decode(buf); }
    catch { text = buf.toString('utf8'); }
  }
  return { ok: r.status === 0, out: text };
}

/**
 * 判断一个计划任务是否属于**本次要卸载的这个目录**。
 *
 * 为什么需要：计划任务是按用户（而非按安装目录）全局注册的。如果机器上有两份安装
 * （例如把发布包解压到别处试跑），无脑删任务会把另一份安装的守护搞坏。
 *
 * 返回：'mine'（动作路径指向本 ROOT）/ 'other'（指向别处）/ 'missing'（确实不存在）/ 'unknown'
 */
/**
 * 快捷方式的**归属检查**：这个 .lnk 是不是指向本 ROOT？
 *
 * 🔴 为什么必须加（2026-09-26 真实事故）：
 *   `inventory()` 扫桌面时**只按文件名**粗筛（`/QQ|桥接|qq-bridge/i`），
 *   注释里写着"执行阶段再逐个核实目标" —— **但 `execute()` 从来没核实过**，
 *   直接 `fs.rmSync(lnk)`。
 *   而 `home = process.env.USERPROFILE || os.homedir()`，Windows 上 `USERPROFILE`
 *   **永远有值** → 任何**没显式覆盖 USERPROFILE** 的调用（比如某个沙箱测试）
 *   都会扫到**真实桌面**，把用户的 `QQ 桥接控制台.lnk` 删掉 —— 而注册表项因为有
 *   `InstallLocation` 归属检查所以活了下来，于是症状是"快捷方式没了、卸载项还在"。
 *   我一天跑了十几次全套测试 → 第一次就删了，之后每次都"没东西可删"，全程静默。
 *
 * 做法：在 .lnk 的**原始字节**里找本 ROOT 的路径。.lnk 会把目标路径与参数
 * 都存进去（既有 ANSI 也有 UTF-16LE），所以"找得到 ROOT 路径"就说明它指向我们。
 * **fail-closed**：找不到就当作"不是我们的"，**不删**。
 * （不用起 PowerShell 解析目标 —— 省一次进程开销，也避免提权/编码那些坑。）
 */
function lnkPointsInto(lnkPath, root = ROOT) {
  let buf;
  try { buf = fs.readFileSync(lnkPath); } catch { return false; }
  const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase();
  const needle = norm(root);
  const utf16 = Buffer.from(needle, 'utf16le');
  const utf8 = Buffer.from(needle, 'utf8');
  // .lnk 里路径大小写与分隔符可能被规范化过，所以两种编码都按小写找
  return buf.includes(utf16) || buf.includes(utf8)
    || buf.toString('utf16le').toLowerCase().includes(needle)
    || buf.toString('latin1').toLowerCase().includes(needle);
}

function taskOwner(taskName) {
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const rootNorm = norm(ROOT);

  // 先用 schtasks（需要权限：任务若由提权创建，非提权上下文会查不到）
  const q = runDecoded('schtasks.exe', ['/Query', '/TN', taskName, '/XML']);
  const extract = (text) =>
    [...text.matchAll(/<(?:Command|Arguments)>([^<]*)<\/(?:Command|Arguments)>/g)].map((m) => m[1]);

  if (q.ok) {
    const cmds = extract(q.out);
    if (!cmds.length) return 'unknown';
    return cmds.some((c) => norm(c).includes(rootNorm)) ? 'mine' : 'other';
  }

  // 兜底：用 PowerShell 的对象模型查（查看任务通常不需要提权）
  const ps = runDecoded('powershell.exe', [
    '-NoProfile', '-Command',
    `$t = Get-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; ` +
    `if (-not $t) { 'NOTASK' } else { ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join "\`n" }`
  ]);
  if (!ps.ok) return 'unknown';
  const out = ps.out.trim();
  if (!out || out === 'NOTASK') return 'missing';
  return out.split('\n').some((l) => norm(l).includes(rootNorm)) ? 'mine' : 'other';
}

export function execute(plan, inv, log = console.log) {
  const results = [];

  // 1) 停止服务：复用权威启动器（它知道怎么优雅停）
  const launcher = path.join(ROOT, 'tools', 'qq-bridge-launcher.ps1');
  if (fs.existsSync(launcher)) {
    const r = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Action', 'stopAll']);
    results.push({ step: '停止服务', ok: r.ok, detail: r.ok ? '已停止' : r.out.slice(0, 200) });
  } else {
    results.push({ step: '停止服务', ok: false, detail: 'launcher 不存在，跳过（请手动停止桥接）' });
  }

  // 2) 摘除 DSH MCP 注入
  //    patchRemoved 记下"注入确实是我们的、且已摘除" —— 后面删 preset 副本要以它为前提，
  //    因为 preset 是**全局共享**资源：另有一份安装还在用它时不能删。
  let patchRemoved = false;
  let patchOwnedByOther = false;
  if (inv.dsh.patch.found) {
    try {
      const text = fs.readFileSync(inv.dsh.patch.file, 'utf8');
      const lines = text.split(/\r?\n/);
      const begin = lines.findIndex((l) => l.includes('qq-bridge MCP BEGIN'));
      const end = lines.findIndex((l) => l.includes('qq-bridge MCP END'));
      const block = lines.slice(begin, end + 1).join('\n');
      // 归属检查：DSH 的注入是按用户全局配的（profiles/web/cordis.patch.yml）。
      // 机器上若有两份安装，摘除会破坏另一份。只有当这个块指向**本 ROOT** 时才摘。
      const normRoot = ROOT.replace(/\\/g, '/').toLowerCase();
      if (!block.replace(/\\/g, '/').toLowerCase().includes(normRoot)) {
        patchOwnedByOther = true;
        results.push({
          step: '跳过摘除 DSH MCP 注入',
          ok: true,
          detail: '该注入指向另一份安装的路径，不属于本次卸载目标'
        });
      } else {
        const kept = [...lines.slice(0, begin), ...lines.slice(end + 1)];
        // 先备份再改写：DSH 配置写坏了会影响用户的 AI 宿主
        fs.copyFileSync(inv.dsh.patch.file, `${inv.dsh.patch.file}.before-qq-bridge-uninstall`);
        fs.writeFileSync(inv.dsh.patch.file, kept.join('\n'), 'utf8');
        patchRemoved = true;
        results.push({ step: '摘除 DSH MCP 注入', ok: true, detail: `已删除第 ${begin + 1}~${end + 1} 行（原文件已备份）` });
      }
    } catch (e) {
      results.push({ step: '摘除 DSH MCP 注入', ok: false, detail: String(e?.message ?? e) });
    }
  }

  // 3) 删除 preset 副本 —— 只在"本安装的注入刚刚成功摘除"时才删。
  // preset 位于 %DSH_HOME%/profiles/web/node_modules/@local/dsh-qq-preset，是**全局共享**的：
  // 若另一份安装仍挂着它的注入，删掉就会让那份安装的 DSH 侧失效。
  if (inv.dsh.presetExists) {
    if (!patchRemoved) {
      results.push({
        step: '跳过删除 DSH preset',
        ok: true,
        detail: patchOwnedByOther
          ? 'DSH 注入属于另一份安装，它可能还在用这个 preset（不动）'
          : '未确认并摘除本安装的 DSH 注入，无法证明 preset 归属（不动）'
      });
    } else {
      try { fs.rmSync(inv.dsh.presetDir, { recursive: true, force: true }); results.push({ step: '删除 DSH preset', ok: true }); }
      catch (e) { results.push({ step: '删除 DSH preset', ok: false, detail: String(e?.message ?? e) }); }
    }
  }
  // 4) 快捷方式 —— **必须核实目标指向本 ROOT 才删**
  //    （`inventory` 只是按文件名粗筛；不核实就会误删用户桌面上同名的别家快捷方式，
  //      2026-09-26 真的把用户自己的 `QQ 桥接控制台.lnk` 删掉过一次）
  for (const lnk of inv.shortcuts) {
    if (!lnkPointsInto(lnk)) {
      results.push({
        step: `跳过快捷方式 ${path.basename(lnk)}`,
        ok: true,
        detail: '它不指向本目录（属于别的安装或别家的程序），未删除'
      });
      continue;
    }
    try { fs.rmSync(lnk, { force: true }); results.push({ step: `删除快捷方式 ${path.basename(lnk)}`, ok: true }); }
    catch (e) { results.push({ step: `删除快捷方式 ${path.basename(lnk)}`, ok: false, detail: String(e?.message ?? e) }); }
  }

  // 5) 计划任务 —— **只删属于本次要卸目录的那些**
  //
  // 计划任务是按用户全局注册的，不是按安装目录。如果机器上有两份安装（比如用户把包解压
  // 到别处试跑），无脑删任务会把**另一份安装**的守护搞坏。所以先问出任务的动作路径，
  // 只有确实指向本 ROOT 的才删，否则跳过并说明。
  for (const task of inv.tasks) {
    const owner = taskOwner(task);
    if (owner !== 'mine') {
      const detail = owner === 'other'
        ? '它指向另一份安装，不属于本次卸载目标'
        : owner === 'missing'
          ? '不存在，无需删除'
          : '无法确认动作路径，为避免误删而不动';
      results.push({ step: `${owner === 'missing' ? '' : '跳过'}计划任务 ${task}`, ok: true, detail });
      continue;
    }
    const r = run('schtasks.exe', ['/Delete', '/TN', task, '/F']);
    results.push({
      step: `删除计划任务 ${task}`,
      ok: r.ok,
      detail: r.ok ? undefined : r.out.slice(0, 120)
    });
  }

  // 6) 数据（按模式）
  if (plan.dataMode === 'archive') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(ROOT, 'archive', `uninstall-${stamp}`);
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const d of inv.userData.filter((x) => x.exists)) {
        const target = path.join(dest, path.basename(d.path));
        if (fs.statSync(d.path).isDirectory()) copyDirRecursive(d.path, target);
        else fs.copyFileSync(d.path, target);
      }
      // 所有项目都成功复制后才删除原数据，避免半份归档导致数据丢失。
      for (const d of inv.userData.filter((x) => x.exists)) {
        fs.rmSync(d.path, { recursive: true, force: true });
      }
      results.push({ step: '归档用户数据', ok: true, detail: `已归档到 ${dest}，原数据已删除` });
    } catch (e) {
      results.push({ step: '归档用户数据', ok: false, detail: `归档失败，已中止删除数据：${e?.message ?? e}` });
    }
  }
  if (plan.dataMode === 'purge') {
    for (const d of inv.userData.filter((x) => x.exists)) {
      try { fs.rmSync(d.path, { recursive: true, force: true }); results.push({ step: `删除 ${path.basename(d.path)}`, ok: true }); }
      catch (e) { results.push({ step: `删除 ${path.basename(d.path)}`, ok: false, detail: String(e?.message ?? e) }); }
    }
  }

  // 7) 依赖与（可选）源码 —— 放最后，因为删完就没法回头跑了
  for (const nm of inv.nodeModules) {
    if (!nm.exists) continue;
    try { fs.rmSync(nm.path, { recursive: true, force: true }); results.push({ step: `删除 ${path.basename(path.dirname(nm.path))}/node_modules`, ok: true }); }
    catch (e) { results.push({ step: `删除 ${nm.label}`, ok: false, detail: String(e?.message ?? e) }); }
  }
  if (plan.removeSource) {
    for (const s of inv.source) {
      if (!s.exists) continue;
      try { fs.rmSync(s.path, { recursive: true, force: true }); results.push({ step: `删除 ${s.label}/`, ok: true }); }
      catch (e) { results.push({ step: `删除 ${s.label}/`, ok: false, detail: String(e?.message ?? e) }); }
    }
  }

  // 8) 注册表卸载项 —— 同样只删"指向本目录"的那个
  // HKCU 下这个键是按用户唯一的（一份机器只能登记一个安装）。若它指向别的安装目录，
  // 删掉会让那份安装从「设置 → 应用」里消失，所以先核对 InstallLocation。
  const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop';
  const q = run('reg.exe', ['query', REG_KEY, '/v', 'InstallLocation']);
  if (!q.ok) {
    results.push({ step: '注册表卸载项', ok: true, detail: '不存在，无需移除' });
  } else {
    // 输出形如：  InstallLocation    REG_SZ    C:\path\to\qq-bridge
    // ⚠️ 不能用 /(.*)$/ —— JS 的 `.` 不匹配 \r，而 reg 输出是 CRLF（这个坑踩过）
    const m = q.out.split(/\r?\n/).map((l) => l.match(/InstallLocation\s+REG_\w+\s+(.*?)\s*$/)).find(Boolean);
    const declared = m ? m[1].replace(/\\/g, '/').toLowerCase() : '';
    const mine = ROOT.replace(/\\/g, '/').toLowerCase();
    if (declared && declared !== mine) {
      results.push({
        step: '跳过移除注册表卸载项',
        ok: true,
        detail: `它登记的是另一份安装（${m[1]}），不属于本次卸载目标`
      });
    } else {
      const r = run('reg.exe', ['delete', REG_KEY, '/f']);
      results.push({ step: '移除注册表卸载项', ok: r.ok, detail: r.ok ? undefined : '不存在或已移除' });
    }
  }

  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isAdmin() {
  const r = spawnSync('net.exe', ['session'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const dataMode = argv.includes('--purge-data') ? 'purge'
    : argv.includes('--archive-data') ? 'archive'
      : 'keep';
  const removeSource = argv.includes('--remove-source');
  const doExecute = argv.includes('--execute');

  const inv = inventory();
  const plan = buildPlan(inv, { dataMode, removeSource });

  // --json：给 UI 用的机器可读输出（桌面版设置页的「卸载」按钮靠它渲染计划）。
  // 只在演练模式下输出 JSON，避免和 --execute 的进度日志混在一起。
  if (argv.includes('--json')) {
    const payload = {
      repo: inv.repo,
      dataMode,
      removeSource,
      freeingBytes: plan.freeingBytes,
      steps: plan.steps,
      summary: {
        nodeModules: inv.nodeModules.filter((x) => x.exists)
          .map((x) => ({ label: x.label, mb: Math.round(x.bytes / 1048576) })),
        userData: inv.userData.filter((x) => x.exists)
          .map((x) => ({ label: x.label, mb: Math.round(x.bytes / 1048576) })),
        dshPatch: inv.dsh.patch.found ? { file: inv.dsh.patch.file, begin: inv.dsh.patch.begin, end: inv.dsh.patch.end } : null,
        presetExists: inv.dsh.presetExists,
        shortcuts: inv.shortcuts,
        tasks: inv.tasks,
        thirdParty: inv.thirdParty.filter((t) => t.exists).map((t) => t.label)
      }
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }

  console.log('=== QQ 桥接 · 卸载盘点 ===');
  console.log(`  仓库: ${inv.repo}`);
  console.log(`  依赖: ${inv.nodeModules.filter((x) => x.exists).map((x) => `${Math.round(x.bytes / 1048576)}MB`).join(' + ') || '（无）'}`);
  console.log(`  数据: ${inv.userData.filter((x) => x.exists).map((x) => x.label).join('、') || '（无）'}`);
  console.log(`  DSH 注入: ${inv.dsh.patch.found ? `第 ${inv.dsh.patch.begin}~${inv.dsh.patch.end} 行` : '未找到'}`);
  console.log('');
  console.log(formatPlan(plan));
  console.log('');

  if (!doExecute) {
    console.log('以上为**演练**（默认不删除任何东西）。');
    console.log('确认无误后加 --execute 真正执行；卸载需要管理员权限。');
    return 0;
  }
  // --elevated-ok：交互式流程（uninstall.bat）会**先提权再询问并调用本脚本**，
  // 那时 net session 可能仍被拒（受限环境），但进程本身已是管理员。
  // 该标志表示"调用方已确认自身处于提权上下文"，跳过这里的二次检查，
  // 好处是整条交互流程只弹一次 UAC。
  const elevatedOk = argv.includes('--elevated-ok');
  if (!elevatedOk && !isAdmin()) {
    console.error('❌ 卸载需要管理员权限（要停服务、删 node_modules、删计划任务）。请用管理员身份重新运行。');
    return 2;
  }
  if (elevatedOk && !isAdmin()) {
    console.log('提示：未能确认管理员状态（net session 被拒），按调用方声明以提权上下文继续。');
  }

  console.log('=== 开始执行 ===');
  const results = execute(plan, inv);
  const okCount = results.filter((r) => r.ok).length;
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '⚠️ '} ${r.step}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('');
  console.log(`完成：${okCount}/${results.length} 步成功。`);
  console.log('第三方（SnowLuma / ComfyUI / DSH）未做改动，如需清理请自行处理。');
  if (!removeSource) console.log(`源码与 git 历史保留在 ${ROOT}（想一并删除请用 --remove-source）。`);
  return results.every((r) => r.ok) ? 0 : 1;
}

// 仅在直接执行时跑 CLI（被 import 时只导出函数）
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) process.exit(main());
