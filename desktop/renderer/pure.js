/* 渲染层用到的**纯函数**（无 DOM、无副作用）。
 *
 * 为什么单独成文件：这些函数是"把桥接的数据翻译成人话"的地方，也正是最容易写错的地方 ——
 * 我第一版就把消息时间字段猜成了 `at`（实际是 `time`）、把操作时间线当成了对象数组
 * （实际是字符串数组）。抽出来之后 Node 可以直接 require 它做单元测试，
 * 不用起 Electron。
 *
 * 用 UMD 外壳：浏览器里挂到 window.RendererPure，Node 里走 module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RendererPure = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* 操作时间线的行格式（见 desktop/lib/lifecycle-log.js 写入侧）：
   *   2026-09-26T11:13:27.204Z [restartBridgeOnly] 结束（成功，总耗时 5.3s）
   *   2026-09-26T11:13:27.204Z [restartBridgeOnly]   +5.3s launcher 已返回
   * 只取「结束（…）」这类每次动作一条的汇总行；逐步骤的 `+X.Xs` 行太碎。
   */
  const LINE_RE = /^(\S+)\s+\[([^\]]+)\]\s+(.*)$/;

  function parseLifecycleLines(lines) {
    const out = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      const m = String(line).match(LINE_RE);
      if (!m) continue;
      const [, iso, action, message] = m;
      if (!/结束（/.test(message) && !/^\s*开始\s*$/.test(message)) continue;
      out.push({ at: iso, action, message: message.trim() });
    }
    return out;
  }

  function isLifecycleSuccess(message) {
    return /结束（成功/.test(String(message));
  }

  const ACTION_LABEL = {
    startAll: '启动全部服务',
    stopAll: '停止全部服务',
    restartAll: '重启全部',
    restartBridgeOnly: '重启桥接'
  };

  function friendlyAction(name) {
    const n = String(name ?? '');
    if (ACTION_LABEL[n]) return ACTION_LABEL[n];
    if (n.startsWith('watchdog:')) {
      const inner = n.slice('watchdog:'.length);
      return `看门狗自动${ACTION_LABEL[inner] ?? inner}`;
    }
    return n || '（未知动作）';
  }

  /* 把唤醒配置压成一句人话：让人一眼看懂"什么情况下它会开口" */
  function describeTriggers(wakeConfig) {
    const t = wakeConfig?.triggers ?? {};
    const bits = [];
    if (t.atMention) bits.push('@');
    if (t.nameMention) bits.push('名字');
    if (t.question) bits.push('提问');
    if (t.poke) bits.push('拍一拍');
    if (Array.isArray(t.keywords) && t.keywords.length) bits.push(`关键词×${t.keywords.length}`);
    if (typeof t.probability === 'number' && t.probability > 0) bits.push(`概率 ${t.probability}`);
    if (t.anyMessage) bits.push('任意消息');
    if (Array.isArray(t.speakerIds) && t.speakerIds.length) bits.push(`指定成员×${t.speakerIds.length}`);
    return bits.length ? bits.join(' · ') : '（无触发条件：只有手动唤醒才会回）';
  }

  function convKindLabel(key) {
    const k = String(key ?? '');
    if (k.startsWith('group:')) return `群 ${k.slice(6)}`;
    if (k.startsWith('private:')) return `私聊 ${k.slice(8)}`;
    return k;
  }

  function relTime(ms, now = Date.now()) {
    if (!ms) return '（还没回过）';
    const diff = now - Number(ms);
    if (diff < 0) return '刚刚';
    if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
    return `${Math.round(diff / 86_400_000)} 天前`;
  }

  const WAKE_MODE_LABEL = { diving: '💤 潜水', active: '🟢 活跃' };
  const WAKE_REASON_LABEL = {
    probability: '概率命中', question: '被提问', atMention: '被 @', nameMention: '被叫名字',
    keyword: '关键词', poke: '拍一拍', anyMessage: '任意消息', speaker: '指定成员'
  };

  function wakeModeLabel(mode) {
    return WAKE_MODE_LABEL[mode] ?? (mode || '—');
  }

  function wakeReasonLabel(reason) {
    return WAKE_REASON_LABEL[reason] ?? (reason || '—');
  }

  /* 消息 → 展示用的一行（字段形状实测自 /api/socialV2/recent） */
  function describeMessage(m) {
    const who = m.isSelf ? '🤖 AI（我）' : (m.sender || (m.userId ? `QQ ${m.userId}` : '系统'));
    let text = String(m.text ?? m.plain ?? '').trim();
    if (!text && m.hasMedia) text = '（图片 / 表情等非文本消息）';
    if (!text && m.hasForward) text = '（合并转发消息）';
    if (!text) text = '（空消息）';
    const badges = [
      m.isOwner ? '管理员' : null,
      m.hasMedia ? '含媒体' : null,
      m.hasForward ? '含转发' : null
    ].filter(Boolean).join(' · ');
    return { who, text, badges, time: m.time ? Number(m.time) : null };
  }

  function escapeHtml(s) {
    return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  /* ── 活动流（/api/status 的 activity 字段）─────────────────────────────────
   * 原样是一坨纯文本，直接 <pre> 显示的话"直观清晰"达不到。这里把它拆成结构化的行。
   *
   * 行格式**实测自真实活动流**（100 行归纳出来的三种形状）：
   *   [14:47:19] group:200000002 [reserved2] 消息已入未读：这个你问别人可能更靠谱。   ← 95 行
   *   [14:48:04] group:200000002 [reserved2] 工具统一发送：成功 2/2 条              ←  4 行
   *   [14:48:27] group:200000002 拍一拍事件：…                                     ←  1 行（**没有 [模式]**）
   * 所以 [模式] 那一段必须可选，否则最后一种会被整行当成正文。
   */
  const ACT_LINE_RE = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*([\s\S]*)$/;
  const ACT_HEAD_RE = /^(?:(group|private):(\d+)\s+)?(?:\[([^\]]+)\]\s+)?([\s\S]*)$/;

  /** 给一行活动分类，用于着色与筛选 */
  function activityKind(text) {
    const t = String(text ?? '');
    if (/未送达|失败|错误|出错|超时|⚠️|HTTP 4\d\d|HTTP 5\d\d|异常|拒绝/.test(t)) return 'error';
    if (/工具统一发送|已发送|回复已发出|发送成功/.test(t)) return 'send';
    if (/调用工具|工具调用/.test(t)) return 'tool';
    if (/唤醒|wakeConfig|设置唤醒/.test(t)) return 'wake';
    if (/入未读|拍一拍|消息/.test(t)) return 'inbox';
    return 'plain';
  }

  /**
   * 把活动流文本拆成结构化行。
   * 解析不了的行**不丢弃** —— 原样放进 text（宁可显示得朴素，也不要让日志消失）。
   */
  function parseActivityLines(text) {
    const out = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const m = line.match(ACT_LINE_RE);
      if (!m) { out.push({ time: '', scope: '', tag: '', text: line, kind: activityKind(line) }); continue; }
      const [, time, rest] = m;
      const h = rest.match(ACT_HEAD_RE);
      const [, kindRaw, id, tag, body] = h ?? [null, null, null, null, rest];
      const scope = kindRaw ? `${kindRaw === 'group' ? '群' : '私聊'} ${id}` : '';
      const bodyText = (body ?? rest).trim();
      out.push({ time, scope, tag: tag ?? '', text: bodyText || '(空)', kind: activityKind(`${tag ?? ''} ${bodyText}`) });
    }
    return out;
  }

  /** 活动流筛选器（value 为空 = 全部） */
  const ACTIVITY_FILTERS = [
    { value: '', label: '全部' },
    { value: 'send', label: '只看发送' },
    { value: 'error', label: '只看报错' },
    { value: 'wake', label: '只看唤醒' },
    { value: 'inbox', label: '只看收消息' }
  ];

  function filterActivity(rows, filter) {
    if (!filter) return rows;
    return rows.filter((r) => r.kind === filter);
  }

  const ACTIVITY_KIND_LABEL = {
    error: '报错', send: '发送', tool: '工具', wake: '唤醒', inbox: '收消息', plain: '其它'
  };

  /* ── 模型下拉的选项构造（纯函数，可单测）─────────────────────────────────────
   * 抽出来的理由：这**不是**"把数组塞进 select"那么简单，有两个边界必须处理，
   * 而两者都会造成"用户一保存就把模型改掉了"这种静默后果：
   *   ① **接口拉不到列表**（本地 Ollama 未必实现 /models）→ 必须还能手填；
   *   ② **当前配置的模型不在列表里** → 必须仍然把它放进选项并选中
   *      （真实例子：`deepseek-chat` 能用，但 `/models` 不列它）。
   */
  const MODEL_CUSTOM = '__custom__';

  function buildModelOptions(models, cfgModel, runningModel) {
    const given = (Array.isArray(models) ? models : []).filter((m) => typeof m === 'string' && m);
    // 去重 + **保证当前配置的模型一定在列表里**（这就是边界 ②）
    const list = [...new Set([...given, ...(cfgModel ? [cfgModel] : [])])];
    const options = list.map((m) => ({
      value: m,
      label: m === runningModel ? `${m} · 运行中` : m,
      isRunning: Boolean(runningModel) && m === runningModel
    }));
    options.push({
      value: MODEL_CUSTOM,
      label: list.length ? '自定义…' : '自定义…（没能读取可用模型列表）'
    });
    const needCustom = !(cfgModel && list.includes(cfgModel));
    return {
      options,
      selected: needCustom ? MODEL_CUSTOM : cfgModel,
      needCustom,
      customValue: needCustom ? (cfgModel || '') : '',
      // 提示里的"可用 N 个"要按**接口真正返回的**数量说（`given`），不是 `list` ——
      // `list` 里还含我们兜底塞进去的"当前模型"，报它会把"拉不到列表"说成"可用 1 个"。
      // （这个 bug 是测试抓到的：它期望"拉不到列表时说读不到"，而实现报了"可用 1 个"。）
      hint: given.length
        ? `（接口可用 ${given.length} 个${runningModel ? ` · 运行中 ${runningModel}` : ''}）`
        : '（读不到可用模型列表 —— 可直接选「自定义」手填模型名）'
    };
  }

  /**
   * 把"模型检测"的结果排版成人话（**纯函数**，只产出 `{text, state}`，不碰 DOM）。
   *
   * 三条取向：
   *   ① **说清检测到了什么**（几个、耗时、用的哪把 key）—— 光填下拉用户看不到发生过什么；
   *   ② **失败时给下一步**（hint 由主进程按 401/404/域名/连不上分类）——
   *      "检测失败"四个字等于没说；
   *   ③ **指出"配置里的模型在不在检测到的列表里"** —— 真实信号：不在不代表不能用
   *      （`deepseek-chat` 就是：能用，但 /models 不列它），但值得知道。
   */
  function describeDetection(res, { cfgModel = '', runningModel = '' } = {}) {
    if (!res) return { text: '还没检测。', state: '' };
    const ms = typeof res.latencyMs === 'number' ? ` · ${res.latencyMs}ms` : '';
    const src = res.source ? ` · ${res.source}` : '';

    if (!res.ok) {
      const lines = [`❌ 检测失败${ms}${src}`, `   ${res.error ?? '未知错误'}`];
      if (res.hint) lines.push(`   → ${res.hint}`);
      return { text: lines.join('\n'), state: 'error' };
    }
    if (!res.models?.length) {
      return {
        text: `⚠️ 接口通了，但没返回模型列表${ms}${src}\n`
          + `   ${res.note ?? '有些服务不实现 /models —— 可直接选「自定义」手填模型名'}`,
        state: 'warn'
      };
    }
    const lines = [`✅ 检测到 ${res.models.length} 个可用模型${ms}${src}`];
    for (const m of res.models) {
      const tags = [];
      if (m === runningModel) tags.push('运行中');
      if (m === cfgModel) tags.push('配置里的');
      lines.push(`   · ${m}${tags.length ? `（${tags.join(' · ')}）` : ''}`);
    }
    if (cfgModel && !res.models.includes(cfgModel)) {
      lines.push(`   ⚠️ 配置里的「${cfgModel}」不在这个列表里 —— 不代表不能用`
        + `（有些服务不列全部），但它没被接口承认`);
    }
    return { text: lines.join('\n'), state: 'ok' };
  }

  return {
    parseLifecycleLines, isLifecycleSuccess, friendlyAction,
    describeTriggers, convKindLabel, relTime,
    wakeModeLabel, wakeReasonLabel, describeMessage, escapeHtml,
    activityKind, parseActivityLines, filterActivity, ACTIVITY_FILTERS, ACTIVITY_KIND_LABEL,
    MODEL_CUSTOM, buildModelOptions, describeDetection
  };
});
