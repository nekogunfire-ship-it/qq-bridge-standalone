import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnNodeWorker } from '../desktop/lib/node-worker.js';

const child = spawnNodeWorker(['-e', 'console.log(process.env.ELECTRON_RUN_AS_NODE)'], {
  env: { ELECTRON_RUN_AS_NODE: '0' }, timeout: 10000
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});
assert.equal(code, 0);
assert.equal(output.trim(), '1');
const main = fs.readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(main, /spawn\(process\.execPath/);
console.log('PASS background utilities force Node mode; GUI main has no raw Electron script spawns');
