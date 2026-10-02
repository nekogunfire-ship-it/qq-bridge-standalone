// 扫描桌面上已有快捷方式的 IconLocation，汇总"已知可用"的图标来源，
// 供新快捷方式挑选（避免瞎猜索引导致图标显示成空白）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const desktop = path.join(process.env.USERPROFILE, 'Desktop');
const publicDesktop = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');

// 用 PowerShell 读取 .lnk 的 IconLocation（不依赖 System.Drawing）。
function readShortcuts(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk'));
  if (!files.length) return [];
  const ps = `
$sh = New-Object -ComObject WScript.Shell
$out = @()
foreach ($f in Get-ChildItem -LiteralPath ${JSON.stringify(dir)} -Filter *.lnk) {
  $s = $sh.CreateShortcut($f.FullName)
  $out += [pscustomobject]@{ name = $f.Name; icon = $s.IconLocation; target = $s.TargetPath }
}
$out | ConvertTo-Json -Depth 3 -Compress
`;
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    const parsed = JSON.parse(raw.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.log(`  [warn] 读取 ${dir} 失败: ${e.message}`);
    return [];
  }
}

const all = [...readShortcuts(desktop), ...readShortcuts(publicDesktop)];
console.log(`扫描到 ${all.length} 个快捷方式：\n`);
const iconCount = new Map();
for (const s of all) {
  const icon = String(s.icon || '').trim();
  console.log(`  ${icon || '(空)'}  <-  ${s.name}`);
  if (icon) iconCount.set(icon, (iconCount.get(icon) || 0) + 1);
}

console.log('\n按使用次数排序的图标来源：');
for (const [icon, n] of [...iconCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}x  ${icon}`);
}
