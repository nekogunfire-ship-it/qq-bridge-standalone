# 补丁：让 token 反查 key（去掉 reserved2 工具的冗余 key 参数）

> 状态：**未应用、未测试**。本补丁由代码阅读得出，改动环境无法执行 shell，
> 因此没跑过任何测试。请按第 5 节逐条验证后再合入。

## 1. 这个补丁解决什么

`reserved2`（二代仿真）下每个 `qq_*` 工具都要求模型传两个参数：

```jsonc
{ "key": "group:123456", "token": "a1b2c3..." }   // key 和 token 是冗余的
```

原因是 `key` 和 `token` **一一对应**：会话身份由 `socialV2.conversations.get(key).agentToken`
唯一决定（`bridge.js:1434` 用 `crypto.randomBytes` 生成，`bridge.js:5618-5627` 的 `seenTokens`
保证不重复）。拿到 token 就能反查出 key，模型没必要知道自己在哪个会话——**这本身就是
一层多余的权限面**：模型少知道一个可寻址的会话标识，就少一条走错会话的路径。

改完后模型只传 `token`，`key` 由桥接反查。收益：

- 每个 v2 工具少一个必填参数（28 处重复的 `'会话 key，格式 group:群号 或 private:QQ号'` 全部消失）；
- 模型物理上无法把消息发到别的会话（它根本不知道别的 key）；
- 与 QQ-agent 的做法同源（它把 chatKey 绑进工具闭包，模型看不见）。

## 2. 为什么 key 不能全部去掉

`chat` / `closed-agent` 模式下**必须保留** `key`：那两个模式没有"当前会话"概念，
模型是在操作任意群/好友，`key` 是唯一的目标寻址方式
（`qq_send_group_message` 用 `groupId`、`qq_get_group_history` 用 `groupId`）。

所以本补丁的作用域严格限定在 **v2 工具**（即调用 `/api/socialV2/*`、`/api/send/*`、
`/api/images/*` 且带 `x-agent-token` 头的那些）。旧只读工具一个都不动。

## 3. bridge.js 改动（2 处）

### 3.1 新增 token 反查 helper

**位置**：`src/bridge.js`，紧跟 `agentTokenOk` 定义之后（当前约 1589-1593 行）。

在 `agentTokenOk` 那个 `};` 之后、`const v2SessionAllowed = ...` 之前插入：

```js
    // 二代会话：由会话令牌反查会话 key（token 与会话一一对应）。
    // 供 v2 工具在模型没传 key 时自动定位当前会话；查不到返回 null，调用方按原逻辑报错。
    const agentKeyFromToken = (token) => {
      const t = String(token ?? '').trim();
      if (!t) return null;
      for (const [k, st] of socialV2.conversations) {
        if (st && st.agentToken && st.agentToken === t) return k;
      }
      return null;
    };
```

> ⚠️ 注意：遍历的是 `socialV2.conversations`。若其键可能不是规范化的
> `group:<id>` / `private:<id>` 形式，返回值应再过一次 `canonicalV2Key()`
> ——但**不要**因此丢弃原始键，否则 `agentTokenOk` 的取键方式与会话实际键不一致。
> 落地前先确认 `socialV2.conversations` 的键来源（构建点约 5571-5605 行，
> 那里已经在用 `canonicalV2Key(key)`）。

### 3.2 在 `readBody()` 里统一回填 key

**位置**：`src/bridge.js` 的 `readBody` 闭包，`done(parsed);` 那一行（当前 1664 行）。

这是**唯一的注入点**，改这一处即可覆盖全部 v2 端点（GET 端点的 key 在 query 上，
需要各自处理，见 3.3）。把：

```js
          done(parsed);
```

改为：

```js
          // v2 工具：模型可以不传 key —— 用 x-agent-token 反查当前会话并回填。
          // 仅当请求带 agent token 时才回填；控制台/管理端请求（不带该头）行为完全不变。
          try {
            const hdrTok = String(req.headers['x-agent-token'] ?? '').trim();
            if (hdrTok) {
              if (!String(parsed.key ?? '').trim()) {
                const resolved = agentKeyFromToken(hdrTok);
                if (resolved) parsed.key = resolved;
              }
              if (!String(parsed.token ?? '').trim()) parsed.token = hdrTok;
            }
          } catch {}
          done(parsed);
```

顺带解决了另一个隐患：模型以前必须在 **body 和 header 里各传一遍 token**
（`/api/socialV2/mark-read` 这类 POST 传 body.token，同时 header 也带 `x-agent-token`），
两边不一致时行为取决于端点；改为以 header 为准后不会再分叉。

### 3.3 GET 端点的 key

`/api/socialV2/prompt`、`/unread`、`/recent`、`/state`、`/my-recent`、
`/message-detail`、`/active-members`、`/memory`、`/slang/query`、
`/sticker-list`、`/sticker-image`、`/self-image` 的 key 走 query string。

两种做法，**推荐第 2 种**：

1. **MCP 侧改动**（见 4.2）：仍把 `key=${key}` 拼进 URL，但 `key` 改由 MCP
   从 token 推导——**不可行**，MCP 无法知道 key。
2. **桥接侧**：在这些端点的 `const key = String(url.searchParams.get('key') ?? '').trim();`
   之后补一行回填。**更省事的等效做法**：不做 3.3，只把 GET 端点的 `key` 参数
   在 MCP schema 里保留为必填（它们只占一半左右的工具），先把 POST 类工具的 key 去掉。
   POST 类覆盖了发送、mark-read、wake-config、memory、sticker 等**绝大多数调用**。

> 若要做全：GET 端点的回填可以放在统一的位置——每个 v2 GET 端点都在同一段
> `if (req.method === 'GET' && url.pathname === ...)` 链上，可在链首加一次
> `url.searchParams` 的规范化，但 `url` 是 `const`，需要改为可变或另存一个
> `const resolvedKey = ... ?? agentKeyFromToken(req.headers['x-agent-token'])`。
> 建议按端点逐个改，风险更小。

## 4. mcp-snowluma-safe.js 改动（2 类）

### 4.1 schema：`key` 由必填改为可选

对**已按 3.2 支持回填的 POST 类 v2 工具**，把

```js
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
```

改为

```js
    key: z.string().optional().describe('可选：会话 key。省略时由 token 自动定位当前会话，通常不用传'),
```

涉及工具（`grep -n "会话 key，格式" src/mcp-snowluma-safe.js` 可列出全部 28 处）：

| 建议去掉 key（token 已能定位会话） | 保留 key 必填 |
|---|---|
| `qq_get_prompt`、`qq_get_unread_messages`、`qq_get_recent_messages` | `qq_get_group_members` |
| `qq_social_state`、`qq_mark_read`、`qq_set_wake_config` | `qq_get_group_history` |
| `qq_send_burst`、`qq_send_message`、`qq_send_poke` | `qq_send_group_message` |
| `qq_wait_for_messages`、`qq_report_feedback`、`qq_get_my_recent_messages` | `qq_reply` |
| `qq_get_message_detail`、`qq_get_active_members` | `qq_send_private_message` |
| `qq_memory_append/query/remove/clear` | （这些用 groupId/userId 寻址，与会话无关） |
| `qq_slang_query`、`qq_slang_submit` | |
| `qq_get_message_images`、`qq_list_stickers`、`qq_get_sticker_image` | |
| `qq_send_sticker`、`qq_collect_sticker`、`qq_get_self_image` | |
| `qq_sticker_note`、`qq_set_sticker_remark`、`qq_get_forward_msg` | |

左列就是文档里那句话的落点：**模型不再需要知道自己的会话 key**。

### 4.2 工具的 `token` 描述与 preset 提示词

- `token` 的 describe 可简化为 `'会话令牌（见唤醒提示中的【会话令牌】）'` → `'会话令牌'`
  （prompt 里已有完整说明，重复解释每轮都在烧 token）。
- **必须同步改** `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 第 8 条：
  它现在逐字列出了 23 个工具名要求传 token，并明确说要传 key。
  改为一句：「所有 qq_* 工具都要传【会话令牌】；**不要传 key**，省略 key 时桥接会按令牌自动定位当前会话。」
- 别忘了 `scripts/setup-dsh.mjs` 同步到 `~/.dsh`。
  （原先还有 `verify-dsh-015-adaptation.mjs` 断言仓库版与安装版逐字符一致，
  该脚本已归档到 `archive/one-off/` —— 它是针对 DSH 0.1.5 的一次性适配检查，
  现在只保留 `npm run verify:persona` 校验 persona 配置 schema。）

## 5. 验证清单（必须按顺序，全绿才合入）

```bash
cd qq-bridge
npm run test:mcp-servers       # 三个 MCP server 仍能握手 + 工具名合规
npm run test:audit             # 离线回归（不碰真实 QQ）
npm run test:mcp-safe          # 工具清单 + 白名单/参数校验
npm run self-test              # DSH 侧链路
npm run test-console           # 控制台不受影响
```

> ⚠️ 早先这里还列了 `npm run verify:adaptation` —— **该命令已移除**（它跑的是
> `scripts/verify-dsh-015-adaptation.mjs`，已归档到 `archive/one-off/`）。
> 改了 preset 之后现在只跑 `npm run verify:persona`。

**手工验证（关键，测试覆盖不到）**——在 `reserved2` 下：

1. 群里发消息触发唤醒 → 模型调 `qq_get_unread_messages` **只带 token** → 应返回当前群未读；
2. 让机器人发言 → `qq_send_message` **只带 token** → 消息应发到**当前**群；
3. **反例测试**：手动用一个会话的 token 去调另一个会话的 key（或直接调
   `POST /api/socialV2/mark-read` 带 A 会话 token + B 会话 key）→
   **必须 403**。这是本补丁的安全底线：回填只应在 key 为空时发生，
   **绝不能覆盖显式传入的 key**（3.2 的 `if (!String(parsed.key ?? '').trim())` 就是守这条）；
4. `chat` / `closed-agent` 模式下旧工具的行为不变（`qq_send_group_message` 仍按 `groupId` 发）。

## 6. 回退

- 只回退注入点：删掉 3.2 加的那段 `try { ... } catch {}`，其余保留——此时模型若仍传 key，
  行为与打补丁前完全一致（可安全停在中间态）。
- 全部回退：`git checkout -- src/bridge.js src/mcp-snowluma-safe.js`。

## 7. 已知风险

1. **并发会话**：反查靠 token 精确匹配，不依赖"最近活跃"，因此多群同时唤醒也不会串会话
   ——这是本方案优于"记住最近会话"的地方。但如果 `socialV2.conversations` 的键与
   `agentTokenOk` 的取键不一致（见 3.1 的警告），会出现"能反查到但校验不过"，
   表现为 403。发现 403 先查这里。
2. **`check-send` 未在 MCP 侧调用**（`grep check-send src/mcp-snowluma-safe.js` 无结果），
   所以它的 `key/tool/token 不能为空` 校验不影响本补丁；但若将来接上，需要一并放宽。
3. **token 仍在 prompt 里**（`bridge.js:6962`、`7021` 的 `【会话令牌】` 行），
   每轮重复。本补丁没动它——那是独立的下一步优化（可只在 `qq_get_prompt` 里返回，
   首次调用后由模型带入后续调用，但那会引入"忘记带 token"的新失败模式，
   需要单独评估）。
