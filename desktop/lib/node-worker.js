import { spawn } from 'node:child_process';

// Electron's executable must run background utilities in explicit Node mode.
export function spawnNodeWorker(args, options = {}) {
  return spawn(process.execPath, args, {
    ...options,
    windowsHide: true,
    env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1' }
  });
}
