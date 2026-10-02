# 与 DSH 脱钩的可行性分析（实测耦合面）

> 2026-09-26 实测梳理。结论摘要：**传输层耦合比预想的干净得多（14 类调用、39 处），
> 真正的工作量不在"换 API"，而在"自己实现 agent 循环与会话管理"。**
> 而且有几类耦合是 DSH 的平台概念，脱钩后会**直接消失**。

## 一、实测的完整耦合面

桥接（`src/bridge.js`，9363 行）对 DSH 的**全部**调用如下 —— 用正则从源码里机械提取，不靠印象：

| 调用 | 处数 | 用途 | 脱钩后 |
| --- | --- | --- | --- |
| `api.sessions.prompt({sessionId, mode:'queue', content})` | 4 | **把 QQ 消息送给 AI** | 🔴 必须替代 |
| `api.events.follow` | 5 | 订阅某会话的事件流 | 🔴 必须替代 |
| `api.events.mux` | 1 | 多路事件流 | 🔴 必须替代 |
| `api.sessions.create` | 2 | 建会话 | 🔴 必须替代（可简化） |
| `api.stopSessionWork` | 4 | 停止正在跑的回合 | 🔴 必须替代 |
| `api.sessions.list` | 1 | 列会话 | 🟡 简化为本地会话表 |
| `api.sessions.selectModel` | 1 | 选模型 | 🟡 变成配置项 |
| `api.workspace.archiveSession` | 5 | 归档会话 | 🟡 简化为"清空会话" |
| `api.workspace.create` | 2 | 建工作区 | ⚪ 可砍（DSH 概念） |
| `api.workspace.rename` | 2 | 重命名工作区 | ⚪ 可砍 |
| `api.settings.describe` | 2 | 读 DSH 设置 | ⚪ 可砍 |
| `api.settings.update` | 1 | 改 DSH 设置 | ⚪ 可砍 |
| `api.agentPresets.list` | 2 | 列人设预设 | ⚪ 换成本地 persona 文件 |
| `api.respond` | 6 | 回答 DSH 的提问/审批 | ⚪ **可砍**（自己控工具就没有审批流） |
| `unwrap(...)` | 11 | 解 RPC 返回结构 | ⚪ 不再需要 |
| `createTurnCollector(...)` | 2 | 收集回合输出 | 🔴 自己收集流式响应 |
| `discoverDshLaunchToken(...)` | 1 | 端口/令牌发现 | ⚪ 不再需要（配置里放 API key） |

**外加一个硬依赖**：`src/dsh-client.js` 第 15 行
`import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'` —— 整个 669 行
文件里有大半是在适配 DSH 的特定协议（RPC 名用斜杠、payload 包 `{args:{...}}`、
先换 Cookie 才能访问、事件流走 `/api/remote.mux`）。

## 二、关键结论：必须替代的其实只有 5 类

而这 5 类在 **OpenAI 兼容协议**下的对应物是：

| DSH 里 | direct 模式下 |
| --- | --- |
| `sessions.create` + `events.follow` + `events.mux` | **不需要**：一次请求就是一个流，没有"订阅"概念 |
| `sessions.prompt` | `POST /v1/chat/completions`（`stream: true`） |
| `stopSessionWork` | `AbortController.abort()` |
| `createTurnCollector` | 边收 SSE chunk 边拼（几十行） |

**所以传输层不是变复杂了，而是变简单了** —— DSH 那套协议适配（669 行）可以整个删掉，
换成一个几百行的 OpenAI 兼容客户端。

## 三、脱钩后**直接消失**的东西（净收益）

1. **提问/审批回传**（`question/requested`、`approval/requested` 两个帧）：工具是我们自己
   注册与执行的，没有"宿主审批"这层，桥接里 6 处 `api.respond` 与相关分支全部消失。
2. **workspace / settings 概念**（11 处）：QQ 机器人不需要工作区与平台设置。
3. **端点发现与 Cookie 交换**：`discoverDshLaunchToken`、`invalidateAuth`、
   以及"DSH 换端口导致事件流无限重连"那一整类问题。
4. **回合卡死**：桥接里有一套 `v2TurnStartAt` / 心跳 / 活性租约（V2_TURN_MAX_MS 15 分钟）
   来兜"DSH 的 turn 永远不发 turn/end"—— 见 2026-09-24 机器人集体失联。
   direct 模式下一次请求要么正常结束要么抛错，**这一整类故障从根上消失**。

## 四、真正的难点（不在传输层）

| # | 要做的事 | 规模 | 说明 |
| --- | --- | --- | --- |
| 1 | **Agent 循环** | 500~1000 行 | LLM → tool_use → 本地执行 → tool_result → 再调 LLM。要处理：参数校验、并行工具调用、错误回灌、最大轮数、取消 |
| 2 | **会话与上下文管理** | 300~600 行 | 多会话、历史裁剪、**上下文超限压缩**（最容易埋雷：做不好长会话会崩） |
| 3 | Prompt 组装 | ~200 行 | 从 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（228 行）搬过来 |
| 4 | **记忆** | ⚠️ 待定 | meow-memory 是 DSH 插件，脱钩后用不了。需另定方案 |

**不受影响的部分（很重要）**：唤醒判定、社交仿真（reserved2）、黑话学习、表情包、
出图（ComfyUI 全链路）、管理命令、约 85 个 `/api/*` 端点、整个网页控制台 —— 这些本来就在
桥接里**硬执行**，不经过模型，也与 DSH 无关。**脱钩丢的不是机器人的性格与行为，只是 LLM 运行时。**

## 五、建议的抽象与落地方式

抽一个薄接口，两个实现并存（可回退、可对比）：

```
src/agent-runtime/
  index.js        ← 按 cfg.runtime.type 选实现（'dsh' | 'direct'）
  dsh.js          ← 现有能力包一层（行为不变）
  direct.js       ← OpenAI 兼容：一次流式请求 + 工具循环
  tools.js        ← 工具schema 注册（从现有 MCP 工具集的 schema 搬）
```

`direct` 模式跑起来后，配置里多一项：

```json
"runtime": { "type": "direct", "baseUrl": "https://api.deepseek.com/v1",
             "apiKey": "...", "model": "deepseek-chat" }
```

**分四步走**（每步都能单独验证）：
1. 抽接口，把现有 DSH 调用包成 `dsh.js`（**行为零变化**，跑通现有测试）
2. 写 `direct.js` 的最小链路：**纯文本问答**（不接工具），用真实 QQ 验证收发
3. 接工具循环：先把只读工具（`qq_get_recent_messages` 等）跑通，再接发送类
4. 上下文管理与压缩；然后用同一套 QQ 场景对比两种运行时的表现

## 六、给决策用的两个事实

- **分发门槛**：现在收件人需要 Node + **DSH** + SnowLuma + ComfyUI + 会配 MCP 注入。
  换成 direct 后是 **Node + 一个 API key + SnowLuma**（ComfyUI 可选）。
- **可逆性**：按第五节的做法，第 1 步之后任何时刻都能回退到 DSH 模式；
  只有第 4 步做完才谈得上"替代"。
