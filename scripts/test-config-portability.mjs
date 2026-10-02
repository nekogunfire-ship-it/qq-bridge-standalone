// 配置导入/导出的自检 —— 全程在**沙箱**里进行。
//
// 教训背景：这个工具会覆盖 config.json（被 gitignore、删了不可恢复），而我此前因为
// "沙箱测试跑到了真实仓库"误删过它。所以这里：
//   ① 一切都用 --root 指向临时沙箱，**不碰真实仓库**；
//   ② 第一条断言就是"作用对象是沙箱"；
//   ③ 重点验证破坏性路径：不加 --apply 必须不写入、写入前必须备份、写坏必须回滚。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(REPO, 'tools', 'config-portability.mjs');
const SANDBOX = path.join(os.tmpdir(), `qb-config-sandbox-${process.pid}`);
const SB_CFG = path.join(SANDBOX, 'config.json');
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

function writeSandboxConfig(obj) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(SB_CFG, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
const readSandboxConfig = () => JSON.parse(fs.readFileSync(SB_CFG, 'utf8'));

fs.rmSync(SANDBOX, { recursive: true, force: true });
writeSandboxConfig({
  ownerQQ: '111111111',
  dsh: { baseUrl: 'http://127.0.0.1:9999', authToken: 'sandbox-token' },
  allow: { private: ['111111111'], groups: ['222222222'] },
  deny: { private: [], groups: [] },
  comfy: { defaultModel: 'sandbox-model', models: { 'sandbox-model': { family: 'unet' } } },
  consoleToken: 'sandbox-console-token',
  slang: { enabled: true }
});

// ── 0. 守卫：确认工具真的作用在沙箱上 ───────────────────────────────────────
const guard = run(['export', '--root', SANDBOX, '--out', path.join(SANDBOX, 'guard.json')]);
const guardOut = outOf(guard);
if (!guardOut.includes(SANDBOX) && !fs.existsSync(path.join(SANDBOX, 'guard.json'))) {
  console.error('🛑 中止：工具似乎没有作用在沙箱上，先修好 --root 再跑本测试');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
check('守卫通过：工具作用在沙箱路径', true, SANDBOX);

// ── 1. 导出（完整 & 脱敏）──────────────────────────────────────────────────
const fullBundle = path.join(SANDBOX, 'full.json');
const sanBundle = path.join(SANDBOX, 'sanitized.json');
run(['export', '--root', SANDBOX, '--out', fullBundle]);
run(['export', '--root', SANDBOX, '--out', sanBundle, '--sanitize']);

const full = JSON.parse(fs.readFileSync(fullBundle, 'utf8'));
const san = JSON.parse(fs.readFileSync(sanBundle, 'utf8'));
check('完整导出保留了 ownerQQ', full.files['config.json'].ownerQQ === '111111111');
check('完整导出保留了白名单', (full.files['config.json'].allow.groups ?? []).length === 1);
check('完整导出标记 sanitized=false', full.sanitized === false);
check('脱敏导出清空了 ownerQQ', san.files['config.json'].ownerQQ === '', JSON.stringify(san.files['config.json'].ownerQQ));
check('脱敏导出清空了令牌', san.files['config.json'].dsh.authToken === '' && san.files['config.json'].consoleToken === '');
check('脱敏导出清空了白名单', (san.files['config.json'].allow.groups ?? []).length === 0
  && (san.files['config.json'].allow.private ?? []).length === 0);
check('脱敏导出重置了 dsh.baseUrl', san.files['config.json'].dsh.baseUrl === 'http://127.0.0.1:3080',
  san.files['config.json'].dsh.baseUrl);
check('脱敏导出**保留**了调参内容（这才是有价值的部分）',
  san.files['config.json'].slang?.enabled === true
  && Object.keys(san.files['config.json'].comfy?.models ?? {}).length === 1);
check('脱敏导出记录了待填字段清单',
  Array.isArray(san.redactedFields) && san.redactedFields.some((r) => r.path === 'ownerQQ'),
  `${(san.redactedFields ?? []).length} 项`);

// ── 2. inspect 只读 ─────────────────────────────────────────────────────────
const beforeInspect = fs.readFileSync(SB_CFG, 'utf8');
const ins = run(['inspect', sanBundle]);
const insOut = outOf(ins);
check('inspect 能识别包类型与脱敏状态', /是否脱敏\s*:\s*是/.test(insOut), insOut.split('\n').find((l) => l.includes('是否脱敏'))?.trim());
check('inspect 不改动 config.json', fs.readFileSync(SB_CFG, 'utf8') === beforeInspect);
check('inspect 拒绝非本项目的包', (() => {
  const junk = path.join(SANDBOX, 'junk.json');
  fs.writeFileSync(junk, JSON.stringify({ kind: 'something-else' }), 'utf8');
  const r = run(['inspect', junk]);
  return r.status !== 0 && /不是本项目/.test(outOf(r));
})());

// ── 3. import 默认只预览：绝不能写入 ───────────────────────────────────────
// 注意：要让沙箱配置与包**不同**，否则工具会正确地早退（"内容完全相同，无需导入"），
// 那样就测不到"预览会提示 --apply"这一行为。
writeSandboxConfig({
  ownerQQ: '555555555',            // 与包里的 111111111 不同
  dsh: { baseUrl: 'http://127.0.0.1:8888', authToken: 'x' },
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] },
  comfy: { defaultModel: 'differs', models: {} },
  slang: { enabled: false }
});
const snapshot = fs.readFileSync(SB_CFG, 'utf8');
const preview = run(['import', fullBundle, '--root', SANDBOX]);
const previewOut = outOf(preview);
check('import 未加 --apply 时返回成功但不写入',
  preview.status === 0 && fs.readFileSync(SB_CFG, 'utf8') === snapshot,
  previewOut.includes('预览') ? '已提示为预览' : previewOut.slice(-120));
check('预览里列出了会变化的键', /现在:/.test(previewOut) && /导入:/.test(previewOut));
check('预览里提示了 --apply', /--apply/.test(previewOut));
check('预览不动 config.json（内容逐字节相同）', fs.readFileSync(SB_CFG, 'utf8') === snapshot);

// ── 4. 改沙箱配置，再 import --apply：应覆盖且**先备份** ─────────────────────
writeSandboxConfig({ ownerQQ: '999999999', slang: { enabled: false } });
const applyRun = run(['import', fullBundle, '--root', SANDBOX, '--apply']);
const applyOut = outOf(applyRun);
check('import --apply 成功', applyRun.status === 0, applyOut.trim().split('\n').slice(-1)[0]);
const after = readSandboxConfig();
check('导入后配置被替换（ownerQQ 变为包里的值）', after.ownerQQ === '111111111', String(after.ownerQQ));
check('导入前自动备份了原配置', fs.existsSync(SB_ARCHIVE)
  && fs.readdirSync(SB_ARCHIVE).some((f) => f.startsWith('config.json.before-import-')),
  fs.existsSync(SB_ARCHIVE) ? fs.readdirSync(SB_ARCHIVE).join(', ') : '(archive 目录不存在)');
check('备份内容确实是导入前的旧配置', (() => {
  const b = fs.readdirSync(SB_ARCHIVE).find((f) => f.startsWith('config.json.before-import-'));
  if (!b) return false;
  const old = JSON.parse(fs.readFileSync(path.join(SB_ARCHIVE, b), 'utf8'));
  return old.ownerQQ === '999999999';
})());

// ── 5. 导入脱敏包后会提示"必须自己填" ───────────────────────────────────────
const applySan = run(['import', sanBundle, '--root', SANDBOX, '--apply']);
const sanOut = outOf(applySan);
check('导入脱敏包时提醒待填字段', /必须自己填|需自己填/.test(sanOut), sanOut.split('\n').filter((l) => l.includes('必须自己填')).slice(0, 2).join(' / '));
check('脱敏包导入后 ownerQQ 为空（符合预期）', readSandboxConfig().ownerQQ === '');

// ── 6. 损坏的包必须被拒绝，且不动现有配置 ───────────────────────────────────
const bad = path.join(SANDBOX, 'bad.json');
fs.writeFileSync(bad, '{ this is not json', 'utf8');
const beforeBad = fs.readFileSync(SB_CFG, 'utf8');
const badRun = run(['import', bad, '--root', SANDBOX, '--apply']);
check('损坏的包被拒绝且不改动配置',
  badRun.status !== 0 && fs.readFileSync(SB_CFG, 'utf8') === beforeBad);

// ── 7. 真实仓库未被触碰 ─────────────────────────────────────────────────────
check('真实仓库的 config.json 存在状态与内容逐字节未变', (() => {
  if (realConfigBefore === null) return !fs.existsSync(REAL_CFG);
  return fs.existsSync(REAL_CFG) && fs.readFileSync(REAL_CFG).equals(realConfigBefore);
})());

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? '=== 配置导入/导出自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
