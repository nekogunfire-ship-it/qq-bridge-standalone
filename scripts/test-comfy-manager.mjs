import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comfySetupStatus, startComfyInstall, startModelInstall, readComfyInstall } from '../desktop/lib/comfy-manager.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-comfy-manager-'));
try {
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'services.json'), JSON.stringify({ comfyDir: 'C:\\legacy-comfy' }));
  const initial = comfySetupStatus(root);
  assert.equal(initial.installed, false);
  assert.equal(initial.variants.nvidia.url.startsWith('https://github.com/comfyanonymous/ComfyUI/'), true);
  assert.equal(initial.models.sdxlBase.url.startsWith('https://huggingface.co/stabilityai/'), true);
  assert.equal(initial.models.sdxlBase.license.includes('Open RAIL'), true);
  assert.equal(startComfyInstall(root, { installDir: 'relative/path' }).ok, false);
  assert.equal(startModelInstall(root, { modelKey: 'sdxlBase', acceptLicense: false }).ok, false);
  assert.equal(startModelInstall(root, { modelKey: 'sdxlBase', acceptLicense: true }).ok, false);

  const portable = path.join(root, 'portable');
  fs.mkdirSync(path.join(portable, 'python_embeded'), { recursive: true });
  fs.mkdirSync(path.join(portable, 'ComfyUI'), { recursive: true });
  fs.writeFileSync(path.join(portable, 'python_embeded', 'python.exe'), 'fixture');
  fs.writeFileSync(path.join(portable, 'ComfyUI', 'main.py'), '# fixture');
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'comfy-install.json'), JSON.stringify({ installDir: portable, variant: 'intel' }));
  const ready = comfySetupStatus(root);
  assert.equal(ready.installed, true);
  assert.equal(ready.variant, 'intel');
  assert.equal(readComfyInstall(root).installDir, portable);
  console.log('=== ComfyUI 安装管理器自检通过 ===');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
