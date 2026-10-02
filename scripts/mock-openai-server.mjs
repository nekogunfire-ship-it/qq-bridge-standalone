// 本地假 OpenAI 服务：给 direct 运行时的测试用。
//
// 为什么需要它：验证 direct 运行时需要一个 `/v1/chat/completions` 端点，
// 但真调外部 API 既要有 key、又要花钱、还会因网络波动变成不稳定测试。
// 这个假服务只做三件事：**记录收到的请求**、**按脚本返回响应**、**能返回各种错误**。
//
// 支持的行为（由行为脚本控制，见下）：
//   { reply: '文本' }            → 正常返回该文本
//   { status: 401, error: '…' }  → 返回错误状态（用于验证错误信息有没有被原样带出）
//   { raw: '不是JSON' }          → 返回非 JSON 正文
//   { noContent: true }          → 返回合法 JSON 但没有 choices[0].message.content
//   { delayMs: 5000 }            → 延迟（用于验证超时与取消）
//   { hang: true }               → 永不响应（直到被 abort）
//   { toolCalls: [{name, arguments}] } → 返回 tool_calls（用于验证工具循环）
//
// 多轮脚本（工具循环需要"第一次要工具、第二次给最终回复"）：
//   srv.setSequence([{toolCalls:[…]}, {reply:'最终回复'}])
//   每次请求弹出下一个；弹完后**最后一个会一直重复**。
//
// 用法（测试里）：
//   const srv = await startMockOpenAI({ reply: '你好' });
//   const rt = new DirectRuntime({ baseUrl: srv.baseUrl, ... , fetchImpl: fetch });
//   ...
//   await srv.close();
import http from 'node:http';

export async function startMockOpenAI(defaultBehavior = { reply: '（mock 回复）' }) {
  const requests = [];
  let behavior = defaultBehavior;
  let sequence = null;          // 非空时按序弹出，覆盖 behavior
  let seqIndex = 0;
  const hanging = new Set();
  // `GET /models` 返回的模型列表（测试可覆盖，用于验证"检测到了哪些"）
  let models = ['mock-model', 'mock-model-2'];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 记原文 */ }
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: parsed,
        rawBody: body
      });

      // `GET /models` —— 供"模型检测"（`/api/runtime/models`）用。
      // 返回一个固定列表：这样"检测**成功**"那条路径才有东西可断言
      //（否则只能测到"接口通了但没返回列表"那一支）。
      if (req.method === 'GET' && String(req.url).split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: models.map((id) => ({ id, object: 'model' }))
        }));
        return;
      }

      const b = sequence
        ? sequence[Math.min(seqIndex++, sequence.length - 1)]
        : behavior;
      const send = () => {
        if (b.hang) {
          hanging.add(res);                       // 挂着不响应，等客户端 abort 后自然断开
          req.on('close', () => hanging.delete(res));
          return;
        }
        if (b.status && b.status !== 200) {
          res.writeHead(b.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: b.error ?? 'mock 错误', type: 'mock' } }));
          return;
        }
        if (b.raw !== undefined) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(String(b.raw));
          return;
        }
        if (b.noContent) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: {} }] }));
          return;
        }
        // 工具调用：content 为 null，只有 tool_calls（这正是 OpenAI 在纯工具调用轮的行为）
        if (Array.isArray(b.toolCalls)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock-tools',
            object: 'chat.completion',
            model: b.model ?? 'mock-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: b.toolCalls.map((tc, i) => ({
                  id: tc.id ?? `call_${i + 1}`,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string'
                      ? tc.arguments
                      : JSON.stringify(tc.arguments ?? {})
                  }
                }))
              },
              finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-1',
          object: 'chat.completion',
          model: b.model ?? 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: b.reply ?? '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }));
      };

      if (b.delayMs) setTimeout(send, b.delayMs);
      else send();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    /** 临时改行为（测试不同错误路径） */
    setBehavior(b) { behavior = b; sequence = null; },
    /** 按序脚本：每次请求弹一个，弹完后最后一个一直重复 */
    setSequence(seq) { sequence = Array.isArray(seq) && seq.length ? seq : null; seqIndex = 0; },
    /** 改 `GET /models` 返回的列表（传 [] 可测"接口通了但没返回模型"那一支） */
    setModels(list) { models = Array.isArray(list) ? list : []; },
    /** 取最后一次请求 */
    lastRequest() { return requests[requests.length - 1]; },
    async close() {
      for (const res of hanging) { try { res.destroy(); } catch { /* 忽略 */ } }
      hanging.clear();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// 直接跑（node scripts/mock-openai-server.mjs）时起一个固定端口的服务，方便手工 curl
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const srv = await startMockOpenAI({ reply: '（手工调试用的 mock 回复）' });
  console.log(`假 OpenAI 服务已在 ${srv.baseUrl} 监听（Ctrl+C 退出）`);
  console.log(`试一下：curl -s ${srv.baseUrl}/chat/completions -H "content-type: application/json" -d '{"model":"m","messages":[]}'`);
}
