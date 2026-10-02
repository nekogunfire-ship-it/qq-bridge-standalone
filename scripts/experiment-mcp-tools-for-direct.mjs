// 实验：direct 运行时能不能直接复用现有的 MCP 工具？
//
// 背景：direct 模式的 AI 需要"手"（收发消息、看图、出图…）。这些工具已经以 MCP server 的形式
// 存在于 src/mcp-*.js（36 个工具），实现方式是转发到桥接的 HTTP API。
//
// 两条路：
//   A. 手写 8~10 个工具的 schema（OpenAI function-calling 格式），各自调 HTTP —— 会与 MCP 定义**漂移**
//   B. **把现有 MCP server 当子进程拉起来，当 MCP 客户端**（仓库里 test-mcp-servers-stdio.mjs 已证明可行）
//
// 选 B 的关键前提：MCP 的 `tools/list` 返回的 `inputSchema` 必须是**标准 JSON Schema**，
// 才能几乎无转换地用给 OpenAI 的 `tools[].function.parameters`。这个实验就是验它。
//
// 用法: node scripts/experiment-mcp-tools-for-direct.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const transport = new StdioClientTransport({
  command: NODE,
  args: [path.join(ROOT, 'src/mcp-snowluma-safe.js')],
  cwd: ROOT,
  stderr: 'pipe'
});
const client = new Client({ name: 'direct-runtime-probe', version: '0.0.0' });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`=== 拉起 src/mcp-snowluma-safe.js，拿到 ${tools.length} 个工具 ===`);
  console.log('');

  check('工具数量 > 10（说明"复用全套"确有价值）', tools.length > 10, `${tools.length} 个`);

  const withParams = tools.filter((t) => t.inputSchema && Object.keys(t.inputSchema.properties ?? {}).length > 0);
  check('存在带参数的工具', withParams.length > 0, `${withParams.length} 个带参数`);

  // ── 关键：inputSchema 是不是标准 JSON Schema（决定能否直接用给 OpenAI）──
  const sample = withParams.find((t) => /qq_get_unread|qq_send_message|qq_get_recent/.test(t.name)) ?? withParams[0];
  console.log('');
  console.log(`=== 样本工具：${sample.name} ===`);
  console.log(`描述：${String(sample.description ?? '').slice(0, 90)}…`);
  console.log('inputSchema：');
  console.log(JSON.stringify(sample.inputSchema, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('');

  check('inputSchema.type === "object"（OpenAI 要求 parameters 是 object schema）',
    sample.inputSchema?.type === 'object', String(sample.inputSchema?.type));
  check('inputSchema 有 properties 对象', typeof sample.inputSchema?.properties === 'object');
  check('inputSchema 有 required 数组（或本工具无必填）',
    Array.isArray(sample.inputSchema?.required) || sample.inputSchema?.required === undefined);

  // 全部工具都必须是 object 型，否则没法批量转换
  const nonObject = tools.filter((t) => t.inputSchema?.type !== 'object');
  check('所有工具的 inputSchema 都是 object 型', nonObject.length === 0,
    nonObject.length ? nonObject.map((t) => t.name).join(', ') : `${tools.length} 个全部合格`);

  // ── 转成 OpenAI function-calling 格式的样子（确认转换是"改包装"而不是"改内容"）──
  const openaiShape = {
    type: 'function',
    function: {
      name: sample.name,
      description: sample.description,
      parameters: sample.inputSchema
    }
  };
  const roundTrip = JSON.stringify(openaiShape);
  check('可直接包装成 OpenAI 的 tools[] 条目（parameters 原样复用）',
    roundTrip.includes('"type":"function"') && roundTrip.includes(sample.name));
  check('包装后体积合理（描述长度 ' + String(sample.description ?? '').length + ' 字符）',
    JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }))).length < 120_000);

  console.log('');
  console.log('=== 工具的 zod schema 已被 MCP SDK 转成 JSON Schema，转换只需"改包装" ===');
  console.log(`全部工具名：${tools.map((t) => t.name).join(', ')}`);
} catch (error) {
  console.error(`❌ ${error?.message ?? error}`);
  failures += 1;
} finally {
  try { await client.close(); } catch { /* 忽略 */ }
}

console.log('');
console.log(failures === 0 ? '=== 结论：可以复用现有 MCP 工具（选路 B）===' : `=== ${failures} 项不成立 ===`);
process.exit(failures === 0 ? 0 : 1);
