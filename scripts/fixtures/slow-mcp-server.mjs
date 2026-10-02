// 测试夹具：一个**真的很慢**的 MCP server（stdio 传输），专门用来验证"客户端超时"这条链路。
//
// 为什么需要它（2026-09-27 事故）：
//   direct 运行时的 MCP 客户端以前不传 `timeout`，于是吃 SDK 默认的 60 秒；而
//   `qq_wait_for_messages` 是合法等 300 秒的长轮询 —— 每一次等待都在 60 秒被客户端掐掉、
//   报 `MCP error -32001: Request timed out`，桥接那边的等待却还在跑。真实后果：
//   75 次"被新等待接管"、29 次撞满工具轮数上限。
//   真实的 5 分钟等待太慢，跑不进测试；所以这里让工具**真的睡 70 秒**（刚过 60 秒那条线），
//   用最短的时间复现同一个形态。
//
// 两个工具是刻意配的一对：
//   · `qq_wait_for_messages` —— 名字与真实长轮询工具相同 → 走"按请求时长算超时"的策略 → 应该活下来
//   · `slow_probe`           —— 普通工具 → 拿默认 60 秒 → 睡 70 秒**必然**被掐
//   一个证明"修好了"，一个证明"这个测试真的能抓到那个 bug"（否则测试可能只是碰巧通过）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'slow-fixture', version: '1.0.0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.tool(
  'qq_wait_for_messages',
  '测试夹具：按 timeoutMs 真实睡够再返回（模拟 QQ 侧的长轮询等待）',
  {
    timeoutMs: z.number().optional().describe('要睡多久'),
    quietMs: z.number().optional().describe('静默窗口（参与超时预算计算）')
  },
  async ({ timeoutMs }) => {
    const wait = Math.max(0, Number(timeoutMs) || 0);
    await sleep(wait);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fixture: 'wait', waitedMs: wait }) }] };
  }
);

server.tool(
  'slow_probe',
  '测试夹具：普通工具（不在长轮询名单里），按 ms 睡够再返回 —— 应该被默认预算掐掉',
  { ms: z.number().optional().describe('要睡多久') },
  async ({ ms }) => {
    const wait = Math.max(0, Number(ms) || 0);
    await sleep(wait);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fixture: 'probe', waitedMs: wait }) }] };
  }
);

await server.connect(new StdioServerTransport());
