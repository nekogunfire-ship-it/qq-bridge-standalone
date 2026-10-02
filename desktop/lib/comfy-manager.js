import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PORTABLES = Object.freeze({
  nvidia: { label: 'NVIDIA 20 系及更新', url: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z' },
  nvidiaLegacy: { label: 'NVIDIA 10 系及更早（CUDA 12.6）', url: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia_cu126.7z' },
  amd: { label: 'AMD（ROCm）', url: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_amd.7z' },
  intel: { label: 'Intel XPU', url: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_intel.7z' }
});

const MODELS = Object.freeze({
  sdxlBase: {
    label: 'Stable Diffusion XL Base 1.0',
    filename: 'sd_xl_base_1.0.safetensors',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors?download=true',
    sizeLabel: '约 6.9 GB',
    license: 'CreativeML Open RAIL++-M',
    licenseUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md'
  }
});

let job = idleJob();
let aborter = null;

function idleJob() {
  return { kind: '', running: false, phase: 'idle', message: '', received: 0, total: 0, percent: 0, error: '', finishedAt: '' };
}

function stateFile(root) { return path.join(root, 'state', 'comfy-install.json'); }

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function defaultComfyDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'QQBridge', 'ComfyUI');
}

export function readComfyInstall(root) {
  const saved = readJson(stateFile(root));
  const legacy = readJson(path.join(root, 'tools', 'services.json'))?.comfyDir;
  return { installDir: saved.installDir || legacy || defaultComfyDir(), variant: saved.variant || 'nvidia', modelKey: saved.modelKey || 'sdxlBase' };
}

function actualPortableRoot(base) {
  const candidates = [base, path.join(base, 'ComfyUI_windows_portable')];
  return candidates.find((p) => fs.existsSync(path.join(p, 'python_embeded', 'python.exe')) && fs.existsSync(path.join(p, 'ComfyUI', 'main.py'))) || base;
}

export function comfySetupStatus(root) {
  const saved = readComfyInstall(root);
  const installDir = actualPortableRoot(saved.installDir);
  const python = path.join(installDir, 'python_embeded', 'python.exe');
  const main = path.join(installDir, 'ComfyUI', 'main.py');
  const models = Object.fromEntries(Object.entries(MODELS).map(([key, model]) => [key, {
    ...model,
    installed: fs.existsSync(path.join(installDir, 'ComfyUI', 'models', 'checkpoints', model.filename))
  }]));
  return {
    ok: true,
    installed: fs.existsSync(python) && fs.existsSync(main),
    installDir,
    python,
    main,
    variant: saved.variant,
    variants: PORTABLES,
    models,
    job: { ...job }
  };
}

async function download(url, destination, kind) {
  aborter = new AbortController();
  const response = await fetch(url, { signal: aborter.signal, redirect: 'follow', headers: { 'user-agent': 'qq-bridge-comfy-installer/1.0' } });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  job = { ...job, kind, phase: 'download', message: '正在下载…', total, received: 0, percent: 0 };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(destination);
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    job.received += chunk.length;
    job.percent = total ? Math.min(99, Math.round(job.received * 100 / total)) : 0;
  });
  await pipeline(source, output);
  aborter = null;
}

function run(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${exe} 退出码 ${code}：${stderr.slice(-800)}`)));
  });
}

async function extract7z(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const candidates = [
    ['tar.exe', ['-xf', archive, '-C', destination]],
    ['7z.exe', ['x', '-y', `-o${destination}`, archive]],
    ['7zz.exe', ['x', '-y', `-o${destination}`, archive]]
  ];
  let last;
  for (const [exe, args] of candidates) {
    try { await run(exe, args, destination); return; } catch (error) { last = error; }
  }
  throw new Error(`无法解压官方 .7z 包。请安装 7-Zip，或使用支持 7z 的新版 Windows。${last ? ` ${last.message}` : ''}`);
}

function configureModel(root, installDir, model) {
  const configFile = path.join(root, 'config.json');
  const example = path.join(root, 'config.example.json');
  const cfg = readJson(configFile, readJson(example, {}));
  cfg.comfy = { ...(cfg.comfy || {}), enabled: true, host: cfg.comfy?.host || 'http://127.0.0.1:8188' };
  cfg.comfy.outputDir = path.join(installDir, 'ComfyUI', 'output');
  cfg.comfy.defaultModel = 'sdxl-base';
  cfg.comfy.models = { ...(cfg.comfy.models || {}), 'sdxl-base': {
    label: model.label, family: 'checkpoint', ckpt: model.filename,
    steps: 28, cfg: 5.5, samplerName: 'euler', scheduler: 'normal', width: 1024, height: 1024
  } };
  if (fs.existsSync(configFile)) {
    const archive = path.join(root, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.copyFileSync(configFile, path.join(archive, `config.json.before-comfy-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  }
  writeJson(configFile, cfg);
}

function startJob(kind, work) {
  if (job.running) return { ok: false, error: `正在执行${job.kind === 'install' ? '环境安装' : '模型下载'}` };
  job = { ...idleJob(), kind, running: true, phase: 'prepare', message: '正在准备…' };
  Promise.resolve().then(work).then(() => {
    job = { ...job, running: false, phase: 'done', message: '完成', percent: 100, finishedAt: new Date().toISOString() };
  }).catch((error) => {
    job = { ...job, running: false, phase: error?.name === 'AbortError' ? 'cancelled' : 'error', message: '未完成', error: error?.message || String(error), finishedAt: new Date().toISOString() };
  }).finally(() => { aborter = null; });
  return { ok: true, started: true };
}

export function startComfyInstall(root, options = {}) {
  const variant = PORTABLES[options.variant] ? options.variant : 'nvidia';
  const requested = String(options.installDir || defaultComfyDir()).trim();
  if (!path.isAbsolute(requested)) return { ok: false, error: '安装目录必须是绝对路径' };
  return startJob('install', async () => {
    const partial = path.join(os.tmpdir(), `qq-bridge-comfy-${process.pid}.7z.partial`);
    const archive = partial.replace(/\.partial$/, '');
    try {
      await download(PORTABLES[variant].url, partial, 'install');
      fs.renameSync(partial, archive);
      job = { ...job, phase: 'extract', message: '正在解压 ComfyUI…', percent: 99 };
      await extract7z(archive, requested);
      const installDir = actualPortableRoot(requested);
      if (!fs.existsSync(path.join(installDir, 'ComfyUI', 'main.py'))) throw new Error('解压完成，但没有找到 ComfyUI/main.py');
      writeJson(stateFile(root), { installDir, variant, modelKey: readComfyInstall(root).modelKey, installedAt: new Date().toISOString(), source: PORTABLES[variant].url });
    } finally {
      for (const file of [partial, archive]) { try { fs.rmSync(file, { force: true }); } catch {} }
    }
  });
}

export function startModelInstall(root, options = {}) {
  const modelKey = MODELS[options.modelKey] ? options.modelKey : 'sdxlBase';
  if (options.acceptLicense !== true) return { ok: false, error: '请先确认接受模型许可证' };
  const status = comfySetupStatus(root);
  if (!status.installed) return { ok: false, error: '请先安装 ComfyUI 环境' };
  const model = MODELS[modelKey];
  return startJob('model', async () => {
    const folder = path.join(status.installDir, 'ComfyUI', 'models', 'checkpoints');
    const target = path.join(folder, model.filename);
    const partial = `${target}.partial`;
    try {
      await download(model.url, partial, 'model');
      fs.renameSync(partial, target);
      configureModel(root, status.installDir, model);
      writeJson(stateFile(root), { ...readComfyInstall(root), installDir: status.installDir, modelKey, modelInstalledAt: new Date().toISOString() });
    } finally { try { fs.rmSync(partial, { force: true }); } catch {} }
  });
}

export function cancelComfySetup() {
  if (!job.running) return { ok: false, error: '当前没有下载任务' };
  aborter?.abort();
  return { ok: true };
}

