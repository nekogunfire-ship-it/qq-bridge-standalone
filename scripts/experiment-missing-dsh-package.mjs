// 实验：**没有 DSH 的 npm 包时，桥接能不能被 import？**
//
// 用户的要求是"不装 DSH 也必须能正常运行"。这个实验验的就是最底层那一问：
// `src/bridge.js` → `src/dsh-client.js` → `@deepseek-ai/dsh-host-apiproxy/client`
// 这条 import 链在包缺失时会不会直接把程序打死。
//
// 做法：把包临时改名（移出 node_modules），分别 import dsh-client 与 bridge，
// 观察结果，然后**务必还原**（finally 里做，异常也不漏）。
//
// 用法: node scripts/experiment-missing-dsh-package.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy');
const STASH = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy.__stashed__');

if (!fs.existsSync(PKG_DIR)) {
  console.error(`❌ 找不到 ${PKG_DIR}（本来就没装？那这个实验没意义）`);
  process.exit(1);
}
if (fs.existsSync(STASH)) {
  console.error(`❌ 已存在暂存目录 ${STASH} —— 上次实验没还原干净，请先手动处理`);
  process.exit(1);
}

async function tryImport(rel) {
  const url = pathToFileURL(path.join(ROOT, rel)).href;
  try {
    await import(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e?.code ?? '', message: String(e?.message ?? e).split('\n')[0].slice(0, 160) };
  }
}

const results = {};
try {
  console.log('=== 实验：把 DSH 的 npm 包移出 node_modules ===');
  fs.renameSync(PKG_DIR, STASH);
  console.log(`  已移出：${path.relative(ROOT, PKG_DIR)}`);
  console.log('');

  for (const rel of ['src/dsh-client.js']) {
    const r = await tryImport(rel);
    results[rel] = r;
    console.log(`  import ${rel}`);
    console.log(`     ${r.ok ? '✅ 成功（说明这个文件已经能脱离 DSH 包）' : `❌ 失败 code=${r.code}`}`);
    if (!r.ok) console.log(`     ${r.message}`);
  }

  // 光"能加载"不够 —— 还要验证：真去用 DSH 模式时报的是**可操作的**错误，
  // 而不是让人一头雾水的 ERR_MODULE_NOT_FOUND。
  if (results['src/dsh-client.js']?.ok) {
    console.log('');
    console.log('  深一层：此刻去 new NodeApiClient（= 用 DSH 模式）会怎样？');
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/dsh-client.js')).href);
    console.log(`     isDshSdkAvailable() = ${mod.isDshSdkAvailable()}`);
    const loadErr = mod.getDshSdkLoadError();
    console.log(`     getDshSdkLoadError() = ${loadErr ? loadErr.code : '(null)'}`);
    let threw = null;
    try {
      // eslint-disable-next-line no-new
      new mod.NodeApiClient('http://127.0.0.1:3080', undefined, {});
    } catch (e) {
      threw = e;
    }
    if (!threw) {
      console.log('     ❌ 竟然没抛错 —— 那 DSH 模式会在别处以更难懂的方式失败');
      results['new NodeApiClient'] = { ok: false, code: '', message: '未抛出可操作的错误' };
    } else {
      const actionable = threw.code === 'DSH_SDK_NOT_INSTALLED'
        && /optionalDependencies/.test(threw.message)
        && /runtime\.type/.test(threw.message);
      console.log(`     ${actionable ? '✅' : '❌'} code=${threw.code}`);
      threw.message.split('\n').forEach((l) => console.log(`       ${l}`));
      results['new NodeApiClient'] = { ok: actionable, code: threw.code ?? '', message: '' };
    }
  }
  console.log('');
  console.log('  注：bridge.js 本身是**主程序**，import 它会真的启动桥接，所以这里不直接 import，');
  console.log('      而是看它的 import 链首环（dsh-client）是否安全 —— 首环一挂，程序就起不来。');
} finally {
  // ⚠️ 无论成败都必须还原，否则 node_modules 处于残缺状态
  if (fs.existsSync(STASH)) {
    fs.renameSync(STASH, PKG_DIR);
    console.log('');
    console.log(`=== 已还原 ${path.relative(ROOT, PKG_DIR)} ===`);
  }
}

const failed = Object.entries(results).filter(([, r]) => !r.ok);
console.log('');
console.log(failed.length
  ? `结论：${failed.length} 个文件在缺少 DSH 包时无法加载 —— 用户的要求目前【达不到】`
  : '结论：dsh-client.js 已能脱离 DSH 包加载');
process.exit(failed.length ? 1 : 0);
