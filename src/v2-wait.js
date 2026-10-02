// 二代仿真模式：等待/结束回合相关的轻量判断工具。
// 这些是“提示/软信号”，不是硬规则；最终是否等待、是否发催话仍由 AI 自主决定。

// 常见“话说一半/没说完”的结尾特征。
const UNFINISHED_TAIL_RE = /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;

// 以中文逗号/顿号/分号/冒号等“非终止标点”结尾，也常表示还没说完。
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;

// 明确以终止标点/省略号结尾的消息视为说完。
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

export function looksLikeUnfinished(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (FINISHED_TAIL_RE.test(s)) return false;
  if (UNFINISHED_TAIL_RE.test(s)) return true;
  if (UNFINISHED_PUNCT_RE.test(s)) return true;
  return false;
}

// AI 等不到下文时可以用的“催话”短句。
export const UNFINISHED_PROMPT_REPLIES = ['什么', '啥', '你说啊', '然后呢', '？'];

// 建议的“结束前再等一轮”的等待时长范围（毫秒）。
export const END_ROUND_WAIT_MIN_MS = 5 * 60 * 1000;
export const END_ROUND_WAIT_MAX_MS = 10 * 60 * 1000;

/**
 * 沉睡前观察的记账：**只有这次等待的结果真的送得出去，才算数**。
 *
 * 为什么要有 `delivered` 这个条件（2026-09-27 实测）：
 * MCP 客户端的单次请求超时（SDK 默认 60 秒）比工具自己能等的时间（300 秒）短时，
 * 客户端会先放弃并报 `-32001`，而**服务端这条等待仍在跑、而且会跑完** ——
 * 于是桥接照样把“沉睡前观察已满足”置了位：日志写「满足沉睡前观察」，
 * 而模型手里是失败。**状态与事实相反，排查时会被它骗过去。**
 * 客户端已放弃（aborted）/ 被更新的等待接管（superseded）的请求，结果没人收，一律不算。
 *
 * @param {object} o
 * @param {boolean} o.delivered     这次等待的结果是否真能送达（!aborted && !superseded）
 * @param {boolean} o.arrived       等待期间是否等到新消息
 * @param {boolean} o.quiet         是否已安静满 quietMs
 * @param {number}  o.waitedSinceLastNewMs 距最后一条新消息过了多久
 * @param {number}  o.waitedMs      本次实际等了多久
 * @param {number}  o.preSleepWaitMs 沉睡前观察窗口（默认 300000）
 * @param {boolean} o.preSleepAttempt 本次是否是“等满观察窗口”的尝试（timeoutMs >= 窗口）
 * @returns {{satisfiedNow:boolean, observedNow:boolean, rawSatisfied:boolean}}
 */
export function preSleepBookkeeping(o = {}) {
  const waitedMs = Number(o.waitedMs) || 0;
  const preSleepWaitMs = Number(o.preSleepWaitMs) || 0;
  const waitedSinceLastNewMs = Number(o.waitedSinceLastNewMs) || 0;
  // 计算方式与原实现一致：没等到新消息 → 总时长够；等到新消息 → 最后一条之后安静够久。
  const rawSatisfied = o.arrived
    ? (o.quiet === true && waitedSinceLastNewMs >= preSleepWaitMs)
    : waitedMs >= preSleepWaitMs;
  if (o.delivered !== true) return { satisfiedNow: false, observedNow: false, rawSatisfied };
  if (rawSatisfied) return { satisfiedNow: true, observedNow: false, rawSatisfied: true };
  return { satisfiedNow: false, observedNow: o.arrived === true && o.preSleepAttempt === true, rawSatisfied: false };
}
