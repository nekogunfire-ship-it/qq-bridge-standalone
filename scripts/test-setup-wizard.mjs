// 首次配置向导的自检 —— 全程在**沙箱**里跑。
//
// 向导会生成/覆盖 config.json（被 gitignore、删了不可恢复），所以：
//   ① 一律用 --root 指向临时沙箱，**不碰真实仓库**；
//   ② 第一条断言就是"目标目录是沙箱"；
//   ③ 重点验证"绝不静默覆盖"：已有配置时 --yes 必须拒绝改写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(REPO, 'tools', 'setup-wizard.mjs');
const SANDBOX = path.join(os.tmpdir(), `qb-wizard-sandbox-${process.pid}`);
const SB_CFG = path.join(SANDBOX, 'config.json');
const SB_EXAMPLE = path.join(SANDBOX, 'config.example.json');
const SB_ARCHIVE = path.join(SANDBOX, 'archive');
const REAL_CFG = path.join(REPO, 'config.json');
const realConfigBefore = fs.existsSync(REAL_CFG) ? fs.readFileSync(REAL_CFG) : null;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: 'utf8', windowsHide: true });
const outOf = (r) => (r.stdout ?? '') + (r.stderr ?? '');
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// ── 沙箱：一份真实的模板 + 一个假 node_modules ──────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'desktop', 'node_modules'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'config.example.json'), SB_EXAMPLE);

// ── 0. 守卫：确认向导作用在沙箱上 ───────────────────────────────────────────
const guard = run(['--check', '--root', SANDBOX]);
const guardOut = outOf(guard);
if (!guardOut.includes(SANDBOX)) {
  console.error('🛑 中止：向导没有作用在沙箱上（--root 未生效），先修好再跑本测试');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
check('守卫通过：向导作用在沙箱路径', true, SANDBOX);

// ── 1. --check 只读 ─────────────────────────────────────────────────────────
check('--check 不创建 config.json', !fs.existsSync(SB_CFG));
check('--check 报告模板存在', /配置模板/.test(guardOut) && /在/.test(guardOut));

// ── 2. 探测能力（真实环境里 DSH 若在跑应能探到）─────────────────────────────
const hasDshDetect = /已探测到端点与令牌/.test(guardOut);
console.log(`INFO DSH 自动探测：${hasDshDetect ? '成功（能从管理器问到端点与令牌）' : '未探到（DSH 未运行或管理器不可达）'}`);
check('体检报告列出了三个外部依赖', /SnowLuma/.test(guardOut) && /ComfyUI/.test(guardOut) && /DSH/.test(guardOut));

// ── 3. --yes 生成配置（给定 QQ 号与群号）─────────────────────────────────────
const gen = run(['--root', SANDBOX, '--yes', '--owner-qq', '123456789', '--groups', '111111111,222222222']);
const genOut = outOf(gen);
check('--yes 生成 config.json', fs.existsSync(SB_CFG), genOut.trim().split('\n').slice(-1)[0]);
if (fs.existsSync(SB_CFG)) {
  const cfg = JSON.parse(fs.readFileSync(SB_CFG, 'utf8'));
  check('ownerQQ 已按参数写入', cfg.ownerQQ === '123456789', String(cfg.ownerQQ));
  check('管理员自己进了 allow.private', (cfg.allow.private ?? []).includes('123456789'),
    (cfg.allow.private ?? []).join(','));
  check('群号已写入 allow.groups',
    (cfg.allow.groups ?? []).includes('111111111') && (cfg.allow.groups ?? []).includes('222222222'),
    (cfg.allow.groups ?? []).join(','));
  check('模板的其余内容被保留（模型预设）',
    Object.keys(cfg.comfy?.models ?? {}).length >= 1,
    Object.keys(cfg.comfy?.models ?? {}).join(','));
  check('生成的配置结构完整（顶层键数与模板一致）',
    Object.keys(cfg).length === Object.keys(JSON.parse(fs.readFileSync(SB_EXAMPLE, 'utf8'))).length,
    `${Object.keys(cfg).length} 个顶层键`);
}

// ── 4. 已有配置时 --yes 必须拒绝覆盖（红线）─────────────────────────────────
const before = fs.readFileSync(SB_CFG, 'utf8');
const again = run(['--root', SANDBOX, '--yes', '--owner-qq', '999999999']);
check('已有配置时 --yes 不改写', fs.readFileSync(SB_CFG, 'utf8') === before);
check('拒绝时给出明确说明', /不覆盖已有配置|先自行备份/.test(outOf(again)), outOf(again).split('\n').find((l) => l.includes('不覆盖'))?.trim());
check('拒绝时不产生备份文件（因为没动配置）', !fs.existsSync(SB_ARCHIVE) || fs.readdirSync(SB_ARCHIVE).length === 0);

// ── 5. 校验：写入的是合法 JSON 且能读回 ─────────────────────────────────────
check('生成的 config.json 是合法 JSON', (() => {
  try { JSON.parse(fs.readFileSync(SB_CFG, 'utf8')); return true; } catch { return false; }
})());
check('生成的配置无占位符残留', !/改成你的/.test(fs.readFileSync(SB_CFG, 'utf8')));
check('模板里的占位预设已被剪掉（illustrious 无真实文件）', (() => {
  const cfg = JSON.parse(fs.readFileSync(SB_CFG, 'utf8'));
  return !Object.keys(cfg.comfy?.models ?? {}).includes('illustrious');
})(), (() => {
  const cfg = JSON.parse(fs.readFileSync(SB_CFG, 'utf8'));
  return Object.keys(cfg.comfy?.models ?? {}).join(',');
})());
check('剪掉后 defaultModel 仍指向存在的预设', (() => {
  const cfg = JSON.parse(fs.readFileSync(SB_CFG, 'utf8'));
  const models = Object.keys(cfg.comfy?.models ?? {});
  return models.length === 0 || models.includes(cfg.comfy.defaultModel);
})());
check('角色 LoRA 的占位条目也被剪掉', (() => {
  const cfg = JSON.parse(fs.readFileSync(SB_CFG, 'utf8'));
  const keys = Object.keys(cfg.comfy?.characterLoras ?? {}).filter((k) => !k.startsWith('_comment'));
  return keys.length === 0;
})());
check('剪枝过程有向用户报告', /已剪掉模板里的占位预设/.test(outOf(gen)), '（输出里有剪枝说明）');

// ── 6. 安装器自动模式：无需交互，读取显式环境变量但不泄露密钥 ──────────────
{
  const sbAuto = path.join(os.tmpdir(), `qb-wizard-auto-${process.pid}`);
  fs.rmSync(sbAuto, { recursive: true, force: true });
  fs.mkdirSync(path.join(sbAuto, 'node_modules'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'config.example.json'), path.join(sbAuto, 'config.example.json'));
  const secret = 'sk-test-secret-value-never-print';
  const auto = spawnSync(process.execPath, [
    TOOL, '--root', sbAuto, '--yes', '--auto', '--runtime', 'direct'
  ], {
    cwd: REPO, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, QQ_BRIDGE_OWNER_QQ: '987654321', DEEPSEEK_API_KEY: secret }
  });
  const autoOut = (auto.stdout ?? '') + (auto.stderr ?? '');
  const autoCfg = readJson(path.join(sbAuto, 'config.json'));
  const autoState = readJson(path.join(sbAuto, 'state', 'post-install.json'));
  check('⑥ --auto 无交互生成配置', auto.status === 0 && Boolean(autoCfg));
  check('⑥ 自动读取管理员 QQ 环境变量', autoCfg?.ownerQQ === '987654321');
  check('⑥ 自动读取 API key 但不打印明文', autoCfg?.runtime?.apiKey === secret && !autoOut.includes(secret));
  check('⑥ 自动生成控制台令牌', typeof autoCfg?.consoleToken === 'string' && autoCfg.consoleToken.length >= 24);
  check('⑥ 生成不含密钥的安装后状态', autoState?.autoConfigured === true && !JSON.stringify(autoState).includes(secret));
  fs.rmSync(sbAuto, { recursive: true, force: true });
}

// ── 7. 运行时选择：direct（用户要求"安装时选是否用 DSH 环境"的落点）────────────
// 注意：本机 DSH 在跑，所以向导**会**推断出建议 dsh；要测 direct 必须显式指定。
{
  const sb2 = path.join(os.tmpdir(), `qb-wizard-direct-${process.pid}`);
  fs.rmSync(sb2, { recursive: true, force: true });
  fs.mkdirSync(path.join(sb2, 'node_modules'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'config.example.json'), path.join(sb2, 'config.example.json'));

  const runDirect = spawnSync(process.execPath, [
    TOOL, '--root', sb2, '--yes',
    '--owner-qq', '123456789',
    '--runtime', 'direct',
    '--direct-base-url', 'https://api.example.com/v1',
    '--direct-model', 'my-model'
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  const outDirect = (runDirect.stdout ?? '') + (runDirect.stderr ?? '');
  check('⑦ --runtime direct 生成成功', runDirect.status === 0, outDirect.trim().split('\n').slice(-1)[0]);

  let cfgDirect = null;
  try { cfgDirect = JSON.parse(fs.readFileSync(path.join(sb2, 'config.json'), 'utf8')); } catch {}
  check('⑦ 配置里 runtime.type = direct', cfgDirect?.runtime?.type === 'direct', String(cfgDirect?.runtime?.type));
  check('⑦ 写入了接口地址与模型',
    cfgDirect?.runtime?.baseUrl === 'https://api.example.com/v1' && cfgDirect?.runtime?.model === 'my-model',
    `${cfgDirect?.runtime?.baseUrl} / ${cfgDirect?.runtime?.model}`);
  check('⑦ apiKey 缺省为空（不强制在此填写）', cfgDirect?.runtime?.apiKey === '', JSON.stringify(cfgDirect?.runtime?.apiKey));
  check('⑦ 输出里提示了 direct 只支持 chat 模式', /只支持 chat 模式|reserved2/.test(outDirect));
  check('⑦ 输出里把"补填 apiKey"列进下一步', /补填.*apiKey/.test(outDirect),
    (outDirect.split('\n').find((l) => /apiKey/.test(l)) ?? '').trim().slice(0, 90));
  check('⑦ 输出里的 key 是打码的（不把明文 key 打到屏幕上）',
    !/\b(sk-[A-Za-z0-9]{10,})\b/.test(outDirect));

  // dsh 路径仍可用
  const sb3 = path.join(os.tmpdir(), `qb-wizard-dsh-${process.pid}`);
  fs.rmSync(sb3, { recursive: true, force: true });
  fs.mkdirSync(path.join(sb3, 'node_modules'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'config.example.json'), path.join(sb3, 'config.example.json'));
  const runDsh = spawnSync(process.execPath, [
    TOOL, '--root', sb3, '--yes', '--owner-qq', '123456789', '--runtime', 'dsh'
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  let cfgDsh = null;
  try { cfgDsh = JSON.parse(fs.readFileSync(path.join(sb3, 'config.json'), 'utf8')); } catch {}
  check('⑦ --runtime dsh 仍生成 type=dsh（默认路径不变）', cfgDsh?.runtime?.type === 'dsh', String(cfgDsh?.runtime?.type));
  check('⑦ dsh 模式下不写 direct 的字段',
    cfgDsh?.runtime?.apiKey === undefined && cfgDsh?.runtime?.directBaseUrl === undefined);

  // 体检里应有"DSH 的 SDK 依赖"这一条（与"DSH 是否在跑"是两件事）
  const chk = spawnSync(process.execPath, [TOOL, '--check', '--root', sb2], {
    cwd: REPO, encoding: 'utf8', windowsHide: true
  });
  const chkOut = (chk.stdout ?? '') + (chk.stderr ?? '');
  check('⑦ 体检报告包含「DSH 的 SDK 依赖（可选）」一项', /DSH 的 SDK 依赖/.test(chkOut), '');
  check('⑦ 体检能说明 SDK 装没装（而不是只说 DSH 通不通）',
    /已安装|未安装/.test(chkOut), (chkOut.split('\n').find((l) => /SDK 依赖/.test(l)) ?? '').trim().slice(0, 90));

  fs.rmSync(sb2, { recursive: true, force: true });
  fs.rmSync(sb3, { recursive: true, force: true });
}

// ── 真实仓库未被触碰 ───────────────────────────────────────────────────────
check('真实仓库 config.json 的存在状态与内容逐字节未变', (() => {
  if (realConfigBefore === null) return !fs.existsSync(REAL_CFG);
  return fs.existsSync(REAL_CFG) && fs.readFileSync(REAL_CFG).equals(realConfigBefore);
})());

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? '=== 首次配置向导自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
