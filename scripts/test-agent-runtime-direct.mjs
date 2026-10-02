// direct 运行时（OpenAI 兼容通道）的自检。
//
// 全程打**本地假服务**（scripts/mock-openai-server.mjs），不碰外部 API ——
// 既不需要 key、不花钱，也不会因网络波动变成不稳定测试。
//
// 重点守两类东西：
//   ① 请求**发对了**（URL / 鉴权头 / model / messages 组装与历史裁剪）；
//   ② 出错时**返回可用的信息**（HTTP 错误要把服务端的 message 带出来，
//      而不是只给一个 "HTTP 401"；超时与被取消要能区分）。
import { startMockOpenAI } from './mock-openai-server.mjs';
import { DirectRuntime, describeDirectConfig } from '../src/agent-runtime/direct.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const srv = await startMockOpenAI({ reply: '你好呀，我是小鲸鱼。' });

// ── 1. 基本收发 ─────────────────────────────────────────────────────────────
const rt = new DirectRuntime({
  baseUrl: srv.baseUrl,
  apiKey: 'sk-test-123',
  model: 'deepseek-chat',
  systemPrompt: '你是小鲸鱼。',
  maxTurns: 3
});

const r1 = await rt.send({ key: 'group:1', text: '在吗' });
check('① 正常返回文本', r1.ok && r1.text === '你好呀，我是小鲸鱼。', r1.ok ? r1.text : r1.error);

const req = srv.lastRequest();
check('① 请求打到 /v1/chat/completions', req?.url === '/v1/chat/completions', req?.url);
check('① 用 POST', req?.method === 'POST', req?.method);
check('① 带 Bearer 鉴权头', req?.headers?.authorization === 'Bearer sk-test-123', req?.headers?.authorization);
check('① content-type 是 JSON', String(req?.headers?.['content-type']).includes('application/json'));
check('① body 里带 model', req?.body?.model === 'deepseek-chat', req?.body?.model);
check('① messages 首条是 system 人设',
  req?.body?.messages?.[0]?.role === 'system' && req.body.messages[0].content === '你是小鲸鱼。',
  JSON.stringify(req?.body?.messages?.[0]));
check('① messages 末条是本次用户消息',
  req?.body?.messages?.at(-1)?.role === 'user' && req.body.messages.at(-1).content === '在吗',
  JSON.stringify(req?.body?.messages?.at(-1)));
check('① 首版默认非流式', req?.body?.stream === false, String(req?.body?.stream));

// ── 2. 历史记忆与裁剪 ───────────────────────────────────────────────────────
await rt.send({ key: 'group:1', text: '第二句' });
const req2 = srv.lastRequest();
check('② 第二轮带上第一轮的历史',
  req2.body.messages.some((m) => m.role === 'user' && m.content === '在吗')
  && req2.body.messages.some((m) => m.role === 'assistant' && m.content === '你好呀，我是小鲸鱼。'),
  `messages 共 ${req2.body.messages.length} 条`);

// maxTurns=3 → 最多 6 条历史，加 system 与本次 = 8
for (let i = 0; i < 6; i += 1) await rt.send({ key: 'group:1', text: `填充${i}` });
const req3 = srv.lastRequest();
check('② 历史被裁到上限（maxTurns=3 → 最多 6 条历史 + system + 本次 = 8）',
  req3.body.messages.length <= 8, `${req3.body.messages.length} 条`);
check('② 裁剪后仍保留 system 人设',
  req3.body.messages[0].role === 'system', req3.body.messages[0].role);

// ── 3. 会话隔离 ─────────────────────────────────────────────────────────────
await rt.send({ key: 'group:2', text: '另一个群' });
const req4 = srv.lastRequest();
check('③ 不同会话的历史互不串台',
  !req4.body.messages.some((m) => m.content === '填充0'),
  `group:2 的 messages 共 ${req4.body.messages.length} 条`);
check('③ stats 报出两个会话', rt.stats().conversations === 2, JSON.stringify(rt.stats()));

// ── 4. reset 清历史 ─────────────────────────────────────────────────────────
check('④ reset 返回 true 并清掉历史', rt.reset('group:2') === true);
await rt.send({ key: 'group:2', text: '清空后第一句' });
const req5 = srv.lastRequest();
check('④ reset 后只剩 system + 本次',
  req5.body.messages.length === 2, `${req5.body.messages.length} 条`);
check('④ reset 不存在的会话返回 false', rt.reset('group:nope') === false);

// ── 5. 错误路径：HTTP 错误要把服务端 message 带出来 ──────────────────────────
srv.setBehavior({ status: 401, error: 'Invalid API key provided' });
const rAuth = await rt.send({ key: 'group:1', text: 'x' });
check('⑤ HTTP 错误返回 ok:false', rAuth.ok === false);
check('⑤ 带上状态码', rAuth.status === 401, String(rAuth.status));
check('⑤ 把服务端的错误信息原样带出（不是只给 HTTP 401）',
  /Invalid API key provided/.test(rAuth.error), rAuth.error);

srv.setBehavior({ raw: '这不是 JSON' });
const rRaw = await rt.send({ key: 'group:1', text: 'x' });
check('⑤ 非 JSON 正文有明确提示', rRaw.ok === false && /不是 JSON/.test(rRaw.error), rRaw.error);

srv.setBehavior({ noContent: true });
const rNo = await rt.send({ key: 'group:1', text: 'x' });
check('⑤ 缺 choices[0].message.content 有明确提示',
  rNo.ok === false && /content/.test(rNo.error), rNo.error);

// ── 6. 超时 ─────────────────────────────────────────────────────────────────
srv.setBehavior({ hang: true });
const rtTimeout = new DirectRuntime({
  baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 600
});
const startedAt = Date.now();
const rTimeout = await rtTimeout.send({ key: 'k', text: 'x' });
const elapsed = Date.now() - startedAt;
check('⑥ 超时会返回错误而不是永远挂着', rTimeout.ok === false && /超时/.test(rTimeout.error), rTimeout.error);
check('⑥ 超时时间与配置相符（0.6s 量级，不是默认 120s）', elapsed < 5000, `${elapsed}ms`);

// ── 7. 取消 ─────────────────────────────────────────────────────────────────
srv.setBehavior({ hang: true });
const rtAbort = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 30_000 });
const pAbort = rtAbort.send({ key: 'k2', text: 'x' });
await new Promise((r) => setTimeout(r, 200));
check('⑦ abort 对在跑的会话返回 true', rtAbort.abort('k2') === true);
const rAbort = await pAbort;
check('⑦ 取消返回"请求被取消"而不是超时',
  rAbort.ok === false && /取消/.test(rAbort.error), rAbort.error);
check('⑦ abort 不存在的会话返回 false', rtAbort.abort('k2') === false);

// ── 8. 外部 signal 也能取消 ─────────────────────────────────────────────────
srv.setBehavior({ hang: true });
const rtSig = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 30_000 });
const extCtrl = new AbortController();
const pSig = rtSig.send({ key: 'k3', text: 'x', signal: extCtrl.signal });
await new Promise((r) => setTimeout(r, 200));
extCtrl.abort();
const rSig = await pSig;
check('⑧ 外部 signal 能取消请求', rSig.ok === false && rSig.aborted === true, rSig.error);

// ── 9. 构造期校验与描述 ─────────────────────────────────────────────────────
let threw = null;
try { new DirectRuntime({ model: 'm' }); } catch (e) { threw = e; }
check('⑨ 缺 baseUrl 时构造即报错（不等到发送才炸）', Boolean(threw), threw?.message);
threw = null;
try { new DirectRuntime({ baseUrl: 'http://x' }); } catch (e) { threw = e; }
check('⑨ 缺 model 时构造即报错', Boolean(threw), threw?.message);

const desc = describeDirectConfig(rt);
check('⑨ 描述里 apiKey 被打码（不会把明文 key 写进日志）',
  !desc.includes('sk-test-123') && desc.includes('sk-t'), desc);
check('⑨ 描述里含端点与模型', desc.includes('deepseek-chat') && desc.includes('http://127.0.0.1'));

// ── 10. 空文本与无 apiKey 也能工作（有些本地服务不要 key）───────────────────
srv.setBehavior({ reply: '本地模型回复' });
const rtNoKey = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'local' });
const rNoKey = await rtNoKey.send({ key: 'k', text: '' });
check('⑩ 不配 apiKey 时不发鉴权头（本地服务场景）',
  srv.lastRequest().headers.authorization === undefined, String(srv.lastRequest().headers.authorization));
check('⑩ 空文本也能拿到回复', rNoKey.ok && rNoKey.text === '本地模型回复', rNoKey.ok ? rNoKey.text : rNoKey.error);

// ── 11. 工具循环 ────────────────────────────────────────────────────────────
// 这是 direct 能"有手"的关键：模型要工具 → 我们执行 → 结果回灌 → 模型给最终回复。
{
  srv.setSequence([
    { toolCalls: [{ id: 'call_a', name: 'qq_status', arguments: { who: 'me' } }] },
    { reply: '（基于工具结果的最终回复）' }
  ]);
  const calls = [];
  const rtTools = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', systemPrompt: '你是小鲸鱼。' });
  const fakeTools = [{
    type: 'function',
    function: { name: 'qq_status', description: '查询状态', parameters: { type: 'object', properties: {} } }
  }];
  const rTools = await rtTools.send({
    key: 'g:1',
    text: '现在什么状态',
    tools: fakeTools,
    toolRunner: async (name, args) => { calls.push({ name, args }); return { ok: true, text: '{"online":true}' }; }
  });
  check('⑪ 带工具时返回最终文本', rTools.ok && rTools.text === '（基于工具结果的最终回复）', rTools.text ?? rTools.error);
  check('⑪ 工具被真的调用了', calls.length === 1 && calls[0].name === 'qq_status', JSON.stringify(calls));
  check('⑪ 参数被正确解析成对象', calls[0]?.args?.who === 'me', JSON.stringify(calls[0]?.args));
  check('⑪ 报告了轮数与工具调用次数', rTools.rounds === 2 && rTools.toolCalls === 1,
    `rounds=${rTools.rounds} toolCalls=${rTools.toolCalls}`);

  // 第二次请求必须带上 assistant(tool_calls) + tool 结果 —— 否则 OpenAI 会 400
  const reqTool2 = srv.requests[srv.requests.length - 1];
  const msgs2 = reqTool2.body.messages;
  const asstWithCalls = msgs2.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  check('⑪ 回填了 assistant 的 tool_calls 消息', Boolean(asstWithCalls),
    asstWithCalls ? `${asstWithCalls.tool_calls.length} 个调用` : '(缺失)');
  const toolMsg = msgs2.find((m) => m.role === 'tool');
  check('⑪ 回填了 role=tool 的结果消息', Boolean(toolMsg), toolMsg ? String(toolMsg.content).slice(0, 40) : '(缺失)');
  check('⑪ tool 消息的 tool_call_id 与调用对应', toolMsg?.tool_call_id === 'call_a', String(toolMsg?.tool_call_id));
  check('⑪ 请求里带了 tools 与 tool_choice=auto',
    Array.isArray(reqTool2.body.tools) && reqTool2.body.tool_choice === 'auto',
    `tools=${reqTool2.body.tools?.length} choice=${reqTool2.body.tool_choice}`);
  check('⑪ 不带工具时请求里没有 tools 字段（纯聊天不塞工具）',
    !('tools' in srv.requests[0].body), JSON.stringify(Object.keys(srv.requests[0].body)));

  // 工具报错 → 作为结果回灌（让模型有机会自己纠正），而不是中断整轮
  srv.setSequence([
    { toolCalls: [{ name: 'qq_send_message', arguments: { key: 'g:1' } }] },
    { reply: '收到' }
  ]);
  const rToolErr = await rtTools.send({
    key: 'g:1', text: 'x', tools: fakeTools,
    toolRunner: async () => ({ ok: false, error: '缺少 token 参数' })
  });
  check('⑪ 工具报错时把错误回灌给模型且整轮仍成功', rToolErr.ok === true, rToolErr.error ?? '');
  const errToolMsg = srv.requests[srv.requests.length - 1].body.messages.find((m) => m.role === 'tool');
  check('⑪ 回灌内容标注了"工具报错"', /工具报错/.test(String(errToolMsg?.content)),
    String(errToolMsg?.content).slice(0, 50));

  // 参数不是合法 JSON → 也回灌，不让整轮崩
  srv.setSequence([
    { toolCalls: [{ name: 'qq_status', arguments: '{这不是JSON' }] },
    { reply: '好' }
  ]);
  const rBadArgs = await rtTools.send({
    key: 'g:1', text: 'x', tools: fakeTools, toolRunner: async () => ({ ok: true, text: '不该被调用' })
  });
  check('⑪ 工具参数非法 JSON 时不崩、并回灌提示', rBadArgs.ok === true, rBadArgs.error ?? '');
  const badMsg = srv.requests[srv.requests.length - 1].body.messages.filter((m) => m.role === 'tool').pop();
  check('⑪ 非法参数的回灌说明了原因', /不是合法 JSON/.test(String(badMsg?.content)),
    String(badMsg?.content).slice(0, 50));

  // 撞上限 → 改用"收尾请求"体面结束（不是整轮报错：那会在 QQ 里多一条 ⚠️ 通知）
  const alwaysTool = { toolCalls: [{ name: 'qq_status', arguments: {} }] };
  srv.setSequence([alwaysTool, alwaysTool, alwaysTool, alwaysTool, { reply: '（收尾）我先这样' }]);
  const rLoop = await rtTools.send({
    key: 'g:1', text: 'x', tools: fakeTools, maxToolRounds: 3,
    toolRunner: async () => ({ ok: true, text: '又调一次' })
  });
  check('⑪ 撞到工具轮数上限时改用收尾请求、整轮按成功算',
    rLoop.ok === true && rLoop.text === '（收尾）我先这样', rLoop.error ?? rLoop.text);
  check('⑪ 收尾请求不带 tools（模型没法再调工具）',
    !('tools' in srv.lastRequest().body), JSON.stringify(Object.keys(srv.lastRequest().body)));
  check('⑪ 如实报告轮数（4 轮工具 + 1 轮收尾）', rLoop.rounds === 5, `rounds=${rLoop.rounds}`);
  check('⑪ 标出撞上限的轮数（日志排查用）', rLoop.cappedAt === 3, `cappedAt=${rLoop.cappedAt}`);

  // 工具循环中途 HTTP 失败 → 报出来（已执行的工具不回滚）
  srv.setSequence([{ toolCalls: [{ name: 'qq_status', arguments: {} }] }, { status: 500, error: '上游炸了' }]);
  const rMid = await rtTools.send({
    key: 'g:1', text: 'x', tools: fakeTools, toolRunner: async () => ({ ok: true, text: 'ok' })
  });
  check('⑪ 循环中途 HTTP 失败时返回错误且标注已跑工具数',
    rMid.ok === false && rMid.toolCalls === 1, `${rMid.error} / toolCalls=${rMid.toolCalls}`);
}

// ── 12. 证书类错误要给"可操作的"修复提示（且 hint 不进 QQ 消息）─────────────
// 背景（2026-09-26 实测）：本机有安全软件做 HTTPS 拦截，它的根证书在 Windows 存储里、
// 不在 Node 自带的 150 个里 → 偶发 SELF_SIGNED_CERT_IN_CHAIN。
// 光说"fetch failed"用户无从下手，所以错误里必须带出"怎么修"。
// 这里**注入一个假 fetch**，不依赖网络（真实证书错误在 CI 上不可复现）。
{
  const mk = (code, msg) => {
    const rt = new DirectRuntime({ baseUrl: 'https://x.invalid/v1', model: 'm', apiKey: 'k' });
    rt.fetchImpl = async () => { const e = new Error('fetch failed'); e.cause = { code, message: msg }; throw e; };
    return rt;
  };

  const rCert = await mk('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain')
    .send({ key: 'k', text: 'x' });
  check('⑫ 证书类错误：error 里带出 cause 的 code',
    rCert.ok === false && /SELF_SIGNED_CERT_IN_CHAIN/.test(rCert.error), rCert.error);
  check('⑫ 证书类错误：给出可操作的 hint（含 --use-system-ca）',
    /use-system-ca/.test(rCert.hint ?? ''), String(rCert.hint ?? '(没有 hint)').slice(0, 70));
  check('⑫ 证书类错误：hint 说明这是"偶发"的（避免用户以为全线不通）',
    /偶发/.test(rCert.hint ?? ''));
  check('⑫ hint **不混进 QQ 消息**（error 里不能有操作说明，群聊贴步骤很奇怪）',
    !/use-system-ca/.test(rCert.error), rCert.error);

  const rDepth = await mk('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate').send({ key: 'k', text: 'x' });
  check('⑫ 另一种证书错误码也能识别', /use-system-ca/.test(rDepth.hint ?? ''));

  // 对照组：非证书错误不该给证书 hint（否则会把用户引到错误方向）
  const rRefused = await mk('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:39997').send({ key: 'k', text: 'x' });
  check('⑫ 非证书错误不给证书 hint', !rRefused.hint, String(rRefused.hint ?? '(无，正确)'));
  check('⑫ 非证书错误仍然带出 cause 的 code', /ECONNREFUSED/.test(rRefused.error), rRefused.error);
}

// ── 13. 两级超时（2026-09-26 修正）────────────────────────────────────────────
// 背景：旧实现只有一个"整轮"定时器（从 send() 入口起算）→ qq_wait_for_messages 这种
// 真实长轮询（普通等待 30 秒起、沉睡前观察要 300 秒）会把 120 秒预算吃光，AI 按操作规程
// 收尾时**必然**超时，QQ 里就会出现「⚠️ 消息未能送达 AI：请求超时（120000ms）」。
// 修好后：timeoutMs 只管**单次模型请求**（工具执行时间不算它的），整轮另有 turnTimeoutMs 兜底。
{
  const tools13 = [{
    type: 'function',
    function: { name: 'qq_wait_for_messages', description: '等群友消息', parameters: { type: 'object', properties: {} } }
  }];

  // 13.1 工具耗时 > timeoutMs：整轮仍要成功（工具时间不占请求预算）
  srv.setBehavior({ reply: '（mock 回复）' });
  srv.setSequence([
    { toolCalls: [{ id: 'c1', name: 'qq_wait_for_messages', arguments: { timeoutMs: 300000 } }] },
    { reply: '等到了' }
  ]);
  const rtToolSlow = new DirectRuntime({
    baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 300, turnTimeoutMs: 5000
  });
  const startedSlow = Date.now();
  const rSlow = await rtToolSlow.send({
    key: 'slow:1', text: 'x', tools: tools13,
    toolRunner: async () => { await new Promise((r) => setTimeout(r, 900)); return { ok: true, text: '{"timeout":true}' }; }
  });
  const slowMs = Date.now() - startedSlow;
  check('⑬ 工具执行超过 timeoutMs 时整轮仍成功（工具时间不算单次请求超时）',
    rSlow.ok === true && rSlow.text === '等到了', rSlow.error ?? rSlow.text);
  check('⑬ 上面那轮确实比 timeoutMs 慢（否则用例没意义）', slowMs > 300, `${slowMs}ms`);

  // 13.2 单次请求本身挂住 → 仍是「请求超时（Nms）」
  srv.setBehavior({ hang: true });
  const rtHang = new DirectRuntime({
    baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 400, turnTimeoutMs: 5000
  });
  const rHang = await rtHang.send({ key: 'hang:1', text: 'x' });
  check('⑬ 单次请求挂住 → 报「请求超时（400ms）」',
    rHang.ok === false && /请求超时（400ms）/.test(rHang.error), rHang.error);

  // 13.3 整轮预算用尽（模型永远要工具 + 每次工具都慢）→ 报「整轮超时」
  srv.setSequence([{ toolCalls: [{ id: 'c2', name: 'qq_wait_for_messages', arguments: {} }] }]);  // 永远要工具
  const rtTurn = new DirectRuntime({
    baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 2000, turnTimeoutMs: 700
  });
  const rTurn = await rtTurn.send({
    key: 'turn:1', text: 'x', tools: tools13, maxToolRounds: 20,
    toolRunner: async () => { await new Promise((r) => setTimeout(r, 500)); return { ok: true, text: 'ok' }; }
  });
  check('⑬ 整轮预算用尽 → 报「整轮超时」而不是「请求超时」',
    rTurn.ok === false && /整轮超时/.test(rTurn.error), rTurn.error);
  check('⑬ 整轮超时的措辞里带秒数（便于对着配置排查）',
    /整轮超时（1 秒未收尾）/.test(rTurn.error), rTurn.error);

  // 13.4 turnTimeoutMs=0 → 显式关掉整轮保险（长工具也不会被整轮上限打断）
  srv.setBehavior({ reply: '（mock 回复）' });
  srv.setSequence([
    { toolCalls: [{ id: 'c3', name: 'qq_wait_for_messages', arguments: {} }] },
    { reply: '没被整轮上限打断' }
  ]);
  const rtNoTurn = new DirectRuntime({
    baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', timeoutMs: 500, turnTimeoutMs: 0
  });
  const rNoTurn = await rtNoTurn.send({
    key: 'noturn:1', text: 'x', tools: tools13,
    toolRunner: async () => { await new Promise((r) => setTimeout(r, 800)); return { ok: true, text: 'ok' }; }
  });
  check('⑬ turnTimeoutMs=0 时不挂整轮保险（长工具照跑）',
    rNoTurn.ok === true && rNoTurn.text === '没被整轮上限打断', rNoTurn.error ?? rNoTurn.text);
}

// ── 14. 图片/视觉（2026-09-26：QQ 那边反馈「无法识别图片」）──────────────────
{
  const tools14 = [{
    type: 'function',
    function: { name: 'qq_get_message_images', description: '看图', parameters: { type: 'object', properties: {} } }
  }];
  srv.setBehavior({ reply: '看图完成' });
  const rtVision = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k' });

  // 14.1 用户消息带图 → content 变成多模态数组（text + image_url data URI）
  const rImg = await rtVision.send({
    key: 'v:1',
    text: '这图是什么',
    images: [{ mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64') }]
  });
  check('⑭ 带图时整轮照常成功', rImg.ok === true, rImg.error ?? rImg.text);
  const vMsg = srv.lastRequest().body.messages.at(-1);
  check('⑭ 带图时 user 消息是多模态数组', Array.isArray(vMsg.content), typeof vMsg.content);
  check('⑭ 数组第一块是文本、第二块是 image_url',
    vMsg.content?.[0]?.type === 'text' && vMsg.content?.[1]?.type === 'image_url',
    JSON.stringify(vMsg.content?.map((c) => c.type)));
  check('⑭ 图片走 data URI（不外链，避免 SSRF/外网依赖）',
    String(vMsg.content?.[1]?.image_url?.url ?? '').startsWith('data:image/png;base64,'),
    String(vMsg.content?.[1]?.image_url?.url ?? '').slice(0, 40));

  // 14.2 不带图时仍是字符串（老格式不变，别把纯文本请求也改成数组）
  await rtVision.send({ key: 'v:2', text: '纯文本' });
  check('⑭ 不带图时 user 消息仍是字符串（老格式不变）',
    typeof srv.lastRequest().body.messages.at(-1).content === 'string');

  // 14.3 工具返回的图片 → 紧跟一条带 image_url 的 user 消息
  srv.setSequence([
    { toolCalls: [{ id: 'cimg', name: 'qq_get_message_images', arguments: { messageId: '1' } }] },
    { reply: '看到了' }
  ]);
  const rToolImg = await rtVision.send({
    key: 'v:3', text: '看图', tools: tools14,
    toolRunner: async () => ({
      ok: true,
      text: '消息 1 的媒体内容（1 项）',
      images: 1,
      imageParts: [{ mediaType: 'image/jpeg', data: Buffer.from('fake-jpg').toString('base64') }]
    })
  });
  check('⑭ 工具返回图片不会让整轮失败', rToolImg.ok === true, rToolImg.error ?? rToolImg.text);
  const msgsImg = srv.lastRequest().body.messages;
  const toolIdx = msgsImg.findIndex((m) => m.role === 'tool');
  const afterTool = msgsImg[toolIdx + 1];
  check('⑭ 工具结果之后紧跟一条带 image_url 的 user 消息',
    afterTool?.role === 'user' && Array.isArray(afterTool.content)
      && afterTool.content.some((c) => c.type === 'image_url'),
    `${afterTool?.role} / ${String(JSON.stringify(afterTool?.content)).slice(0, 80)}`);
  check('⑭ tool 消息本身仍是纯文本（OpenAI 协议要求）',
    typeof msgsImg[toolIdx]?.content === 'string', typeof msgsImg[toolIdx]?.content);

  // 14.4 vision:false → 退化成纯文本（"不想让它看图"的闸）
  const rtNoVision = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k', vision: false });
  await rtNoVision.send({
    key: 'v:4', text: '带图但关了视觉',
    images: [{ mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64') }]
  });
  check('⑭ vision:false 时带图也退回纯文本字符串',
    typeof srv.lastRequest().body.messages.at(-1).content === 'string',
    typeof srv.lastRequest().body.messages.at(-1).content);

  // 14.5 超大图（超过内联上限）→ 不附图片，但要在文本里说清楚，别让模型以为看到了
  const rtHuge = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k' });
  await rtHuge.send({
    key: 'v:5', text: '这张图是什么',
    images: [{ mediaType: 'image/png', data: 'x'.repeat(20_000_001) }]
  });
  const hugeMsg = srv.lastRequest().body.messages.at(-1);
  check('⑭ 超大图不塞进请求（防止把请求体撑爆）',
    typeof hugeMsg.content === 'string', typeof hugeMsg.content);
  check('⑭ 超大图要在文本里说清楚"没附上"（不静默丢）',
    /超过内联上限/.test(String(hugeMsg.content)), String(hugeMsg.content).slice(-60));
}

// ── 15. 并行看图（2026-09-27：三个群连撞 400「insufficient tool messages」）────
// 背景：工具返回图片时补的那条 user 消息若**逐条**补（补在每个工具结果后面），模型一次并行调
// N 个看图工具就会拼出 assistant(tool_calls=[c1,c2]) → tool(c1) → user(图) → tool(c2) → user(图)：
// 中间那条 user 把 tool 消息块切断，服务端只认到 c1，整条请求被拒 —— QQ 里就是
// 「⚠️ 消息未能送达 AI：HTTP 400 …」，而那一轮 AI 彻底没有回复（实测三群 7 次）。
// 修好后：一轮里所有工具返回的图**合并成一条** user 消息、排在整块 tool 消息之后。
// 假服务不校验消息形状（所以线上那个 400 在这里复现不出来），因此这里**照服务端的判据**断言：
// assistant(tool_calls) 之后的连续 tool 消息必须覆盖它每一个 tool_call_id，图片消息不许夹在中间。
{
  const tools15 = [{
    type: 'function',
    function: { name: 'qq_get_message_images', description: '看图', parameters: { type: 'object', properties: {} } }
  }];
  srv.setSequence([
    { toolCalls: [
      { id: 'par_1', name: 'qq_get_message_images', arguments: { messageId: '1' } },
      { id: 'par_2', name: 'qq_get_message_images', arguments: { messageId: '2' } }
    ] },
    { reply: '两张都看到了' }
  ]);
  const rtPar = new DirectRuntime({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k' });
  const rPar = await rtPar.send({
    key: 'v:6', text: '连发了两张图，都看看', tools: tools15,
    toolRunner: async () => ({
      ok: true,
      text: '消息的媒体内容（1 项）',
      images: 1,
      imageParts: [{ mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64') }]
    })
  });
  check('⑮ 并行调两个看图工具时整轮照常成功', rPar.ok === true, rPar.error ?? rPar.text);

  const msgs15 = srv.lastRequest().body.messages;
  const asstIdx15 = msgs15.map((m) => m.role).lastIndexOf('assistant');
  const needIds = (msgs15[asstIdx15]?.tool_calls ?? []).map((c) => c.id);
  const gotIds = [];
  for (let i = asstIdx15 + 1; i < msgs15.length && msgs15[i].role === 'tool'; i += 1) {
    gotIds.push(msgs15[i].tool_call_id);
  }
  check('⑮ assistant(tool_calls) 之后的连续 tool 消息覆盖了每个 tool_call_id（线上 400 的判据）',
    needIds.length === 2 && needIds.every((id) => gotIds.includes(id)),
    `需要 ${needIds.join(',')} / 连续实得 ${gotIds.join(',') || '(无)'}`);

  const imgMsgs15 = msgs15.filter((m) => m.role === 'user' && Array.isArray(m.content));
  check('⑮ 两张图合并成**一条** user 消息（不是每个工具一条）',
    imgMsgs15.length === 1, `${imgMsgs15.length} 条`);
  check('⑮ 合并后的图片消息里两张图都在',
    (imgMsgs15[0]?.content ?? []).filter((c) => c.type === 'image_url').length === 2,
    JSON.stringify((imgMsgs15[0]?.content ?? []).map((c) => c.type)));
  check('⑮ 图片消息排在整块 tool 消息之后（不切断 tool 块）',
    msgs15.indexOf(imgMsgs15[0]) === asstIdx15 + 1 + needIds.length,
    `图片消息 idx=${msgs15.indexOf(imgMsgs15[0])} / 期望 ${asstIdx15 + 1 + needIds.length}`);
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
await srv.close();
console.log('');
console.log(failures === 0 ? '=== direct 运行时自检通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
