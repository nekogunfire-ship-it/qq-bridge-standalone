import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = path.join(ROOT, 'dist');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${command} 失败（${result.status}）\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result;
}

function newestPackageZip() {
  return fs.readdirSync(dist)
    .filter((name) => /^qq-bridge-\d{4}-.*\.zip$/i.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dist, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.name;
}

console.log(`=== 构建 Windows 安装程序 v${version} ===`);
run(process.execPath, [path.join(ROOT, 'tools', 'package-dist.mjs'), '--redact', '--fail-on-leak']);
const generated = newestPackageZip();
if (!generated) throw new Error('打包工具没有生成 zip');

const releaseZip = `qq-bridge-standalone-v${version}-windows.zip`;
fs.copyFileSync(path.join(dist, generated), path.join(dist, releaseZip));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-sfx-'));
const payload = path.join(temp, 'payload.zip');
const bootstrap = path.join(temp, 'setup.cmd');
const output = path.join(dist, `QQ-Bridge-Standalone-Setup-v${version}.exe`);
const temporaryOutput = path.join(temp, `QQ-Bridge-Standalone-Setup-v${version}.exe`);
fs.copyFileSync(path.join(dist, releaseZip), payload);
fs.writeFileSync(bootstrap, [
  '@echo off',
  'setlocal EnableExtensions',
  'chcp 65001 >nul 2>&1',
  'set "WORK=%TEMP%\\QQBridgeInstaller-%RANDOM%-%RANDOM%"',
  'mkdir "%WORK%" >nul 2>&1',
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath '%WORK%' -Force\"",
  'if errorlevel 1 (echo Failed to extract installer payload.& pause & exit /b 1)',
  'call "%WORK%\\install.bat"',
  'set "RC=%ERRORLEVEL%"',
  'rmdir /s /q "%WORK%" >nul 2>&1',
  'exit /b %RC%'
].join('\r\n') + '\r\n', 'ascii');

const sed = path.join(temp, 'installer.sed');
const q = (value) => String(value);
fs.writeFileSync(sed, [
  '[Version]', 'Class=IEXPRESS', 'SEDVersion=3',
  '[Options]', 'PackagePurpose=InstallApp', 'ShowInstallProgramWindow=1', 'HideExtractAnimation=0',
  'UseLongFileName=1', 'InsideCompressed=0', 'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0',
  'RebootMode=N', 'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=',
  `TargetName=${q(temporaryOutput)}`, `FriendlyName=QQ Bridge Standalone v${version} Setup`,
  'AppLaunched=setup.cmd', 'PostInstallCmd=<None>', 'AdminQuietInstCmd=', 'UserQuietInstCmd=',
  'SourceFiles=SourceFiles',
  '[SourceFiles]', `SourceFiles0=${q(temp)}\\`,
  '[SourceFiles0]', '%FILE0%=payload.zip', '%FILE1%=setup.cmd',
  '[Strings]', 'FILE0="payload.zip"', 'FILE1="setup.cmd"', ''
].join('\r\n'), 'ascii');

try {
  run('iexpress.exe', ['/N', sed]);
  if (!fs.existsSync(temporaryOutput) || fs.statSync(temporaryOutput).size < 100_000) throw new Error('IExpress 未生成有效安装程序');
  fs.copyFileSync(temporaryOutput, output);
  const hashes = run('certutil.exe', ['-hashfile', output, 'SHA256']).stdout
    .split(/\r?\n/).map((s) => s.trim()).find((s) => /^[0-9a-f]{64}$/i.test(s));
  const zipHashes = run('certutil.exe', ['-hashfile', path.join(dist, releaseZip), 'SHA256']).stdout
    .split(/\r?\n/).map((s) => s.trim()).find((s) => /^[0-9a-f]{64}$/i.test(s));
  const manifest = {
    version, builtAt: new Date().toISOString(),
    files: [
      { name: path.basename(output), sha256: hashes, size: fs.statSync(output).size },
      { name: releaseZip, sha256: zipHashes, size: fs.statSync(path.join(dist, releaseZip)).size }
    ]
  };
  fs.writeFileSync(path.join(dist, `SHA256SUMS-v${version}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
