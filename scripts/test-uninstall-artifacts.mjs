// 卸载相关产物的自检：注册表条目、批处理编码、核心的 --json 输出。
//
// 重点守两类"看起来没问题、其实不工作"的坑：
//   ① reg query 的输出是 \r\n，而 JS 的 `.` **不匹配 \r** —— 用 `(.*)$` 解析会永远失败
//      （我踩过：--check 打印"已注册"却一个字段都没有）；
//   ② reg query 按控制台代码页（本机 cp936）输出，按 UTF-8 读会把中文变成 U+FFFD。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── 1. reg 输出的解析规则（纯字符串测试，不依赖真实注册表）──────────────────
// 与 tools/register-uninstall-entry.mjs 里的写法保持一致
const parseReg = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

const sample = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop',
  '    DisplayName    REG_SZ    QQ 桥接控制台（QQ Bridge）',
  '    DisplayVersion    REG_SZ    0.1.5',
  '    InstallLocation    REG_SZ    C:\\some path\\qq-bridge',
  '    NoModify    REG_DWORD    0x1',
  ''
].join('\r\n');

const parsed = parseReg(sample);
check('解析 CRLF 行（. 不匹配 \\r，故不能用 (.*)$）',
  Object.keys(parsed).length === 4, `解出 ${Object.keys(parsed).length} 个字段`);
check('解析出中文值', parsed.DisplayName === 'QQ 桥接控制台（QQ Bridge）', parsed.DisplayName);
check('解析出含空格的值', parsed.InstallLocation === 'C:\\some path\\qq-bridge', parsed.InstallLocation);
check('解析出 REG_DWORD', parsed.NoModify === '0x1', parsed.NoModify);

// 反例：旧写法必须失败 —— 这条断言是给"别再改回去"用的
const oldStyle = sample.split('\n').map((l) => {
  const m = l.match(/^\s{4}(\S+)\s+REG_\w+\s+(.*)$/);
  return m ? m[1] : null;
}).filter(Boolean);
check('旧写法（(.*)$）在 CRLF 上确实失效（记录这个坑）',
  oldStyle.length === 0, `旧写法解出 ${oldStyle.length} 个（应为 0）`);

// ── 2. 批处理必须纯 ASCII + CRLF ────────────────────────────────────────────
for (const f of ['uninstall.bat', 'uninstall-quiet.bat']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { check(`${f} 存在`, false); continue; }
  const text = fs.readFileSync(p, 'latin1');
  const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  check(`${f} 纯 ASCII`, nonAscii === 0, `非 ASCII ${nonAscii} 个`);
  check(`${f} 无裸 LF`, bareLf === 0, `裸 LF ${bareLf} 个`);
}

// ── 3. 卸载核心的 --json 输出（只读，不删东西）──────────────────────────────
const jsonRun = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'uninstall-core.mjs'), '--json', '--keep-data'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true
});
let plan = null;
try { plan = JSON.parse(jsonRun.stdout ?? ''); } catch {}
check('--json 输出可解析', Boolean(plan), plan ? `${plan.steps.length} 步` : (jsonRun.stderr ?? '').slice(0, 120));
if (plan) {
  check('计划含释放空间估算', typeof plan.freeingBytes === 'number' && plan.freeingBytes > 0,
    `${Math.round(plan.freeingBytes / 1048576)} MB`);
  check('计划第一步是停止服务', /停止服务/.test(plan.steps[0]?.title ?? ''), plan.steps[0]?.title);
  check('摘要含第三方清单', Array.isArray(plan.summary?.thirdParty), (plan.summary?.thirdParty ?? []).join('、'));
  check('摘要含计划任务清单', (plan.summary?.tasks ?? []).length >= 2, (plan.summary?.tasks ?? []).join('、'));
}

// ── 4. 注册表条目的现状（未注册不算失败：这是可选步骤）─────────────────────
const chk = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'register-uninstall-entry.mjs'), '--check'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true
});
const chkOut = (chk.stdout ?? '') + (chk.stderr ?? '');
if (/未注册/.test(chkOut)) {
  console.log('INFO 注册表条目未注册（可用 node tools/register-uninstall-entry.mjs 注册；不算失败）');
} else {
  check('注册表条目能读出 DisplayName', /DisplayName\s+\S/.test(chkOut), chkOut.split('\n').find((l) => l.includes('DisplayName'))?.trim());
  check('注册表条目能读出中文（编码正确，不是乱码）', !/\uFFFD/.test(chkOut),
    chkOut.split('\n').find((l) => l.includes('DisplayName'))?.trim());
}

console.log('');
console.log(failures === 0 ? '=== 卸载产物自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
