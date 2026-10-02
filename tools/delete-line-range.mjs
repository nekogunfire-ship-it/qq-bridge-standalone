// 按行号范围删除文件内容（含起止行），并打印删除前后的上下文以便核对。
// 用法: node tools/delete-line-range.mjs <文件> <起始行> <结束行>
import fs from 'node:fs';

const [file, fromArg, toArg] = process.argv.slice(2);
if (!file || !fromArg || !toArg) {
  console.error('用法: node tools/delete-line-range.mjs <文件> <起始行> <结束行>');
  process.exit(2);
}
const from = Number(fromArg);
const to = Number(toArg);
if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
  console.error('行号无效');
  process.exit(2);
}

const lines = fs.readFileSync(file, 'utf8').split('\n');
if (to > lines.length) { console.error(`结束行 ${to} 超出文件长度 ${lines.length}`); process.exit(1); }

console.log(`文件: ${file}（共 ${lines.length} 行）`);
console.log('');
console.log(`删除前一行 (${from - 1}): ${String(lines[from - 2] ?? '(文件开头)').slice(0, 100)}`);
console.log(`删除首行   (${from}): ${String(lines[from - 1]).slice(0, 100)}`);
console.log(`删除末行   (${to}): ${String(lines[to - 1]).slice(0, 100)}`);
console.log(`删除后一行 (${to + 1}): ${String(lines[to] ?? '(文件结尾)').slice(0, 100)}`);
console.log('');

const kept = [...lines.slice(0, from - 1), ...lines.slice(to)];
fs.writeFileSync(file, kept.join('\n'));
console.log(`已删除 ${to - from + 1} 行；现在共 ${kept.length} 行`);
