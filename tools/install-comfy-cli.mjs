import { comfySetupStatus, startComfyInstall, startModelInstall } from '../desktop/lib/comfy-manager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (name) => process.argv.includes(name);
const value = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(label) {
  let previous = '';
  while (true) {
    const current = comfySetupStatus(ROOT).job;
    const marker = `${current.phase}|${current.percent}|${current.received}`;
    if (marker !== previous) {
      const size = current.total ? ` ${(current.received / 1073741824).toFixed(2)} / ${(current.total / 1073741824).toFixed(2)} GB` : '';
      console.log(`[${label}] ${current.message || current.phase} ${current.percent || 0}%${size}`);
      previous = marker;
    }
    if (!current.running) {
      if (current.phase === 'done') return;
      throw new Error(current.error || `${label}未完成`);
    }
    await delay(750);
  }
}

try {
  if (has('--with-comfy')) {
    const result = startComfyInstall(ROOT, { variant: value('--variant', 'nvidia') });
    if (!result.ok) throw new Error(result.error);
    await waitForJob('ComfyUI');
  }
  if (has('--with-image-model')) {
    if (!has('--accept-model-license')) throw new Error('缺少模型许可证确认');
    const result = startModelInstall(ROOT, { modelKey: 'sdxlBase', acceptLicense: true });
    if (!result.ok) throw new Error(result.error);
    await waitForJob('SDXL');
  }
  console.log('所选 ComfyUI / 图片模型组件安装完成。');
} catch (error) {
  console.error(`安装出图组件失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
