// 桌面应用设置：自动保存 + 防抖 + 原子写。
//
// 存 state/desktop-settings.json（与桥接的运行时数据同目录，且已被 .gitignore 覆盖，
// 不会混进版本库或者分发包）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const SETTINGS_PATH = path.join(ROOT, 'state', 'desktop-settings.json');

const DEFAULTS = {
  version: 1,
  window: { width: 1180, height: 780 },
  // 自动检查间隔（秒）；0 = 关闭定时检查
  autoCheckSeconds: 60,
  // 启动应用时是否自动拉起服务
  autoStartServices: false,
  // 关闭窗口时最小化到托盘（false = 直接退出）
  minimizeToTray: true,
  // 自动保存：配置类改动落盘前的防抖毫秒数
  autoSaveDebounceMs: 600,
  // ── 看门狗 ──────────────────────────────────────────────────────────────
  // 自动检查发现「桥接 / SnowLuma」不在监听时，自动尝试拉起。
  // 起因：实测到桥接在 SnowLuma 断开后自己消失（进程退出、无崩溃日志），
  // 结果是机器人静默掉线，用户毫不知情 —— 这类"没被察觉的失效"最该自动化兜住。
  watchdogEnabled: true,
  // 两次自动拉起之间的最小间隔（秒）：避免服务反复起不来时被高频重试打爆
  watchdogCooldownSeconds: 180,
  billing: { currency: 'CNY', inputPerMillion: 0, outputPerMillion: 0 },
  theme: 'dark'
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 深合并：只覆盖出现过的键，保留未提及的默认值
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function loadSettings() {
  try {
    let text = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return merge(DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    return { ...DEFAULTS };
  }
}

// 原子写：先写临时文件再 rename，避免写到一半崩溃导致设置损坏
export function writeSettingsSync(next) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
  return next;
}

let pending = null;
let pendingTimer = null;

export function saveSettings(patch) {
  const next = merge(loadSettings(), patch ?? {});
  // 立即写一次（窗口尺寸这类低频改动不需要等待），后续密集改动仍走防抖
  writeSettingsSync(next);
  return next;
}

/** 防抖保存：适合滑块/输入框这类高频改动。返回当前合并后的值。 */
export function saveSettingsDebounced(patch) {
  pending = merge(pending ?? loadSettings(), patch ?? {});
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const snapshot = pending;
    pending = null;
    try { writeSettingsSync(snapshot); } catch {}
  }, loadSettings().autoSaveDebounceMs ?? DEFAULTS.autoSaveDebounceMs);
  return loadSettings();
}

export function resetSettings() {
  return writeSettingsSync({ ...DEFAULTS });
}
