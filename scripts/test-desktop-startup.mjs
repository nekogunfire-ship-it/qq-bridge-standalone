// start.mjs 的运行期冒烟测试。
//
// 为什么需要：`node --check` 只做语法解析，查不出「引用了未定义的变量」这类错误 ——
// 真实发生过一次：start.mjs 里用了 ROOT 却没定义，语法检查全绿，用户一跑就
// ReferenceError: ROOT is not defined。
//
// 做法：用 --check 模式真实执行 start.mjs 的环境校验与目录准备（不拉起 Electron），
// 断言它退出码为 0 且输出里包含预期信息。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = path.join(ROOT, 'desktop', 'start.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

check('start.mjs 存在', fs.existsSync(START));

// 主动放一个假的缓存目录 + 文件，用真实执行来验证「启动前清缓存」这一步真的会清。
// （不能断言"缓存目录不存在" —— Electron 运行时自己会重建它们，那样断言必然失败。）
const userData = path.join(ROOT, 'state', 'electron-profile');
const fakeCacheDir = path.join(userData, 'GPUPersistentCache');
const fakeCacheFile = path.join(fakeCacheDir, 'marker.txt');
let seeded = false;
try {
  fs.mkdirSync(fakeCacheDir, { recursive: true });
  fs.writeFileSync(fakeCacheFile, 'should be removed by start.mjs --check', 'utf8');
  seeded = true;
} catch {}
check('已预置假缓存用于验证清理', seeded && fs.existsSync(fakeCacheFile));

// 真实执行（不拉起 Electron）
const r = spawnSync(process.execPath, [START, '--check'], {
  cwd: path.join(ROOT, 'desktop'),
  encoding: 'utf8',
  timeout: 30_000
});
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

check('--check 退出码为 0（无运行期异常）', r.status === 0,
  r.status === 0 ? '' : `exit=${r.status}；${out.trim().split('\n').slice(-3).join(' | ')}`);
check('未出现 ReferenceError 等 JS 运行期错误',
  !/ReferenceError|TypeError|is not defined/.test(out),
  /ReferenceError|TypeError|is not defined/.test(out) ? out.trim().split('\n')[0] : '干净');
check('打印了仓库根目录', /仓库根目录: .+qq-bridge/.test(out));
check('打印了 userData 路径且位于仓库内',
  /userData: .*state[\\/]electron-profile/.test(out),
  (out.match(/userData: (.*)/) ?? [])[1]?.trim() ?? '(未找到)');
check('确认 --check 模式不会拉起 Electron', /未拉起 Electron/.test(out));

check('userData 目录已创建', fs.existsSync(userData), userData);
check('预置的假缓存目录已被清理', !fs.existsSync(fakeCacheDir),
  fs.existsSync(fakeCacheDir) ? '仍在（清理逻辑失效）' : '已清掉');
check('清理动作有记录在输出里', /已清理缓存目录/.test(out),
  (out.match(/已清理缓存目录：(.*)/) ?? [])[1]?.trim() ?? '(未打印)');

console.log('');
console.log(failures === 0 ? '=== start.mjs 冒烟测试通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
