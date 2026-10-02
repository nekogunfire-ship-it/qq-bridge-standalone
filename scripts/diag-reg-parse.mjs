// 调试 2：逐字符看行首，并单独测试正则。
import { spawnSync } from 'node:child_process';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qq-bridge-desktop';
const r = spawnSync('reg.exe', ['query', KEY], { encoding: 'utf8', windowsHide: true });
const lines = (r.stdout ?? '').split('\n');
const target = lines.find((l) => l.includes('DisplayName')) ?? '';

console.log('目标行 JSON:');
console.log(JSON.stringify(target));
console.log('\n前 24 个字符的码点:');
for (const ch of [...target.slice(0, 24)]) {
  process.stdout.write(`${JSON.stringify(ch)}=U+${ch.codePointAt(0).toString(16).padStart(4, '0')}  `);
}
console.log('\n');

// 逐条测试可能的写法
const tests = [
  ['原正则', /^\s{4}(\S+)\s+REG_\w+\s+(.*)$/],
  ['去掉 $', /^\s{4}(\S+)\s+REG_\w+\s+(.+)/],
  ['不锚定开头', /(\S+)\s+REG_\w+\s+(.+)/],
  ['允许任意空白开头', /^\s+(\S+)\s+REG_\w+\s+(.+)/],
  ['先 trim 再匹配', /^(\S+)\s+REG_\w+\s+(.+)/]
];
for (const [name, re] of tests) {
  const input = name === '先 trim 再匹配' ? target.trim() : target;
  const m = input.match(re);
  console.log(`  ${m ? 'MATCH  ' + m[1] + ' = ' + JSON.stringify(m[2]) : 'nomatch'}   ← ${name}`);
}
