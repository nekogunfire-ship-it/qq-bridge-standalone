// 配置导出 / 导入 / 脱敏分发。
//
// 用途三种：
//   ① 备份与换机迁移 —— 导出完整配置，导入后接着用
//   ② 脱敏分发     —— 导出时把隐私与机器相关字段清掉，给别人当模板
//   ③ 查看他人配置 —— inspect 先看清楚包里有什么，再决定要不要导入
//
// ⚠️ 安全设计（这个工具会覆盖 config.json，而它被 gitignore、删了不可恢复）：
//   · `import` **默认只做预览**，必须显式加 `--apply` 才写入；
//   · 写入前**自动备份**现有 config.json（带时间戳，放在 archive/）；
//   · 只碰 bundle 里明确列出的文件，不做任何删除；
//   · 导入后校验 JSON 可解析，失败会回滚（从刚做的备份还原）。
//
// 用法：
//   node tools/config-portability.mjs export [--out <文件>] [--sanitize] [--with-desktop-settings]
//   node tools/config-portability.mjs inspect <文件>
//   node tools/config-portability.mjs import <文件> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 目标根可注入（与 uninstall-core 同样的理由：让测试能指向沙箱，不去动真实仓库）
function resolveRoot() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith('--root='));
  if (eq) return path.resolve(eq.slice('--root='.length));
  if (process.env.QB_CONFIG_ROOT) return path.resolve(process.env.QB_CONFIG_ROOT);
  return ROOT;
}
const TARGET = resolveRoot();

const CONFIG = path.join(TARGET, 'config.json');
const DESKTOP_SETTINGS = path.join(TARGET, 'state', 'desktop-settings.json');
const ARCHIVE = path.join(TARGET, 'archive');
const BUNDLE_KIND = 'qq-bridge-config-bundle';
const BUNDLE_VERSION = 1;

// 需要脱敏的字段：路径 → 中性值
// 选值依据：config.example.json（模板）里就是这些中性值，保持一致。
const REDACTIONS = [
  { path: 'ownerQQ', neutral: '', why: '你的 QQ 号（管理员身份）' },
  { path: 'dsh.authToken', neutral: '', why: 'DSH 的访问令牌' },
  { path: 'consoleToken', neutral: '', why: '网页控制台的访问令牌' },
  { path: 'allow.private', neutral: [], why: '私聊白名单（你的 QQ 号）' },
  { path: 'allow.groups', neutral: [], why: '群白名单（你加入的群号）' },
  { path: 'deny.private', neutral: [], why: '私聊黑名单' },
  { path: 'deny.groups', neutral: [], why: '群黑名单' },
  { path: 'dsh.baseUrl', neutral: 'http://127.0.0.1:3080', why: 'DSH 端点（含端口，换机即变）' }
];

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function appVersion() {
  try { return readJson(path.join(ROOT, 'package.json')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── 导出 ────────────────────────────────────────────────────────────────────
function doExport({ outFile, sanitize, withDesktopSettings }) {
  if (!fs.existsSync(CONFIG)) {
    console.error(`❌ 找不到 ${CONFIG}`);
    return 1;
  }
  const config = clone(readJson(CONFIG));
  const redacted = [];

  if (sanitize) {
    for (const r of REDACTIONS) {
      if (getPath(config, r.path) === undefined) continue;
      setPath(config, r.path, clone(r.neutral));
      redacted.push(r.path);
    }
  }

  const files = { 'config.json': config };
  if (withDesktopSettings && fs.existsSync(DESKTOP_SETTINGS)) {
    files['state/desktop-settings.json'] = clone(readJson(DESKTOP_SETTINGS));
  }

  const bundle = {
    kind: BUNDLE_KIND,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    sanitized: Boolean(sanitize),
    source: { app: 'qq-bridge', appVersion: appVersion() },
    notes: sanitize
      ? '已脱敏：隐私与机器相关字段被替换为中性值，导入后需要自己填。其余（社交/黑话/出图等调参）保持原样。'
      : '完整配置（未脱敏）：包含你的 QQ 号与令牌，请勿随意外发。',
    redactedFields: redacted.length ? redacted.map((p) => ({ path: p, why: REDACTIONS.find((r) => r.path === p).why })) : [],
    files
  };

  const target = outFile ?? path.join(TARGET, `config-bundle${sanitize ? '-sanitized' : ''}-${timestamp()}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', 'utf8');

  console.log(`✅ 已导出：${target}`);
  console.log(`   模式    : ${sanitize ? '脱敏（可分享）' : '完整（含隐私，勿外发）'}`);
  console.log(`   包含文件: ${Object.keys(files).join(', ')}`);
  if (redacted.length) {
    console.log(`   已脱敏 ${redacted.length} 个字段：`);
    for (const p of redacted) console.log(`     · ${p}  —— ${REDACTIONS.find((r) => r.path === p).why}`);
  }
  return 0;
}

// ── 查看 ────────────────────────────────────────────────────────────────────
function doInspect(file) {
  if (!file || !fs.existsSync(file)) { console.error(`❌ 找不到文件：${file ?? '(未指定)'}`); return 1; }
  let bundle;
  try { bundle = readJson(file); } catch (e) { console.error(`❌ 不是合法 JSON：${e?.message ?? e}`); return 1; }
  if (bundle.kind !== BUNDLE_KIND) {
    console.error(`❌ 不是本项目的配置包（kind=${bundle.kind ?? '(缺少)'}）`);
    return 1;
  }
  console.log(`包文件    : ${file}`);
  console.log(`导出时间  : ${bundle.exportedAt}`);
  console.log(`是否脱敏  : ${bundle.sanitized ? '是' : '否'}`);
  console.log(`来源版本  : ${bundle.source?.app} ${bundle.source?.appVersion}`);
  console.log(`包含文件  : ${Object.keys(bundle.files ?? {}).join(', ')}`);
  if (bundle.redactedFields?.length) {
    console.log(`待填字段  : ${bundle.redactedFields.map((r) => r.path).join(', ')}`);
  }
  const cfg = bundle.files?.['config.json'];
  if (cfg) {
    console.log('');
    console.log('config.json 概览:');
    console.log(`  顶层键        : ${Object.keys(cfg).join(', ')}`);
    console.log(`  ownerQQ       : ${cfg.ownerQQ === '' || cfg.ownerQQ == null ? '(空 —— 需自己填)' : `已填(${String(cfg.ownerQQ).length} 位)`}`);
    console.log(`  白名单群/私聊 : ${(cfg.allow?.groups ?? []).length} / ${(cfg.allow?.private ?? []).length} 项`);
    console.log(`  出图模型预设  : ${Object.keys(cfg.comfy?.models ?? {}).join(', ') || '(无)'}`);
    console.log(`  默认模型      : ${cfg.comfy?.defaultModel ?? '(未设)'}`);
  }
  return 0;
}

// ── 导入 ────────────────────────────────────────────────────────────────────
function doImport(file, apply) {
  if (!file || !fs.existsSync(file)) { console.error(`❌ 找不到文件：${file ?? '(未指定)'}`); return 1; }
  let bundle;
  try { bundle = readJson(file); } catch (e) { console.error(`❌ 不是合法 JSON：${e?.message ?? e}`); return 1; }
  if (bundle.kind !== BUNDLE_KIND) { console.error(`❌ 不是本项目的配置包`); return 1; }
  if ((bundle.bundleVersion ?? 0) > BUNDLE_VERSION) {
    console.error(`❌ 包版本 ${bundle.bundleVersion} 比本工具（${BUNDLE_VERSION}）新，拒绝导入`);
    return 1;
  }

  const incoming = bundle.files?.['config.json'];
  if (!incoming) { console.error('❌ 包里没有 config.json'); return 1; }

  // 预览：逐个顶层键对比，让用户看清会改什么
  const current = fs.existsSync(CONFIG) ? readJson(CONFIG) : null;
  console.log('=== 导入预览（尚未写入任何东西）===');
  console.log(`来源: ${file}`);
  console.log(`脱敏: ${bundle.sanitized ? '是（部分字段为空，导入后需自己填）' : '否'}`);
  console.log('');
  if (!current) {
    console.log('  当前没有 config.json —— 将新建。');
  } else {
    const keys = [...new Set([...Object.keys(current), ...Object.keys(incoming)])].sort();
    let changed = 0;
    for (const k of keys) {
      const a = JSON.stringify(current[k] ?? null);
      const b = JSON.stringify(incoming[k] ?? null);
      if (a === b) continue;
      changed += 1;
      const brief = (s) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
      console.log(`  · ${k}`);
      console.log(`      现在: ${brief(a)}`);
      console.log(`      导入: ${brief(b)}`);
    }
    console.log('');
    console.log(changed ? `共 ${changed} 个顶层键会变化。` : '内容完全相同，无需导入。');
    if (!changed) return 0;
  }

  if (bundle.redactedFields?.length) {
    console.log('');
    console.log('⚠️ 这个包是脱敏的，以下字段为空，导入后必须自己填，否则机器人不工作：');
    for (const r of bundle.redactedFields) console.log(`     · ${r.path}  —— ${r.why}`);
  }

  if (!apply) {
    console.log('');
    console.log('以上为**预览**。确认无误后加 --apply 真正写入（会先自动备份现有配置）。');
    return 0;
  }

  // 写入：先备份
  fs.mkdirSync(ARCHIVE, { recursive: true });
  let backup = null;
  if (current) {
    backup = path.join(ARCHIVE, `config.json.before-import-${timestamp()}`);
    fs.copyFileSync(CONFIG, backup);
    console.log(`已备份现有配置：${backup}`);
  }

  try {
    fs.writeFileSync(CONFIG, JSON.stringify(incoming, null, 2) + '\n', 'utf8');
    // 立刻校验能否解析；不能就从备份还原
    readJson(CONFIG);
    console.log(`✅ 已写入 ${CONFIG}`);
  } catch (e) {
    console.error(`❌ 写入后校验失败：${e?.message ?? e}`);
    if (backup) {
      fs.copyFileSync(backup, CONFIG);
      console.error(`   已从备份还原：${backup}`);
    } else {
      try { fs.rmSync(CONFIG, { force: true }); } catch {}
      console.error('   已删除写坏的 config.json（原先不存在，无备份）');
    }
    return 1;
  }

  const other = Object.keys(bundle.files ?? {}).filter((f) => f !== 'config.json');
  if (other.length) {
    console.log('');
    console.log(`包内还有其它文件（未自动导入，请按需手动处理）：${other.join(', ')}`);
  }
  console.log('');
  console.log('下一步：重启桥接让新配置生效（tools\\qq-bridge-launcher.ps1 -Action restart -Target bridge）。');
  return 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name) => argv.includes(name);
  const valueOf = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };

  if (cmd === 'export') {
    return doExport({
      outFile: valueOf('--out'),
      sanitize: flag('--sanitize'),
      withDesktopSettings: flag('--with-desktop-settings')
    });
  }
  if (cmd === 'inspect') return doInspect(argv[1]);
  if (cmd === 'import') return doImport(argv[1], flag('--apply'));

  console.log('QQ 桥接 · 配置导出 / 导入 / 脱敏');
  console.log('');
  console.log('  export [--out <文件>] [--sanitize] [--with-desktop-settings]');
  console.log('      导出配置包。--sanitize 清掉隐私与机器相关字段（用于分享）。');
  console.log('  inspect <文件>    查看包里有什么（不改动任何东西）');
  console.log('  import <文件> [--apply]');
  console.log('      导入配置。默认只预览，加 --apply 才写入（写入前自动备份）。');
  console.log('');
  console.log('  可选：--root <路径>  指定目标仓库（默认本仓库；测试指向沙箱用）');
  return 0;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) process.exit(main());

export { doExport, doImport, doInspect, REDACTIONS, BUNDLE_KIND, BUNDLE_VERSION };
