// 冒烟测试：确认 slang-learner 的导出的 prompt 构造函数在“脏文本”下也不抛错，
// 并且输出里没有孤立代理项（半个 emoji）。
// 用法：node scripts/smoke-slang-prompts.mjs
import { buildExtractionPrompt, buildResearchPrompt, loadSlang, saveSlang } from '../src/slang-learner.js';
import { hasLoneSurrogate } from '../src/text-safety.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`);
};

const dirty = '每日收入0元，就是为了操操操群主。 ' + '🐇 '.repeat(10) + '\uD83D' + '尾巴';

let extraction;
let research;
try {
  extraction = buildExtractionPrompt([{ sender: '群友', text: dirty }], { knownContents: ['yyds'], maxItems: 5 });
  research = buildResearchPrompt([{ content: 'hyw', evidence: [{ text: dirty }] }]);
} catch (error) {
  failed += 1;
  console.log(`FAIL 构建 prompt 抛错：${error?.message ?? error}`);
}

assert('buildExtractionPrompt 不抛错', typeof extraction === 'string');
assert('buildExtractionPrompt 输出无孤立代理项', typeof extraction === 'string' && !hasLoneSurrogate(extraction));
assert('buildResearchPrompt 不抛错', typeof research === 'string');
assert('buildResearchPrompt 输出无孤立代理项', typeof research === 'string' && !hasLoneSurrogate(research));

// loadSlang/saveSlang 往返：脏数据要被清掉
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-smoke-'));
const file = path.join(dir, 'slang.json');
fs.writeFileSync(file, JSON.stringify([{ id: 'x', status: 'confirmed', content: 'hyw', meaning: '好冤枉\uD83D', evidence: [{ text: 'a\uDC07b' }] }]));
const loaded = loadSlang(file);
assert('loadSlang 清掉含义里的孤立代理项', loaded[0]?.meaning === '好冤枉');
assert('loadSlang 清掉证据里的孤立代理项', loaded[0]?.evidence?.[0]?.text === 'ab');
saveSlang(file, loaded);
assert('saveSlang 落盘后没有孤立代理项', !hasLoneSurrogate(fs.readFileSync(file, 'utf8')));
fs.rmSync(dir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
