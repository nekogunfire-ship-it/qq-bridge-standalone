// direct 运行时：直接对接**标准 AI API**（OpenAI 兼容），不需要 DSH。
//
// 存在的理由（用户要求）：分发包要发给别人用，安装时应让用户选是否装 DSH；
// **不装 DSH 也必须能完整运行** —— 所以除 DSH 之外必须有一条自己的 LLM 通道。
//
// 与 DSH 路径的关键差别（这决定了这个文件能这么短）：
//   DSH：prompt → 事件流（turn/start / assistant/message / turn/end）→ createTurnCollector 攒文本
//   direct：一次 HTTP 请求 → 直接拿到完整文本
//   也就是说 DSH 那套「会话订阅 + 事件流 + 回合收集」在 direct 下**整个不需要**。
//
// 本文件只负责"文本进、文本出"。**工具调用循环是下一步**（那时才需要处理 tool_calls）。
//
// 用法：
//   const rt = new DirectRuntime({ baseUrl, apiKey, model, systemPrompt });
//   const r = await rt.send({ key: 'group:123', text: '你好' });
//   // r = { ok: true, text: '…', usage: {...} } 或 { ok: false, error: '…' }

/** 默认的会话历史保留轮数（一问一答算一轮）。目的：控制请求体大小与成本。 */
const DEFAULT_MAX_TURNS = 20;

/**
 * **单次模型请求**的默认超时（不含工具执行时间）。LLM 首字可能慢，但一次请求不该无限等。
 * ⚠️ 2026-09-26 修正：这个值曾被当成"整轮（含工具循环）"的超时用 —— 于是
 * qq_wait_for_messages 这种真实长轮询（30~300 秒）会把整轮预算吃光，AI 按操作规程做
 * 「5 分钟沉睡前观察」时**必然**超时（实测一晚连撞 4 次「请求超时（120000ms）」）。
 * 现在：单次请求用它计时，整轮另有 turnTimeoutMs 兜底。
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 整轮（含工具循环）的默认保险上限。必须远大于单次请求超时 —— QQ 侧的"沉睡前观察"会真实等 5 分钟。 */
const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/** 工具循环的默认上限轮数。防"模型反复调同一个工具"把请求拖死。 */
const DEFAULT_MAX_TOOL_ROUNDS = 8;

/**
 * 单张图片塞进请求体的上限（base64 字符数 ≈ 15MB 原始数据）。超了就跳过（并在消息里明说），
 * 免得模型以为图已经给它了。实测端点收 12.4MB 的 base64 没问题（HTTP 200 / 3.3s），
 * 而图片 token 是按尺寸折算、且有上限（~1k），所以大图贵的是**带宽**不是上下文。
 */
const MAX_INLINE_IMAGE_CHARS = 20_000_000;

// 工具循环会请求模型多次。服务商每次只返回本次请求的 usage，因此必须逐轮相加，
// 否则计费界面只看到最后一轮，系统性低估成本。
function mergeTokenUsage(a = {}, b = {}) {
  const input = (u) => Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const output = (u) => Number(u.completion_tokens ?? u.output_tokens) || 0;
  const cached = (u) => Number(u.prompt_tokens_details?.cached_tokens
    ?? u.input_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens) || 0;
  const promptTokens = input(a) + input(b);
  const completionTokens = output(a) + output(b);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: (Number(a.total_tokens) || input(a) + output(a))
      + (Number(b.total_tokens) || input(b) + output(b)),
    prompt_tokens_details: { cached_tokens: cached(a) + cached(b) }
  };
}

/**
 * 把 { mediaType, data } 形式的图片转成 OpenAI 的 image_url 内容块。
 * 用 **data URI**（不外链）：不依赖 QQ 图床可达，也不给桥接开一条新的 SSRF 面。
 *
 * 返回 { parts, skipped }：超过内联上限的图片**记数**，由调用方在文本里说清楚
 * （静默丢图会让模型"看不见却以为看得见"，比报错更糟）。
 */
function toImageUrlParts(images) {
  const list = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.data === 'string' && i.data);
  const parts = [];
  let skipped = 0;
  for (const i of list) {
    if (i.data.length > MAX_INLINE_IMAGE_CHARS) { skipped += 1; continue; }
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${i.mediaType || 'image/png'};base64,${i.data}` }
    });
  }
  return { parts, skipped };
}

export class DirectRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl    形如 https://api.deepseek.com/v1（**不要**带 /chat/completions）
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {string} [opts.systemPrompt]  人设正文（由调用方从 roles/*.md 读好传进来）
   * @param {number} [opts.maxTurns]
   * @param {number} [opts.temperature]
   * @param {number} [opts.timeoutMs]      单次模型请求的超时（不含工具执行时间）
   * @param {number} [opts.turnTimeoutMs]  整轮（含工具循环）保险上限，0 = 不限
   * @param {boolean} [opts.vision]  是否把图片交给模型（false = 纯文本，默认开）
   * @param {boolean} [opts.stream]  首版默认 false：整段返回更好调试；SSE 留给工具循环那步
   * @param {Function} [opts.fetchImpl] 便于测试注入
   * @param {Function} [opts.log]
   */
  constructor(opts = {}) {
    if (!opts.baseUrl) throw new Error('DirectRuntime 需要 baseUrl');
    if (!opts.model) throw new Error('DirectRuntime 需要 model');

    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? '';
    this.maxTurns = Number(opts.maxTurns) > 0 ? Number(opts.maxTurns) : DEFAULT_MAX_TURNS;
    this.temperature = typeof opts.temperature === 'number' ? opts.temperature : undefined;
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    // 0 = 显式关掉整轮保险；不填/非法值 → 用默认
    this.turnTimeoutMs = opts.turnTimeoutMs === 0
      ? 0
      : (Number(opts.turnTimeoutMs) > 0 ? Number(opts.turnTimeoutMs) : DEFAULT_TURN_TIMEOUT_MS);
    this.maxToolRounds = Number(opts.maxToolRounds) > 0 ? Number(opts.maxToolRounds) : DEFAULT_MAX_TOOL_ROUNDS;
    this.stream = opts.stream === true;
    // 视觉开关：false 时 _userMessage 忽略 images、工具图片也不再补 user 消息 ——
    // 给"图片太费 token / 不想让它看图"留的闸（桥接侧由 runtime.images=false 控制）。
    this.vision = opts.vision !== false;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.log = opts.log ?? (() => {});

    /** key(会话) -> [{role,content}, …]。direct 模式下这就是"上下文"。 */
    this.histories = new Map();
    /** key -> AbortController，用于取消正在跑的回合 */
    this.inflight = new Map();
  }

  /** 供自检/日志用：现在有几个会话、共多少条历史 */
  stats() {
    let messages = 0;
    for (const h of this.histories.values()) messages += h.length;
    return { conversations: this.histories.size, messages, inflight: this.inflight.size };
  }

  /** 清掉某个会话的历史（等价于 DSH 的 session/reset） */
  reset(key) {
    return this.histories.delete(key);
  }

  /** 取消某个会话正在跑的请求（等价于 DSH 的 stopSessionWork） */
  abort(key) {
    const c = this.inflight.get(key);
    if (!c) return false;
    c.abort();
    return true;
  }

  _history(key) {
    if (!this.histories.has(key)) this.histories.set(key, []);
    return this.histories.get(key);
  }

  /** 组装发给 API 的 messages：system(人设) + 有界历史 + 本条 */
  buildMessages(key, text, images) {
    const msgs = [];
    // systemPrompt 允许是**函数**：桥接里角色可被切换（/role 命令 + 管理端写 state/current-role.json），
    // 用函数就能每次取到最新人设，而不必在角色切换时重建 runtime。
    const sp = typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt;
    if (sp) msgs.push({ role: 'system', content: String(sp) });
    msgs.push(...this._history(key));
    msgs.push(this._userMessage(text, images));
    return msgs;
  }

  /**
   * 一条 user 消息：**纯文本时仍是字符串**（老格式不变），带图片时才变成多模态数组
   * （text + image_url(data URI)）。
   *
   * 图片只活在**这一次请求**里、不进 history —— 否则历史里那张图每轮都要重发一遍 token。
   */
  _userMessage(text, images) {
    const { parts, skipped } = this.vision === false ? { parts: [], skipped: 0 } : toImageUrlParts(images);
    let body = String(text ?? '');
    if (skipped > 0) {
      body += `\n（其中 ${skipped} 张图超过内联上限、没有附上 —— 如果有人问的是它，就直接说这张图太大看不到，别猜。）`;
    }
    if (parts.length === 0) return { role: 'user', content: body };
    return { role: 'user', content: [{ type: 'text', text: body }, ...parts] };
  }

  /** 把本轮记进历史，并按 maxTurns 裁剪（一问一答 = 2 条） */
  _remember(key, userText, assistantText) {
    const h = this._history(key);
    h.push({ role: 'user', content: String(userText ?? '') });
    if (assistantText) h.push({ role: 'assistant', content: String(assistantText) });
    const limit = this.maxTurns * 2;
    if (h.length > limit) h.splice(0, h.length - limit);
  }

  /**
   * 发一轮，拿回文本。带工具时会**自动跑工具循环**。
   *
   * **不抛异常** —— 一律返回 { ok:false, error }，让调用方（桥接）决定怎么处置，
   * 因为桥接的错误处理是"记日志 + 继续服务"，抛异常会打断事件流。
   *
   * @param {object} opts
   * @param {string} opts.key
   * @param {string} opts.text
   * @param {Array<{mediaType:string,data:string}>} [opts.images]  随本条 user 消息一起发的图片（base64）
   * @param {Array} [opts.tools]       OpenAI tools[] 格式（由 McpToolProvider.listOpenAiTools() 产出）
   * @param {Function} [opts.toolRunner]  async (name, args) => { ok, text, error }
   * @param {number} [opts.maxToolRounds]
   * @param {AbortSignal} [opts.signal]
   */
  async send({ key = 'default', text, images, tools, toolRunner, maxToolRounds, signal } = {}) {
    const messages = this.buildMessages(key, text, images);

    const controller = new AbortController();
    this.inflight.set(key, controller);
    // 外部 signal（比如桥接要提前取消）与内部超时都并到同一个 controller 上
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    // ⚠️ 必须**带 reason** 调 abort：不带参数时 `signal.reason` 是默认的 AbortError
    //    DOMException，永远判不出"这次是超时还是被取消"（实测就是这样丢掉了超时语义）。
    //
    // 超时分两级（2026-09-26 修正，见 DEFAULT_TIMEOUT_MS 注释）：
    //   · 单次模型请求的超时在 _chat() 里逐次开关（reason='request-timeout'），工具执行时间不算它的；
    //   · 这里只挂**整轮保险**（reason='turn-timeout'）：从 send() 起算、整轮只关一次，
    //     给"一轮里跑很多次工具"兜底。沉睡前观察要真实等 5 分钟，所以它默认 10 分钟。
    const turnTimer = this.turnTimeoutMs > 0
      ? setTimeout(() => controller.abort('turn-timeout'), this.turnTimeoutMs)
      : null;

    const useTools = Array.isArray(tools) && tools.length > 0 && typeof toolRunner === 'function';
    const maxRounds = Number(maxToolRounds) > 0 ? Number(maxToolRounds) : this.maxToolRounds;
    let usageTotal = null;
    let rounds = 0;
    let toolCallsMade = 0;

    try {
      // ── 工具循环 ──────────────────────────────────────────────────────────
      // 与 DSH 的差别：DSH 靠事件流"回合"驱动（turn/start → tool → turn/end，还可能卡住不发 end），
      // 这里就是**普通的请求-响应循环**，要么正常结束要么抛错 —— 不存在"回合永远不结束"。
      for (;;) {
        rounds += 1;
        const r = await this._chat(messages, useTools ? tools : null, controller);
        if (!r.ok) {
          // 已经跑过的工具不回滚（消息确实发出去了），但要把失败如实报出来
          return {
            ...r,
            partialText: null,
            rounds,
            toolCalls: toolCallsMade
          };
        }
        if (r.usage) usageTotal = usageTotal ? mergeTokenUsage(usageTotal, r.usage) : r.usage;

        const calls = r.message?.tool_calls;
        if (!Array.isArray(calls) || calls.length === 0) {
          // 没有工具调用 = 这一轮就是最终回复
          const finalText = typeof r.message?.content === 'string' ? r.message.content : '';
          this._remember(key, text, finalText);
          return {
            ok: true,
            text: finalText,
            usage: usageTotal,
            model: r.model ?? this.model,
            rounds,
            toolCalls: toolCallsMade
          };
        }

        if (rounds > maxRounds) {
          // 达到上限：**不再整轮报错**，改成最后一轮"收尾请求"。
          // 旧行为是 return ok:false（"工具调用超过 N 轮仍未结束"）—— 可这一轮的消息**早就通过
          // qq_send_message 发出去了**，报错只会在 QQ 里多一条「⚠️ 消息未能送达 AI：…」，
          // 群友看到就会以为机器人坏了（实测 2026-09-26 23:11/23:17 忙群连撞两次）。
          // 现在：不带工具再问一次，让模型用手里已有的信息自然收尾，这一轮按**成功**计。
          this.log(`[direct] ${key} 工具循环达到上限（${maxRounds} 轮），改用收尾请求让模型结束`);
          const wrap = await this._chat([
            ...messages,
            {
              role: 'user',
              content: `（系统提示）本轮工具调用已达上限（${maxRounds} 轮），请不要再调用任何工具，`
                + '直接用一两句话自然收尾；还需要观察或收尾的动作，留给下一次唤醒。'
            }
          ], null, controller);
          if (!wrap.ok) {
            // 只有收尾请求本身失败（网络/超时）才报错 —— 这时确实没拿到收尾文本
            this._remember(key, text, '');
            return {
              ok: false,
              error: `工具调用超过 ${maxRounds} 轮，收尾请求也失败：${wrap.error}`,
              rounds,
              toolCalls: toolCallsMade,
              aborted: wrap.aborted === true
            };
          }
          const wrapText = typeof wrap.message?.content === 'string' ? wrap.message.content : '';
          if (Array.isArray(wrap.message?.tool_calls) && !wrapText) {
            // 个别模型不看提示词、收尾轮还想调工具：**不执行**它，记一笔日志后照样收尾
            this.log(`[direct] ${key} 收尾请求里模型仍要调工具（已忽略），本轮按收尾结束`);
          }
          this._remember(key, text, wrapText);
          return {
            ok: true,
            text: wrapText,
            usage: wrap.usage ? (usageTotal ? mergeTokenUsage(usageTotal, wrap.usage) : wrap.usage) : usageTotal,
            model: wrap.model ?? this.model,
            rounds: rounds + 1,
            toolCalls: toolCallsMade,
            cappedAt: maxRounds
          };
        }

        // assistant 的 tool_calls 消息必须原样回填，否则下一次请求会因"tool 消息没有对应的
        // tool_calls"被服务端拒绝（这是 OpenAI 协议的硬要求，很多 400 都来自这里）
        messages.push({
          role: 'assistant',
          content: r.message.content ?? null,
          tool_calls: calls
        });

        // 工具返回的图片**先收集**，等整块 tool 消息补齐后再补一条 user 消息（见循环之后）。
        const imageBatch = [];
        for (const call of calls) {
          toolCallsMade += 1;
          const name = call?.function?.name ?? '';
          let args = {};
          try {
            args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch (e) {
            // 模型给的参数不是合法 JSON —— 把错误当工具结果回灌，让它自己改
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: `参数不是合法 JSON：${e?.message ?? e}。原始内容：${String(call?.function?.arguments).slice(0, 200)}`
            });
            continue;
          }
          this.log(`[direct] ${key} 调用工具 ${name}(${Object.keys(args).join(',')})`);
          let out;
          try {
            out = await toolRunner(name, args);
          } catch (e) {
            out = { ok: false, error: `工具执行抛异常：${e?.message ?? e}` };
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: out?.ok === false
              ? `（工具报错）${out.error ?? out.text ?? '未知错误'}`
              : String(out?.text ?? '')
          });
          // 工具返回的图片（典型：qq_get_message_images）：OpenAI 协议的 tool 消息**装不下图片**，
          // 标准做法是补一条 user 消息把 image_url 塞进去。**但这一条绝不能补在这里** ——
          // 见下面循环外的说明，这里只收集。
          if (this.vision !== false && out?.ok !== false
              && Array.isArray(out?.imageParts) && out.imageParts.length > 0) {
            imageBatch.push({ name, parts: out.imageParts });
          }
        }

        // ⚠️ 工具图片统一在这里补，**一轮只补一条**。
        // 逐条补（旧写法）在"模型并行调多个看图工具"时会拼出：
        //   assistant(tool_calls=[c1,c2]) → tool(c1) → user(图) → tool(c2) → user(图)
        // 中间那条 user 把 tool 消息块**切断**了，服务端只认到 c1，整条请求被拒：
        //   HTTP 400: An assistant message with 'tool_calls' must be followed by tool messages
        //   responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
        // 2026-09-27 00:55 起实测三个群连撞 7 次（群里只看到「⚠️ 消息未能送达 AI：HTTP 400 …」，
        // 那一轮 AI 彻底没有回复）。收集后合并成一条、跟在最后一条 tool 消息之后，形状才合法 ——
        // 同一天对真实端点实测：旧形状 400，新形状 HTTP 200 且能说清两张图各自的内容。
        if (imageBatch.length > 0) {
          const parts = imageBatch.flatMap((b) => b.parts);
          messages.push(this._userMessage(
            `（工具 ${imageBatch.map((b) => b.name).join('、')} 返回的图片，共 ${parts.length} 张）`,
            parts
          ));
        }
      }
    } catch (error) {
      return { ok: false, error: `请求失败：${error?.message ?? error}`, rounds, toolCalls: toolCallsMade };
    } finally {
      if (turnTimer) clearTimeout(turnTimer);
      // 只清掉"还是自己"的那个 controller，避免把后来者的登记误删
      if (this.inflight.get(key) === controller) this.inflight.delete(key);
    }
  }

  /**
   * 单次 HTTP 请求（工具循环的一步）。返回 { ok, message, usage, model } 或 { ok:false, error }。
   * 抽出来是为了让循环逻辑与传输逻辑分开 —— 循环只关心"有没有 tool_calls"。
   */
  async _chat(messages, tools, controller) {
    // 单次请求的超时：进函数开、出函数清 —— 于是"工具等了 5 分钟"不再算到它头上，
    // 但整轮排太久的仍会被 send() 的 turnTimer 兜住。
    const requestTimer = setTimeout(() => controller.abort('request-timeout'), this.timeoutMs);
    try {
      const body = { model: this.model, messages, stream: false };
      if (this.temperature !== undefined) body.temperature = this.temperature;
      if (tools) {
        body.tools = tools;
        // 'auto'：由模型决定这轮要不要用工具（不强制，避免纯聊天也硬调工具）
        body.tool_choice = 'auto';
      }

      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await res.text();
      if (!res.ok) {
        // 把服务端的错误信息原样带出来 —— 否则用户只看到 "HTTP 401" 无从下手
        let detail = raw.slice(0, 400);
        try { detail = JSON.parse(raw)?.error?.message ?? detail; } catch { /* 非 JSON 就用原文 */ }
        return { ok: false, error: `HTTP ${res.status}: ${detail}`, status: res.status };
      }

      let json = null;
      try { json = JSON.parse(raw); } catch {
        return { ok: false, error: `返回的不是 JSON：${raw.slice(0, 200)}` };
      }

      const message = json?.choices?.[0]?.message;
      if (!message || typeof message !== 'object') {
        return { ok: false, error: `返回结构里没有 choices[0].message：${raw.slice(0, 200)}` };
      }
      // content 可以是 null（纯工具调用时），但两者不能都空
      if (typeof message.content !== 'string' && !Array.isArray(message.tool_calls)) {
        return { ok: false, error: `choices[0].message 既没有 content 也没有 tool_calls：${raw.slice(0, 200)}` };
      }
      return { ok: true, message, usage: json?.usage ?? null, model: json?.model ?? this.model };
    } catch (error) {
      // 先看 signal —— abort 的原因决定了措辞，而 fetch 在"带 reason 的 abort"下
      // 抛的不一定是 AbortError（可能是 reason 本身），所以不能靠 error.name 判。
      if (controller.signal.aborted) return this._abortResult(controller);
      // 网络类失败时 `error.message` 往往只有一句 "fetch failed"，看不出到底怎么了。
      // 真正的原因在 `error.cause` 里（ECONNREFUSED / ENOTFOUND / 证书错误…）——
      // 用户排查"连不上 API"时这两者的区别是决定性的，必须带出来。
      const cause = error?.cause;
      const causeCode = String(cause?.code ?? '');
      const causeText = cause
        ? `（${causeCode || cause.name || 'cause'}${cause.message ? `: ${String(cause.message).slice(0, 120)}` : ''}）`
        : '';

      // 证书类失败单独给一条**可操作的**提示。
      // 实测背景（2026-09-26）：本机有安全软件在做 HTTPS 拦截，它的根证书在 **Windows 证书存储**里、
      // 但**不在 Node 自带的那 150 个**里 —— 于是 Node 默认不信任它，偶发报
      // SELF_SIGNED_CERT_IN_CHAIN。同一台机器上 DSH 之所以从不撞到，是因为它的环境里带着
      // NODE_OPTIONS=--use-system-ca（实测根证书从 150 变成 257，含系统存储）。
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/i.test(causeCode) || /certificate/i.test(String(error?.message))) {
        return {
          ok: false,
          error: `请求失败：${error?.message ?? error}${causeText}`,
          // hint 只进日志，**不进 QQ 消息**（群聊里贴一段操作说明很奇怪）
          hint: '这是证书信任问题：有安全软件/代理在做 HTTPS 拦截，它的根证书在 Windows 存储里、'
            + '而 Node 默认只用自带的证书库。解决办法二选一：\n'
            + '  · 简单：让桥接带 --use-system-ca 启动（例如 NODE_OPTIONS=--use-system-ca，'
            + '或 node --use-system-ca src/bridge.js）；实测这样根证书从 150 增到 257\n'
            + '  · 或者：在该安全软件里把 api 域名加入"不扫描加密连接"的白名单\n'
            + '（此错误是偶发的 —— 不拦截的那些请求不受影响）'
        };
      }
      return { ok: false, error: `请求失败：${error?.message ?? error}${causeText}` };
    } finally {
      clearTimeout(requestTimer);
    }
  }

  /**
   * signal 被中止时的统一返回：把"整轮超时 / 单次请求超时 / 被取消"三种原因分开说清楚
   * （外部 abort()/signal 取消时 reason 是默认的 AbortError → 仍是"请求被取消"）。
   */
  _abortResult(controller) {
    const reason = controller.signal.reason;
    if (reason === 'turn-timeout') {
      return { ok: false, error: `整轮超时（${Math.round(this.turnTimeoutMs / 1000)} 秒未收尾）`, aborted: true };
    }
    if (reason === 'request-timeout') {
      return { ok: false, error: `请求超时（${this.timeoutMs}ms）`, aborted: true };
    }
    return { ok: false, error: '请求被取消', aborted: true };
  }
}

/** 便于自检与配置向导：判断这份配置看起来能不能用（不发请求） */
export function describeDirectConfig(rt) {
  if (!rt) return '未配置';
  const masked = rt.apiKey ? `${rt.apiKey.slice(0, 4)}…（${rt.apiKey.length} 字符）` : '（未填 apiKey）';
  const spKind = typeof rt.systemPrompt === 'function'
    ? '人设=动态（函数）'
    : (rt.systemPrompt ? `人设=${rt.systemPrompt.length} 字` : '人设=（无）');
  const turn = rt.turnTimeoutMs > 0 ? `${Math.round(rt.turnTimeoutMs / 1000)}s` : '不限';
  return `${rt.baseUrl} · model=${rt.model} · key=${masked} · ${spKind} · 历史上限 ${rt.maxTurns} 轮 · ${
    rt.stream ? '流式' : '非流式'} · 单次请求超时 ${Math.round(rt.timeoutMs / 1000)}s · 整轮上限 ${turn} · 工具轮上限 ${rt.maxToolRounds}`;
}
