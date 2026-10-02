// DSH 重启监测的自检：端点稳定、变化、不可用、恢复四种情形都要被正确记录。
//
// ⚠️ 必须把日志与状态文件重定向到临时文件 —— 否则自检会污染生产的
// state/dsh-endpoint-state.json，让真实的重启检测失去基准（这类污染踩过一次）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  observeDshEndpoint,
  readDshRestartLog,
  setDshRestartLogFile,
  setDshStateFile
} from '../desktop/lib/dsh-watch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `qbd-dshwatch-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const LOG = path.join(TMP, 'dsh-restart.log');
const STATE = path.join(TMP, 'dsh-endpoint-state.json');

setDshRestartLogFile(LOG);
setDshStateFile(STATE);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  // 1) 首次观察：建立基准，不算变化
  let r = observeDshEndpoint('http://127.0.0.1:63223/?token=abc');
  check('首次观察不算变化', r.changed === false && r.first === true);
  check('首次观察剥离 query 与末尾斜杠（不把令牌写进状态）',
    r.current === 'http://127.0.0.1:63223', String(r.current));
  check('首次观察不写日志', !fs.existsSync(LOG));
  check('令牌未落盘到状态文件',
    !fs.readFileSync(STATE, 'utf8').includes('token='), fs.readFileSync(STATE, 'utf8').replace(/\s+/g, ' '));

  // 2) 端点不变：不记录
  r = observeDshEndpoint('http://127.0.0.1:63223/');
  check('端点不变时 changed=false', r.changed === false);
  check('端点不变时不写日志', !fs.existsSync(LOG));

  // 3) DSH 消失：记录"变为不可用"
  r = observeDshEndpoint(null);
  check('DSH 消失时事件为 down', r.event === 'down', String(r.event));
  check('DSH 消失后 downSince 有值', typeof r.downSince === 'number');
  let log = fs.readFileSync(LOG, 'utf8');
  check('写入了"变为不可用"记录', /DSH 变为不可用/.test(log), log.trim().split('\n').pop());

  // 4) DSH 以新端口回来：这是"重启"的关键信号（此前实现会漏掉，测试抓到过）
  r = observeDshEndpoint('http://127.0.0.1:59935/');
  check('停摆后以新端口回来 = changed（不是 recovered）', r.changed === true && r.event === 'changed',
    `event=${r.event} ${r.previous} → ${r.current}`);
  log = fs.readFileSync(LOG, 'utf8');
  check('写入了端点变化记录并含中断时长',
    /DSH 端点变化（已重启）：http:\/\/127\.0\.0\.1:63223 → http:\/\/127\.0\.0\.1:59935/.test(log),
    log.trim().split('\n').pop());
  check('新端点记录后 downSince 归零', r.downSince === null);

  // 5) 从"不可用"直接恢复（同端口）
  observeDshEndpoint(null);
  const back = observeDshEndpoint('http://127.0.0.1:59935/');
  check('同端口恢复事件为 recovered 且非 changed',
    back.event === 'recovered' && back.changed === false, String(back.event));
  log = fs.readFileSync(LOG, 'utf8');
  check('写入了"恢复可用"记录', /DSH 恢复可用/.test(log));

  // 6) readDshRestartLog 能读回
  const lines = readDshRestartLog(20);
  check('readDshRestartLog 返回记录', Array.isArray(lines) && lines.length >= 3, `${lines.length} 条`);
  check('每条记录都带 ISO 时间戳',
    lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)));

  // 7) 生产状态文件没有被本次测试改动
  const prodState = path.join(ROOT, 'state', 'dsh-endpoint-state.json');
  const prodLog = path.join(ROOT, 'state', 'dsh-restart.log');
  check('测试未写入生产状态文件（状态路径已重定向）',
    !fs.existsSync(prodState) || !fs.readFileSync(prodState, 'utf8').includes('59935'),
    fs.existsSync(prodState) ? '生产状态存在但未被本测试改写' : '生产状态文件尚不存在');
  void prodLog;
} finally {
  setDshRestartLogFile(null);
  setDshStateFile(null);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(failures === 0 ? '=== DSH 重启监测自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
