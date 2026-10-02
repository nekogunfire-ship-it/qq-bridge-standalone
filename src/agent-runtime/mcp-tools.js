// direct 运行时的工具层：**把现有的 MCP server 当子进程拉起来，自己当 MCP 客户端**。
//
// 为什么这么做（而不是手写工具 schema）：
//   桥接的"手"（收发消息、看图、出图、表情包、黑话、记忆…）已经以 38 个 MCP 工具的形式存在于
//   src/mcp-*.js，实现方式是转发到桥接的 HTTP API。手写一份 OpenAI 格式的 schema 会有两个问题：
//     ① 只有少数几个工具能用（38 个重写一遍不现实）；
//     ② **与 MCP 定义漂移** —— 以后加了工具，direct 模式不会自动获得。
//   而 MCP 是**开放标准**，`@modelcontextprotocol/sdk` 是普通依赖（**不是 DSH 的包**），
//   仓库里 scripts/test-mcp-servers-stdio.mjs 早已证明"用 Client + StdioClientTransport 拉起
//   这些 server 并列出工具"可行。
//
// 关键事实（已由 scripts/experiment-mcp-tools-for-direct.mjs 实测）：
//   MCP 的 `tools/list` 返回的 `inputSchema` 是**标准 JSON Schema**（draft-07，type=object），
//   所以转成 OpenAI 的 `tools[].function.parameters` **只需改包装、不用改内容**。38/38 个工具都合格。
//
// 与 DSH 的关系：DSH 也把同样的 server 拉起当 MCP 客户端（工具名 mcp__<server>__<raw>）。
//   这里功能等价，只是"宿主"换成了 direct 运行时 —— 这也是"脱钩丢的只是 LLM 运行时"的一个实例。
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** 仓库自带的三个 MCP server（与 scripts/test-mcp-servers-stdio.mjs 一致） */
export const DEFAULT_MCP_SERVERS = [
  { name: 'snowluma', script: 'src/mcp-snowluma-safe.js' },
  { name: 'snowluma-host', script: 'src/mcp-host-server.js' },
  { name: 'web-search-safe', script: 'src/mcp-web-search-safe.js' }
];

/**
 * 长轮询类工具：**调用方的超时必须按"工具自己要等多久"来算**，不能吃 SDK 的默认值。
 *
 * 为什么（2026-09-27 实测查清）：`qq_wait_for_messages(timeoutMs=300000)` 是操作规程要求的
 * 「5 分钟沉睡前观察」。MCP 客户端**不传 timeout 时用 SDK 默认的 60 秒**
 * （`DEFAULT_REQUEST_TIMEOUT_MSEC`），于是每一次等待都在 60 秒被客户端掐掉、报
 * `MCP error -32001: Request timed out` —— 而桥接那边的等待还在跑。
 * AI 收到失败就重试，每次重试又把上一次的等待顶掉 → 观察窗口永远完不成，一路撞满工具轮数上限。
 *
 * ⚠️ **同一个预算要写在三层里，这里是最容易漏的客户端层**：
 *   · MCP server 给 wait 的 fetch 预算 = `timeoutMs + max(quietMs,10s) + 20s`（上限 725s，见 mcp-snowluma-safe.js）
 *   · DSH 宿主：`toolCallTimeoutMs: 725000`（scripts/setup-dsh.mjs 写进 profile）
 *   · direct 客户端：**本文件**（planToolCallTimeout）
 * 三处要一起改 —— 漏一处就等于没有。
 */
export const LONG_POLL_TOOLS = new Set(['qq_wait_for_messages']);

/** 与 src/mcp-snowluma-safe.js 里 wait 的实现保持一致（改一处就要改两处） */
const WAIT_MIN_QUIET_MS = 10_000;
const WAIT_EXTRA_MS = 20_000;
const WAIT_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 算"这一次工具调用该给它多少时间"，或者判定它**根本不该发出去**。
 * 纯函数（不碰网络、不看时钟），便于单测。
 *
 * @param {string} name 工具名
 * @param {object} args 模型给的参数
 * @param {{defaultMs?:number, maxMs?:number}} [opts] defaultMs=普通工具超时（默认 60s）；maxMs=单次调用硬上限
 * @returns {{timeoutMs:number, neededMs?:number, refused?:true, suggestedTimeoutMs?:number, reason?:string}}
 */
export function planToolCallTimeout(name, args = {}, opts = {}) {
  const defaultMs = Number(opts.defaultMs) > 0 ? Number(opts.defaultMs) : 60_000;
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : Infinity;
  if (!LONG_POLL_TOOLS.has(name)) return { timeoutMs: Math.min(defaultMs, maxMs) };

  const requested = Number(args?.timeoutMs) > 0 ? Math.round(Number(args.timeoutMs)) : WAIT_DEFAULT_TIMEOUT_MS;
  const quiet = Number(args?.quietMs) > 0 ? Math.round(Number(args.quietMs)) : WAIT_MIN_QUIET_MS;
  const effectiveQuiet = Math.max(quiet, WAIT_MIN_QUIET_MS);
  // 桥接侧最多会等 timeoutMs + quietMs（quietMs 有 120s 上限）+ 5s，这里留同样的余量。
  const neededMs = requested + effectiveQuiet + WAIT_EXTRA_MS;
  if (neededMs <= maxMs) return { timeoutMs: neededMs, neededMs };

  // 塞不进整轮预算就**别发**：发出去只会复现"客户端先超时、桥接还在等"的老问题，
  // 而 AI 看到一句 -32001 完全不知道该改什么。直接告诉它上限，它自己会把 timeoutMs 改小。
  const suggestedTimeoutMs = Math.max(
    5_000,
    Math.floor((maxMs - effectiveQuiet - WAIT_EXTRA_MS) / 60_000) * 60_000
  );
  return {
    timeoutMs: maxMs,
    neededMs,
    refused: true,
    suggestedTimeoutMs,
    reason: `这次等待需要约 ${Math.ceil(neededMs / 1000)} 秒（timeoutMs=${requested} + 静默 ${effectiveQuiet} + 余量），`
      + `超过单次工具调用的上限 ${Math.round(maxMs / 1000)} 秒（该上限受整轮预算限制）。`
      + `请把 timeoutMs 改小到 ${suggestedTimeoutMs} 或更小后重试。`
  };
}

export class McpToolProvider {
  /**
   * @param {object} opts
   * @param {string} opts.root            仓库根（server 脚本相对它解析）
   * @param {Array<{name:string,script:string}>} [opts.servers]
   * @param {string[]} [opts.exclude]     要排除的工具名（见下方说明）
   * @param {Function} [opts.log]
   * @param {number} [opts.timeoutMs]     **普通**工具的单次调用超时（默认 60 秒）
   * @param {number} [opts.maxCallMs]     单次工具调用的**硬上限**（长轮询工具也不能超过它）。
   *   默认 725000 = MCP server 侧的上限；桥接会把"整轮预算 − 30 秒"传进来，避免出现
   *   "客户端还在等、整轮已经超时"的糊涂账。
   */
  constructor(opts = {}) {
    this.root = opts.root;
    if (!this.root) throw new Error('McpToolProvider 需要 root');
    this.servers = opts.servers ?? DEFAULT_MCP_SERVERS;
    // 排除名单：**不是所有模式下都该把全部工具给模型**。
    // 最典型的例子：chat 模式下桥接会**自动转发** AI 的文本回复，此时若再给它
    // qq_send_message 之类的发送类工具，它会自己又发一次 → 群里出现重复消息。
    this.exclude = new Set(opts.exclude ?? []);
    this.log = opts.log ?? (() => {});
    // ⚠️ 这两个值以前是**死参数/不存在的值**：timeoutMs 存下来却从没传给 SDK，
    //    而 SDK 自己的默认超时是 60 秒 —— 于是"合法等 300 秒"的工具必然被掐（见 planToolCallTimeout 注释）。
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000;
    this.maxCallMs = Number(opts.maxCallMs) > 0 ? Number(opts.maxCallMs) : 725_000;

    /** name -> { client, serverName, rawName } */
    this.byName = new Map();
    /** 已连接的 client（关闭时要逐个关） */
    this.clients = [];
    this.openAiTools = null;
    this.started = false;
  }

  /**
   * 拉起全部 server 并建索引。
   * **单个 server 起不来不影响其它** —— 记日志跳过即可；工具少几个比整个运行时不可用强。
   */
  async start() {
    if (this.started) return this.snapshot();
    const failed = [];

    for (const s of this.servers) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(this.root, s.script)],
        cwd: this.root,
        stderr: 'ignore'   // 子进程的 stderr 不往我们这边灌，避免污染桥接日志
      });
      const client = new Client({ name: 'qq-bridge-direct', version: '1.0.0' });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        let added = 0;
        let collided = 0;
        for (const t of tools) {
          // 工具名冲突时**不让后者静默覆盖前者** —— 那会让模型调用到一个完全不同的工具。
          // 冲突就跳过并报出来（三个 server 目前无冲突，实测 38 个名字唯一）。
          if (this.byName.has(t.name)) {
            collided += 1;
            this.log(`[tools] ⚠️ 工具名冲突，跳过：${t.name}（来自 ${s.name}）`);
            continue;
          }
          this.byName.set(t.name, { client, serverName: s.name, rawName: t.name, def: t });
          added += 1;
        }
        this.clients.push(client);
        this.log(`[tools] ${s.name}: ${added} 个工具${collided ? `（跳过 ${collided} 个重名）` : ''}`);
      } catch (error) {
        failed.push(`${s.name}: ${error?.message ?? error}`);
        this.log(`[tools] ⚠️ ${s.name} 启动失败，跳过：${error?.message ?? error}`);
        try { await client.close(); } catch { /* 忽略 */ }
      }
    }

    this.started = true;
    if (this.byName.size === 0) {
      this.log('[tools] ❌ 没有任何 MCP 工具可用 —— AI 将无法收发消息/出图（检查 src/mcp-*.js 能否独立启动）');
    }
    return { ...this.snapshot(), failed };
  }

  snapshot() {
    return { tools: this.byName.size, servers: this.clients.length, failed: [] };
  }

  /**
   * 转成 OpenAI 的 tools[] 格式。内容原样复用，只加外壳。被排除的工具不出现。
   *
   * @param {object} [opts]
   * @param {string[]} [opts.extraExclude] **只在这一次调用里**额外排除的工具名（不写进 this.exclude）。
   *   ⚠️ 为什么需要它：`this.exclude` 是 provider 级全局状态，而"这种回合不给发送类工具"是
   *   **按回合**的（典型：reserved2 的收尾提醒回合——那一轮只该做收尾，不该再发言）。
   *   用全局 setExclude 会顺带把同一时刻正在跑的其它会话也阉掉发送能力。
   *   不传 extraExclude 时仍返回**缓存的那个数组本身**，保持调用方"同一引用 = 命中缓存"的语义。
   */
  listOpenAiTools(opts = {}) {
    const base = this._baseOpenAiTools();
    const extra = Array.isArray(opts.extraExclude) ? opts.extraExclude : [];
    if (extra.length === 0) return base;
    const drop = new Set(extra);
    return base.filter((t) => !drop.has(t.function?.name));
  }

  _baseOpenAiTools() {
    if (this.openAiTools) return this.openAiTools;
    const all = [...this.byName.values()];
    const kept = all.filter(({ def }) => !this.exclude.has(def.name));
    const dropped = all.length - kept.length;
    if (dropped > 0) {
      this.log(`[tools] 按模式排除 ${dropped} 个工具：${[...this.exclude].filter((n) => this.byName.has(n)).join(', ')}`);
    }
    this.openAiTools = kept.map(({ def }) => ({
      type: 'function',
      function: {
        name: def.name,
        description: def.description ?? '',
        parameters: def.inputSchema ?? { type: 'object', properties: {} }
      }
    }));
    return this.openAiTools;
  }

  /**
   * 运行时改排除名单（**模式会变**：chat 与 reserved2 对"发送类工具"的要求是相反的）。
   * 会清掉缓存，下次 listOpenAiTools() 重新计算。
   */
  setExclude(names) {
    const next = new Set(names ?? []);
    if (next.size === this.exclude.size && [...next].every((n) => this.exclude.has(n))) return false;
    this.exclude = next;
    this.openAiTools = null;
    return true;
  }

  has(name) {
    return this.byName.has(name) && !this.exclude.has(name);
  }

  /**
   * 调一个工具。**不抛异常**（与 DirectRuntime.send 一致，让调用方能继续循环）。
   * 返回 { ok, text, images, imageParts, error }：
   *   · text       —— 文本块拼起来的内容（喂给模型的 tool 消息）
   *   · images     —— 图片块数量
   *   · imageParts —— [{ mediaType, data(base64) }]，交给 DirectRuntime 补一条带图的 user 消息
   *                   （OpenAI 的 tool 消息装不下图片。以前这里只数一下图片数、回一句"不支持"，
   *                    结果 qq_get_message_images 形同虚设 —— 2026-09-26 修正）
   */
  async callTool(name, args = {}, { signal } = {}) {
    const entry = this.byName.get(name);
    if (!entry) return { ok: false, error: `未知工具：${name}` };

    // ★ 每次调用都要**显式**告诉 SDK 它能等多久（不传 = 它自己的 60 秒默认值）。
    const plan = planToolCallTimeout(name, args, { defaultMs: this.timeoutMs, maxMs: this.maxCallMs });
    if (plan.refused) {
      // 注定塞不进整轮预算的等待：**不发请求**，直接给出可执行的错误（比 -32001 有用得多）。
      this.log(`[tools] 拒绝 ${name}：${plan.reason}`);
      return { ok: false, error: `工具 ${name} 未执行：${plan.reason}` };
    }

    try {
      // 第三个参数是 MCP 的请求选项，`timeout` 就是**这一次请求**的超时。
      const call = entry.client.callTool({ name: entry.rawName, arguments: args ?? {} }, undefined, {
        timeout: plan.timeoutMs
      });
      const result = signal
        ? await Promise.race([
          call,
          new Promise((_, rej) => {
            if (signal.aborted) rej(new Error('已取消'));
            else signal.addEventListener('abort', () => rej(new Error('已取消')), { once: true });
          })
        ])
        : await call;

      const blocks = Array.isArray(result?.content) ? result.content : [];
      const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
      // 图片块：**数据本身要带出去**。OpenAI 的 tool 消息装不下图片，所以由 DirectRuntime
      // 在工具结果之后补一条 user 消息（image_url）—— 见 direct.js 的工具循环。
      const imageParts = blocks
        .filter((b) => b?.type === 'image' && typeof b.data === 'string' && b.data)
        .map((b) => ({ mediaType: b.mimeType || 'image/png', data: b.data }));
      const images = imageParts.length;
      let text = texts.join('\n');
      if (images > 0) text += `\n（本次工具还返回了 ${images} 张图片，随后会以图片形式交给模型看。）`;
      if (!text) text = '（工具没有返回文本内容）';
      if (result?.isError) return { ok: false, text, images, imageParts, error: text };
      return { ok: true, text, images, imageParts };
    } catch (error) {
      // 超时的措辞要能自证原因：SDK 的原文只有一句 "MCP error -32001: Request timed out"，
      // 排查时看不出"是我给的时间不够"还是"服务端真的挂了"，所以附上本次给的预算。
      const isTimeout = Number(error?.code) === -32001 || /timed out/i.test(String(error?.message ?? ''));
      const detail = isTimeout
        ? `${error?.message ?? error}（本次给它的预算是 ${Math.round(plan.timeoutMs / 1000)} 秒`
          + `${plan.neededMs ? `，它自己要等约 ${Math.ceil(plan.neededMs / 1000)} 秒` : ''}）`
        : (error?.message ?? error);
      return { ok: false, error: `工具 ${name} 调用失败：${detail}` };
    }
  }

  async close() {
    for (const c of this.clients) {
      try { await c.close(); } catch { /* 忽略 */ }
    }
    this.clients = [];
    this.byName.clear();
    this.openAiTools = null;
    this.started = false;
  }
}
