// 打包分发：把 qq-bridge 打成可分发的免安装 zip。
//
// 设计取向：**白名单**（明确列出进包的东西），而不是黑名单（排除法）。
// 理由：仓库里有 config.json / state/ / archive/ 这些**删了不可恢复且含隐私**的东西，
// 黑名单一旦漏写一条就会把隐私打进发布包。白名单漏写只会少东西，代价小得多。
//
// 三层防线：
//   ① 白名单：只复制明确列出的路径；
//   ② 排除规则：白名单内部再剔掉 node_modules、*.log、*.bak 等；
//   ③ **泄漏扫描**：对将要进包的每个文本文件搜真实隐私值（QQ 号/群号/令牌/用户名/主机名），
//      命中就列出并允许 `--fail-on-leak` 直接失败。这是最后一道闸。
//
// 用法：
//   node tools/package-dist.mjs --plan              # 只列出会打包什么（不复制任何东西）
//   node tools/package-dist.mjs                     # 打包到 dist/ 并生成 zip
//   node tools/package-dist.mjs --no-zip            # 只生成目录，不打 zip
//   node tools/package-dist.mjs --fail-on-leak      # 发现泄漏即失败（给 CI/自动化用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── ① 白名单：这些路径才会进包 ──────────────────────────────────────────────
const INCLUDE = [
  'src', 'scripts', 'tools', 'public', 'dsh', 'plugins', 'roles', 'assets', 'docs',
  'desktop',
  'config.example.json',
  'package.json', 'package-lock.json', '.gitignore', '.npmrc', '.packageignore',
  'README.md', 'README.en.md', 'RULES.md',
  'start.bat', 'restart.bat', 'install.bat', 'uninstall.bat', 'uninstall-quiet.bat'
];

// ── ② 排除规则：白名单内部再剔掉这些 ────────────────────────────────────────
// 相对仓库根的路径片段（小写比较）
const EXCLUDE_SEGMENTS = [
  'node_modules',
  'state',            // 运行时数据（聊天记录、令牌）
  'archive',          // 归档里含配置备份，是隐私
  '.git',
  '__pycache__'
];
// 整条相对路径前缀（比片段匹配更精确的场景）
const EXCLUDE_PREFIXES = [
  'tools/runtime',    // launcher 结果 JSON / pid / 日志：运行时产物，且含绝对路径与用户名
  'tools\\runtime',
  'dist'
];
const EXCLUDE_FILE_PATTERNS = [
  /\.log$/i,          // 日志
  /\.bak$/i, /\.bak-/i, // 备份
  /^config\.json$/i,  // 真配置（只发模板）
  /^config-bundle-.*\.json$/i,
  /\.tsbuildinfo$/i,
  /^Thumbs\.db$/i,
  /\.tmp$/i
];

// 用户可控的额外排除清单：仓库根的 .packageignore（一行一条，支持 # 注释）
// 让用户能自己把"不想外发的东西"挡在包外，而不用改这个脚本。
function readPackageIgnore() {
  const file = path.join(ROOT, '.packageignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^[./\\]+/, '').replace(/[\\/]+$/, ''));
}

// ── ③ 泄漏扫描：要搜的真实隐私值 ────────────────────────────────────────────
// 从本地真实文件里现取，而不是写死 —— 这样换了 QQ 号/端口后扫描依然有效。
function collectSecrets() {
  const secrets = [];
  const add = (label, value) => {
    const v = String(value ?? '').trim();
    if (v.length >= 5) secrets.push({ label, value: v });
  };

  // config.json 里的隐私字段
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    add('你的 QQ 号', cfg.ownerQQ);
    for (const g of cfg.allow?.groups ?? []) add('群白名单', g);
    for (const p of cfg.allow?.private ?? []) add('私聊白名单', p);
    for (const g of cfg.deny?.groups ?? []) add('群黑名单', g);
    add('DSH 令牌', cfg.dsh?.authToken);
    add('控制台令牌(config)', cfg.consoleToken);
  } catch { /* config.json 不在就算了 */ }

  // state/console-token
  try { add('控制台令牌(state)', fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8')); } catch {}

  // 当前用户名 / 主机名（绝对路径里常带）
  // 某些受限/低内存环境里 uv_os_get_passwd 会抛错；扫描不能因此整体中断。
  try {
    add('系统用户名', os.userInfo().username);
  } catch {
    add('系统用户名', process.env.USERNAME ?? process.env.USER);
  }
  try { add('主机名', os.hostname()); } catch {
    add('主机名', process.env.COMPUTERNAME ?? process.env.HOSTNAME);
  }
  // DSH 端点的端口（换机即变，不算隐私但值得提醒）
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const m = String(cfg.dsh?.baseUrl ?? '').match(/127\.0\.0\.1:(\d+)/);
    if (m) add('DSH 端口', m[1]);
  } catch {}

  // 去重 & 去掉太通用的（避免误报淹没真问题）
  const seen = new Set();
  return secrets.filter((s) => {
    const key = `${s.label}|${s.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // 纯数字且很短（如端口 3100、年龄等）容易误报，单独标注
    return true;
  });
}

const TEXT_EXT = /\.(mjs|js|cjs|ts|json|json5|md|txt|yml|yaml|html|css|bat|cmd|ps1|psm1|sh|xml|toml|ini|cfg|env)$/i;
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // 单文件最多扫 2 MB

function shouldExclude(relPath, ignoreList = []) {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const parts = norm.split('/');
  if (parts.some((p) => EXCLUDE_SEGMENTS.includes(p))) return '路径含排除段';
  for (const prefix of EXCLUDE_PREFIXES) {
    const p = prefix.replace(/\\/g, '/').toLowerCase();
    if (norm === p || norm.startsWith(`${p}/`)) return '排除路径前缀';
  }
  for (const ig of ignoreList) {
    const p = ig.replace(/\\/g, '/').toLowerCase();
    if (norm === p || norm.startsWith(`${p}/`)) return '.packageignore';
  }
  const base = parts[parts.length - 1] ?? '';
  for (const re of EXCLUDE_FILE_PATTERNS) {
    if (re.test(base)) return `文件名匹配 ${re}`;
  }
  return null;
}

/** 递归收集白名单内的文件（相对路径） */
function collectFiles() {
  const files = [];
  const skipped = [];
  const ignoreList = readPackageIgnore();

  const walk = (absDir, relDir) => {
    let entries = [];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? path.join(relDir, e.name) : e.name;
      const why = shouldExclude(rel, ignoreList);
      if (why) { skipped.push({ rel, why }); continue; }
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) files.push(rel);
    }
  };

  for (const item of INCLUDE) {
    const abs = path.join(ROOT, item);
    if (!fs.existsSync(abs)) { skipped.push({ rel: item, why: '不存在（跳过）' }); continue; }
    const why = shouldExclude(item, ignoreList);
    if (why) { skipped.push({ rel: item, why }); continue; }
    if (fs.statSync(abs).isDirectory()) walk(abs, item);
    else files.push(item);
  }
  return { files: files.sort(), skipped, ignoreList };
}

// 脱敏占位符：按隐私类型给可读的占位，让人知道这里该填什么
const PLACEHOLDER = {
  '你的 QQ 号': '<你的QQ号>',
  '群白名单': '<群号>',
  '私聊白名单': '<QQ号>',
  '群黑名单': '<群号>',
  'DSH 令牌': '<DSH令牌>',
  '控制台令牌(config)': '<控制台令牌>',
  '控制台令牌(state)': '<控制台令牌>',
  '系统用户名': '<用户名>',
  '主机名': '<主机名>',
  'DSH 端口': '<端口>'
};

/**
 * 对**已复制到 staging 的副本**做脱敏（源文件永不改动）。
 * 返回处理明细，供报告展示。
 */
function redactStaging(staging, hits) {
  const done = [];
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.rel)) byFile.set(h.rel, []);
    byFile.get(h.rel).push(h);
  }
  for (const [rel, list] of byFile) {
    const abs = path.join(staging, rel);
    if (!fs.existsSync(abs)) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const h of list) {
      const ph = PLACEHOLDER[h.label] ?? '<已脱敏>';
      const n = text.split(h.value).length - 1;
      if (!n) continue;
      text = text.split(h.value).join(ph);
      done.push({ rel, label: h.label, replaced: n, placeholder: ph });
    }
    try { fs.writeFileSync(abs, text, 'utf8'); } catch {}
  }
  return done;
}

/** 对指定文件集合做泄漏扫描（fileList 为空则扫描整个仓库白名单） */
function scanForLeaks(files, secrets) {
  const hits = [];
  for (const rel of files) {
    if (!TEXT_EXT.test(rel)) continue;
    const abs = path.join(ROOT, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_SCAN_BYTES) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const s of secrets) {
      if (!text.includes(s.value)) continue;
      // 统计出现次数，便于判断是真泄漏还是巧合
      const count = text.split(s.value).length - 1;
      hits.push({ rel, label: s.label, value: s.value, count });
    }
  }
  return hits;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function main() {
  const argv = process.argv.slice(2);
  const planOnly = argv.includes('--plan');
  const noZip = argv.includes('--no-zip');
  const failOnLeak = argv.includes('--fail-on-leak');
  const allowPersonal = argv.includes('--allow-personal');
  const redact = argv.includes('--redact');

  const { files, skipped, ignoreList } = collectFiles();
  const secrets = collectSecrets();

  console.log('=== QQ 桥接 · 打包盘点 ===');
  console.log(`  仓库: ${ROOT}`);
  console.log(`  进包: ${files.length} 个文件`);
  console.log(`  排除: ${skipped.length} 项`);
  if (ignoreList.length) console.log(`  .packageignore: ${ignoreList.length} 条规则`);
  console.log('');

  // 体积统计
  let totalBytes = 0;
  for (const rel of files) {
    try { totalBytes += fs.statSync(path.join(ROOT, rel)).size; } catch {}
  }
  console.log(`  未压缩体积: ${human(totalBytes)}`);
  console.log('');

  // 排除项归类展示（让用户能核对"该排的都排了"）
  const byReason = new Map();
  for (const s of skipped) {
    const key = s.why.startsWith('路径含排除段')
      ? `排除路径段：${s.rel.split(/[\\/]/).find((p) => EXCLUDE_SEGMENTS.includes(p.toLowerCase()))}`
      : s.why;
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  console.log('  排除汇总:');
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${v.toString().padStart(4)} 项  ${k}`);
  }
  console.log('');

  // 顶层构成
  const topLevel = new Map();
  for (const rel of files) {
    const top = rel.split(/[\\/]/)[0];
    const cur = topLevel.get(top) ?? { n: 0, bytes: 0 };
    cur.n += 1;
    try { cur.bytes += fs.statSync(path.join(ROOT, rel)).size; } catch {}
    topLevel.set(top, cur);
  }
  console.log('  进包构成:');
  for (const [k, v] of [...topLevel.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`    ${k.padEnd(24)} ${String(v.n).padStart(4)} 个  ${human(v.bytes)}`);
  }
  console.log('');

  // ── 泄漏扫描 ─────────────────────────────────────────────────────────────
  console.log(`=== 泄漏扫描（用 ${secrets.length} 个真实隐私值搜 ${files.length} 个文件）===`);
  const leaks = scanForLeaks(files, secrets);
  if (!leaks.length) {
    console.log('  ✅ 未发现任何真实隐私值');
  } else {
    const byLabel = new Map();
    for (const h of leaks) byLabel.set(h.label, (byLabel.get(h.label) ?? 0) + 1);
    console.log(`  ⚠️ ${leaks.length} 处命中，涉及 ${new Set(leaks.map((h) => h.rel)).size} 个文件：`);
    for (const [label, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(3)} 处  ${label}`);
    }
    console.log('');
    for (const h of leaks.slice(0, 30)) {
      console.log(`     ${h.rel}  ← ${h.label}（${h.count} 次）`);
    }
    if (leaks.length > 30) console.log(`     … 另有 ${leaks.length - 30} 处`);
    if (redact) {
      console.log('');
      console.log('  → 已指定 --redact：会在**打包副本**里把这些值替换为占位符（源文件不动）');
    } else {
      console.log('');
      console.log('  → 这些内容会原样进包。要清理可用 --redact（只改副本），或把文件加进 .packageignore。');
    }
  }
  console.log('');

  if (planOnly) {
    console.log('（--plan 模式：只盘点，没有复制任何文件）');
    return failOnLeak && leaks.length && !redact ? 1 : 0;
  }

  if (leaks.length && failOnLeak && !redact && !allowPersonal) {
    console.error('❌ 存在疑似泄漏且指定了 --fail-on-leak，已中止打包。');
    console.error('   处理方式：用 --redact 脱敏，或把相关文件加进 .packageignore。');
    return 1;
  }

  // ── 复制到 staging ───────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const distDir = path.join(ROOT, 'dist');
  const staging = path.join(distDir, `qq-bridge-${stamp}`);
  fs.mkdirSync(staging, { recursive: true });

  let copied = 0;
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    const to = path.join(staging, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.copyFileSync(from, to); copied += 1; } catch (e) {
      console.error(`  ❌ 复制失败 ${rel}: ${e?.message ?? e}`);
    }
  }
  console.log(`✅ 已复制 ${copied}/${files.length} 个文件到：${staging}`);

  // ── 脱敏（只改副本）───────────────────────────────────────────────────────
  if (redact && leaks.length) {
    const done = redactStaging(staging, leaks);
    const totalReplaced = done.reduce((a, d) => a + d.replaced, 0);
    console.log('');
    console.log(`=== 已脱敏（源文件未改动）===`);
    console.log(`  替换 ${totalReplaced} 处，涉及 ${new Set(done.map((d) => d.rel)).size} 个文件：`);
    for (const d of done) {
      console.log(`    ${d.rel}  ← ${d.label} ×${d.replaced} → ${d.placeholder}`);
    }

    // 复检：对**打包副本**再扫一遍，证明脱敏真的生效
    console.log('');
    console.log('=== 脱敏后复检（扫打包副本）===');
    const stagedRel = [];
    const walkStaged = (dir, relDir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = relDir ? path.join(relDir, e.name) : e.name;
        if (e.isDirectory()) walkStaged(abs, rel);
        else stagedRel.push(rel);
      }
    };
    walkStaged(staging, '');
    let stagedLeaks = [];
    for (const rel of stagedRel) {
      if (!TEXT_EXT.test(rel)) continue;
      const abs = path.join(staging, rel);
      let text;
      try {
        if (fs.statSync(abs).size > MAX_SCAN_BYTES) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch { continue; }
      for (const s of secrets) {
        if (text.includes(s.value)) stagedLeaks.push({ rel, label: s.label });
      }
    }
    if (!stagedLeaks.length) {
      console.log('  ✅ 打包副本里已搜不到任何真实隐私值');
    } else {
      console.log(`  ⚠️ 仍有 ${stagedLeaks.length} 处残留（可能是被截断或有其他形式）：`);
      for (const h of stagedLeaks.slice(0, 20)) console.log(`     ${h.rel} ← ${h.label}`);
      console.log('     建议：把这些文件加进 .packageignore。');
    }
  }

  // 附一份打包说明（收件人第一眼看到的东西）
  const readme = [
    '# QQ 桥接 —— 免安装包',
    '',
    `打包时间：${new Date().toISOString()}`,
    `文件数：${files.length}`,
    '',
    '## 里面有什么',
    '',
    '- 源码：`src/`（桥接主进程、MCP 工具、出图客户端）',
    '- 桌面版：`desktop/`（Electron 应用，**不含依赖**）',
    '- DSH 预设：`dsh/`、插件：`plugins/`、角色：`roles/`',
    '- 运维工具：`tools/`（启停、卸载、配置导出导入）',
    '- 配置模板：`config.example.json`',
    '- 卸载程序：`uninstall.bat`、`uninstall-quiet.bat`',
    '',
    '## 里面没有什么（你需要自备）',
    '',
    '本包**不含**以下外部依赖，它们都不是本项目、也无法打进包：',
    '',
    '- **SnowLuma** —— QQ 网关（OneBot 实现），需自行准备',
    '- **ComfyUI** —— 出图引擎，光模型就十几 GB',
    '- **DSH** —— AI 宿主（本桥接作为插件挂在它上面）',
    '- **Node.js** —— 运行环境',
    '- `node_modules` —— 首次使用请在本目录执行 `npm install`',
    '',
    '## 首次使用',
    '',
    '1. 安装 Node.js（建议 22 或更高）',
    '2. **双击 `install.bat`**（推荐）—— 它会装到 `%LOCALAPPDATA%\\QQBridge`，',
    '   可选建快捷方式、登记系统卸载项。只想看计划不动手：`npm run install:plan`',
    '',
    '   想手工来一遍也行：',
    '   - `npm install` 装依赖',
    '   - `npm run setup` 跑配置向导（体检 + 自动探测 DSH / ComfyUI / SnowLuma + 生成 config.json）',
    '   - `tools\\qq-bridge-launcher.ps1 -Action startAll` 启动服务',
    '   - `npm run desktop` 打开桌面窗口（依赖需另装：`cd desktop && npm install`）',
    '',
    '   只想看看安装器会做什么、不想动手：`npm run install:plan`',
    '',
    '### 不想用向导？手动也行',
    '',
    '把 `config.example.json` 复制为 `config.json`，至少填这三项：',
    '`ownerQQ`（你的 QQ 号）、`dsh.baseUrl` 与 `dsh.authToken`（DSH 端点与令牌），',
    '再把要放行的群号填进 `allow.groups`。',
    '',
    '详见 `README.md`。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(staging, 'PACKAGE-README.md'), readme, 'utf8');

  // ── 打 zip ───────────────────────────────────────────────────────────────
  if (noZip) {
    console.log('（--no-zip：已跳过压缩）');
    return 0;
  }
  const zipPath = path.join(distDir, `qq-bridge-${stamp}.zip`);
  console.log('');
  console.log('正在压缩…');
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(staging, '*')}' -DestinationPath '${zipPath}' -Force`
  ], { encoding: 'utf8', windowsHide: true });
  if (ps.status !== 0) {
    console.error(`❌ 压缩失败：${(ps.stdout ?? '') + (ps.stderr ?? '')}`);
    return 1;
  }
  const zipSize = fs.statSync(zipPath).size;
  console.log(`✅ 已生成：${zipPath}（${human(zipSize)}）`);
  console.log('');
  console.log(`解压后目录：${staging}`);
  console.log('提醒：包内不含依赖，收件人需自行 npm install。');
  return 0;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) process.exit(main());

export { collectFiles, collectSecrets, scanForLeaks, shouldExclude, EXCLUDE_SEGMENTS, INCLUDE };
