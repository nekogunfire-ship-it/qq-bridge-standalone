// 「桥接报错去哪」的接线自检（2026-10-03）。
//
// 背景：桥接/模型侧的系统报错（未能送达 AI / 消息未被接受 / agent 处理出错）以前是直接
// 发进当前 QQ 会话的 —— 群里看到的是「⚠️ agent 处理出错：Insufficient Balance」这种
// 「机器人坏了」的消息，而真正要处理它的只有管理员。现在统一收敛到 notifyProblem 一个出口，
// 默认 off（只写日志）。行为验证见隔离副本测试（真起一份桥接，把模型端点指向死端口，
// 用 /api/socialV2/wake 触发一轮失败回合，看假 OneBot 上收到几条发送）。
//
// 为什么还要静态检查：这些调用点埋在桥接主函数闭包里，跑一次真回合成本高；这里守
// **最容易复发的那一类错误** —— 有人重构时把某个出口漏回 sendToQQ（报错又会漏进群里），
// 或者改了 notifyProblem 的签名却没改调用点（2026-10-03 实测过：漏传 cfg 时 direct 失败
// 路径直接抛 "cfg is not defined"，报错反而彻底丢了）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const count = (re) => [...SRC.matchAll(re)].length;

// ── ① 出口只有一个 ────────────────────────────────────────────────────────────
check('定义了 ERROR_NOTIFY_MODES 常量（off/owner/session 白名单）',
  /const ERROR_NOTIFY_MODES = new Set\(\['off', 'owner', 'session'\]\);/.test(SRC));
check('errorNotifyMode() 只定义一次',
  count(/function errorNotifyMode\(/g) === 1, `${count(/function errorNotifyMode\(/g)} 次`);
check('notifyProblem() 只定义一次',
  count(/function notifyProblem\(/g) === 1, `${count(/function notifyProblem\(/g)} 次`);
check('notifyProblem 是模块作用域函数（不在 main() 里）',
  /^async function notifyProblem\(/m.test(SRC));

const systemErrors = [
  '⚠️ 消息未能送达 AI',
  '⚠️ 消息未被接受',
  '⚠️ agent 处理出错'
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const text of systemErrors) {
  // 允许出现在 notifyProblem 调用里、注释里；不许再出现在 sendToQQ 参数里
  check(`「${text}」不再由 sendToQQ 直接发出`, !new RegExp(`sendToQQ\\([^)]*${esc(text)}`).test(SRC));
  check(`「${text}」至少有一个 notifyProblem 调用点`,
    new RegExp(`notifyProblem\\([^)]*${esc(text)}`).test(SRC));
}

// 三个已知系统报错出口的**全部**调用点都必须是 notifyProblem，且都带 cfg + sendToQQ
const callSites = [...SRC.matchAll(/notifyProblem\(cfg, sendToQQ, key, `⚠️ ([^`]+)：/g)]
  .map((m) => `⚠️ ${m[1]}`);
check('系统报错调用点数量 = 4（direct 失败 / direct 未被接受 / DSH 未被接受 / DSH 处理出错）',
  callSites.length === 4, `${callSites.length} 个：${callSites.join(' | ')}`);
check('每个系统报错调用点都显式传了 cfg 与 sendToQQ（不留闭包依赖）',
  !/notifyProblem\((?!cfg, sendToQQ)/.test(SRC.replace(/notifyProblem\(cfg, sendToQQ/g, '')));
const msgNotDelivered = count(/notifyProblem\(cfg, sendToQQ, key, `⚠️ 消息未能送达 AI/g);
const msgNotAccepted = count(/notifyProblem\(cfg, sendToQQ, key, `⚠️ 消息未被接受/g);
const agentError = count(/notifyProblem\(cfg, sendToQQ, key, `⚠️ agent 处理出错/g);
check('「消息未能送达 AI」只有 1 个出口（direct 运行时）', msgNotDelivered === 1, `${msgNotDelivered} 个`);
check('「消息未被接受」有 2 个出口（direct + DSH 投递路径）', msgNotAccepted === 2, `${msgNotAccepted} 个`);
check('「agent 处理出错」只有 1 个出口（DSH turn/end 分支）', agentError === 1, `${agentError} 个`);

// ── ② 语义：默认 off 时绝不碰 QQ；session 模式才回当前会话 ────────────────────────
const notifyStart = SRC.indexOf('async function notifyProblem(');
const notifyBody = SRC.slice(notifyStart, notifyStart + 2000);
check('notifyProblem 先从参数取 cfg（不靠闭包，模块作用域里没有 cfg）',
  /const mode = errorNotifyMode\(cfg\);/.test(notifyBody));
check('函数体里不出现裸 cfg.*（必须是 cfg 参数）', !/[^.\w]cfg\./.test(notifyBody.replace(/cfg\.socialV2|cfg\.ownerQQ/g, '')));
check('errorNotifyMode 默认值是 off', /\?\?\s*'off'/.test(SRC));
check('errorNotifyMode 对未知值回落到 off',
  /ERROR_NOTIFY_MODES\.has\(mode\) \? mode : 'off'/.test(SRC));
check('notifyProblem 先写日志（bridge.log + qq-activity.log）',
  /log\(`\[problem\]/.test(notifyBody) && /appendActivity\(/.test(notifyBody));
check('只有 mode=owner 才私聊管理员',
  /mode === 'owner'/.test(notifyBody) && /sendToQQ\(`private:\$\{owner\}`/.test(notifyBody));
check('owner 未配置/非法时直接跳过（不误发到别处）',
  /\/\^\\d\+\$\/\.test\(owner\)/.test(notifyBody));
check('只有 mode=session 且非静默才发当前会话',
  /mode === 'session' && opts\.silent !== true/.test(notifyBody));
check('off（或任何其它取值）直接 return，不发 QQ',
  /return \{ sent: 'session' \};[\s\S]{0,200}return \{ sent: 'none' \};/.test(notifyBody));

// ── ③ 调用点必须把 silent 传下去（静默投喂回合不因报错而发言）────────────────────
check('direct 运行时失败时把 opts.silent 一并交给 notifyProblem',
  /notifyProblem\(cfg, sendToQQ, key, `⚠️ 消息未能送达 AI：\$\{r\.error\}`[^;]*silent: opts\.silent === true/.test(SRC));
check('DSH 投递路径失败时把 opts.silent 一并交给 notifyProblem',
  /notifyProblem\(cfg, sendToQQ, key, `⚠️ 消息未被接受：\$\{safeErrText\}`[^;]*silent: opts\.silent === true/.test(SRC));

// ── ④ 控制台 / 配置端点的归一化 ───────────────────────────────────────────────
check('/api/socialV2/config 会把非法 errorNotify 归一成 off',
  /merged\.feedback\.errorNotify = ERROR_NOTIFY_MODES\.has\(mode\) \? mode : 'off';/.test(SRC));
check('config.json 默认段带 errorNotify: off', /errorNotify: 'off'/.test(SRC));

// ── ⑤ 刻意保留的用户可自修提示（别被误收敛）────────────────────────────────────
check('出图失败原因仍然直接发给用户（不收敛）',
  /await sendToQQ\(key, `出图失败：\$\{detail\}`\)/.test(SRC));
check('审批回执失败提示仍然直接发给用户（不收敛）',
  /await sendToQQ\(key, '⚠️ 审批回执提交失败，请再回复一次/.test(SRC));
check('敏感信息拦截告知仍然直接发给用户（不收敛）',
  /await sendToQQ\(key, '⚠️ 本条回复因疑似包含敏感信息/.test(SRC));

// ── ⑥ qq_report_feedback 的 owner 通知永远只走私聊 ────────────────────────────
check('qq_report_feedback 的错误级通知走 private:owner（不进群）',
  /const ownerKey = `private:\$\{String\(cfg\.ownerQQ\)\}`;/.test(SRC));
check('qq_report_feedback 的 owner 通知不再只打一行日志',
  !/错误级反馈，可通知 owner \$\{cfg\.ownerQQ\}（当前仅记录日志）/.test(SRC));

console.log(failures === 0 ? '\n=== 报错出口自检全部通过 ===' : `\n=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
