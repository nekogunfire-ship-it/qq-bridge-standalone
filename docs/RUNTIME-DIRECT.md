# 切换到 direct 运行时（不用装 DSH）

direct 运行时直接对接**标准 AI API**（OpenAI 兼容），不需要 DSH 环境。
本文档是上线前预检与排障的操作说明。

## 一、先跑预检（**强烈建议**）

```powershell
# ① 只查配置形状（离线，不发请求、不用 key）
node tools/check-direct-runtime.mjs

# ② 真发一次最小对话请求（验 key 与模型名）
node tools/check-direct-runtime.mjs --live

# ③ 带工具发一轮，看【模型会不会调工具】（最关键的一步）
node tools/check-direct-runtime.mjs --tools
```

**为什么必须先跑第 ③ 步**：代码全对但模型不会调工具时，机器人会"**只会说话、不会做事**"
（不会收发消息、不会出图）。这是最容易被忽略、也最致命的一环 ——
`--tools` 会直接告诉你答案，不用从桥接日志里猜。

预检通过就说明**外部那一段**是通的，再去改 config.json 试真实聊天。

## 二、改 config.json

在顶层（与 `dsh` / `allow` 平级）加：

```json
"runtime": {
  "type": "direct",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "你的key",
  "model": "deepseek-chat"
}
```

| 字段 | 说明 |
| --- | --- |
| `type` | `dsh`（默认）或 `direct` |
| `baseUrl` | **写到 `/v1` 为止**，不要带 `/chat/completions` |
| `apiKey` | 本地 Ollama 之类可留空 |
| `model` | 需要用**支持 function calling** 的模型 |
| `maxTurns` | 会话历史保留轮数，默认 20 |
| `timeoutMs` | **单次模型请求**超时，默认 120000（不含工具执行时间）|
| `turnTimeoutMs` | **整轮**（模型请求 + 工具执行 + 工具循环）保险上限，默认 600000；`0` = 不限 |
| `maxToolRounds` | 工具循环上限，默认 8；撞上限时**不带工具再问一次让它收尾**，这一轮按成功计 |
| `tools` | 设 `false` 则不起工具层（AI 只能说话）|
| `images` | 设 `false` = 不看图（不解析媒体、工具图片也不交给模型），默认开 |

**两级超时（2026-09-26 修正）**：

- `timeoutMs` 只管**一次模型请求**：从每次请求发出时重新计时，工具执行时间不算它的；
- `turnTimeoutMs` 管**整轮**：从这一轮开始计时，模型请求 + 所有工具执行 + 工具循环都算。

为什么必须分开：QQ 侧的 `qq_wait_for_messages` 是**真实长轮询**（普通等待 30 秒起，"沉睡前
观察"按操作规程要 `timeoutMs=300000` 等满 5 分钟）。旧实现只有**一个** 120 秒定时器、而且从
整轮起点开始计时 → 工具等待把预算吃光，AI 只要按规程收尾就**必然**超时（现象：QQ 里出现
`⚠️ 消息未能送达 AI：请求超时（120000ms）`，日志里是 `[direct] <key> 请求失败：请求超时（120000ms）`
紧接 `唤醒投递被拒`）。现在单次请求仍是 120 秒，整轮默认给到 10 分钟，容得下那 5 分钟观察。

**撞到工具轮数上限怎么办（2026-09-26 修正）**：忙群里模型可能在同一轮里反复「发消息 + 等待」，
撞满 `maxToolRounds`。旧行为是整轮返回失败 → QQ 里出现
`⚠️ 消息未能送达 AI：工具调用超过 N 轮仍未结束`，看着像机器人坏了（其实消息早就通过工具发出去了）。
现在改成最后一轮**不带工具的收尾请求**：让模型用手里的信息自然收尾，这一轮按成功计，
日志里会写「触到 N 轮上限后收尾」。只有收尾请求本身失败（网络/超时）才报错。

**本地模型（Ollama）示例**：

```json
"runtime": {
  "type": "direct", "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKey": "ollama", "model": "qwen2.5:7b"
}
```

## 图片/视觉（2026-09-26 起 direct 也能看图）

以前 direct 模式**看不了图**，两处都断在桥接侧（不是模型不支持）：

- **群友发的图**：桥接的 direct 分支整段丢掉了 `media`（只有 DSH 分支会解析），图根本没进 prompt；
- **`qq_get_message_images` 的返回**：工具层只把文本喂回模型，图片块被数一下、回一句「暂不支持」，
  于是"先取图再描述"这条路走不通。

现在两条都通了：

- 消息带的图片会作为 `image_url`（data URI）随本条 prompt 一起发；表情没有图片字节时退化成文字描述；
- 工具返回的图片会**等一整块 tool 消息补齐后补一条带图的 user 消息**（OpenAI 的 `tool` 消息装不下图片，
  这是标准做法；实测本端点认这种形状）。⚠️ 一轮里**多个**工具返回的图必须**合并成同一条** user 消息：
  逐条补会拼出 `tool(c1) → user(图) → tool(c2)` —— 中间那条 user 把 tool 块切断，服务端整条请求 400
  （`insufficient tool messages following tool_calls message`；2026-09-27 实测：模型并行调 2~4 个
  `qq_get_message_images` 时必现，群里只看到「⚠️ 消息未能送达 AI」）。

限制与取舍：

- 图片只活在**这一次请求**里、不进会话历史（否则每轮都要重发那张图的 token）；
- **字节上限**：桥接单条消息取图上限 `socialV2.mediaMaxBytes`（默认 **12MB**，2026-09-26 从 4MB 抬高——
  群里随手一张截图/照片/GIF 就超 4MB，卡在抓取阶段会让模型只看到"图片获取失败"）；
  内联给模型的上限是 `MAX_INLINE_IMAGE_CHARS`（2000 万字符 ≈ 15MB），超过的图**会在消息里明说"没附上"**；
- 大图贵的是带宽不是上下文：图片 token 按尺寸折算且有上限（实测 2048×2048 与 1800×1800 都只有 ~1k token），
  12.4MB 的 base64 实测 HTTP 200 / 3.3 秒；
- 想彻底关掉看图（省 token）：`runtime.images = false`。

这条链路依赖模型支持视觉 —— `api.deepseek.com/v1` + `deepseek-flash` 实测可以
（合成图能准确说出配色；对群里真实图片的描述与实际画面一致）。

## 三、重启并看日志

```powershell
tools\restart-bridge-and-dsh.ps1     # 默认只重启桥接（不动 DSH）
```

日志在 `state/bridge.log`，应该出现：

```
运行时：direct —— https://api.deepseek.com/v1 · model=deepseek-chat · key=sk-xxxx…（NN 字符）
[direct] 工具已就绪：41 个（3 个 MCP server），其中 41 个会交给模型
[tools] snowluma: 38 个工具 | snowluma-host: 1 个工具 | web-search-safe: 2 个工具
[direct] 跳过 DSH 连接与探活；模式取自 state/mode.json：reserved2
[direct] reserved2：AI 靠工具说话（已保留发送类工具），桥接不自动转发
[direct] reserved2 的两个护栏已接上（无行动兜底 / 唤醒条件防遗忘）
```

然后在群里 @ 它一句，正常应有：

```
[direct] group:xxxxx 已回复（reserved2·工具发言） token 1234 · 工具：qq_get_unread_messages,qq_send_message
```

## 四、两种模式的区别（会影响你怎么用）

| 模式 | 谁发消息 | AI 拿到的工具 | 什么时候适用 |
| --- | --- | --- | --- |
| `chat` | **桥接自动转发** AI 的文本 | **不含**发送类工具（避免重复发）| 简单的问答式机器人 |
| `reserved2` | **AI 自己调工具**说 | **含**发送类工具 | 二代仿真（会潜水、会自己决定何时开口）|

模式取自 `state/mode.json`。**两种模式对发送类工具的要求正好相反**，桥接会按当前模式自动调整。

## 五、常见问题

| 现象 | 原因与处置 |
| --- | --- |
| `HTTP 401: Invalid API key` | key 不对或没填 |
| `HTTP 401: Authentication Fails (governor)` | 同上（DeepSeek 的措辞）|
| `HTTP 404: model not found` | 模型名拼错，或 `baseUrl` 少了/多了 `/v1` |
| `HTTP 402: Insufficient` | 余额不足 |
| `请求失败：fetch failed（ECONNREFUSED…）` | 端点没人监听（本地模型没启动？）|
| `请求失败：fetch failed（ENOTFOUND…）` | 域名解析不了（网络或代理问题）|
| `请求失败：fetch failed（SELF_SIGNED_CERT_IN_CHAIN…）` | **证书信任问题，见下方专节** |
| `请求超时（120000ms）` | **单次**模型请求超时：网络慢或模型太慢，可调大 `timeoutMs` |
| `整轮超时（600 秒未收尾）` | 这一轮里工具跑太久（典型：`qq_wait_for_messages` 长轮询），可调大 `turnTimeoutMs` |
| 日志出现 `⚠️ 本回合 AI 没有发消息` | AI 没调发送类工具 —— 看它调了什么工具（同一行有列出）|
| 日志出现 `⚠️ 有工具调用失败` | 具体工具调用报错，按工具名排查 |
| 机器人"只会说话、不会做事" | **模型不支持 function calling** → 跑 `--tools` 确认，换模型 |

## 六、证书错误（SELF_SIGNED_CERT_IN_CHAIN 等）

**症状**：偶发失败，报 `fetch failed（SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain）`，
但其它时候一切正常。

**原因**：机器上有**安全软件或代理在做 HTTPS 拦截**（卡巴斯基、企业代理、某些杀软的"网页防护"）。
它给每个 HTTPS 连接换成自己签的证书 —— 这个根证书在 **Windows 证书存储**里，所以浏览器和其它
程序都正常；但 **Node 默认只用自带的证书库**（约 150 个），不读系统存储 → 不信任它 → 偶发失败。
（"偶发"是因为拦截不是每个连接都做。）

**验证**：
```powershell
node -p "require('node:tls').getCACertificates('default').length"        # 约 150 = 只用自带
node --use-system-ca -p "require('node:tls').getCACertificates('default').length"   # 约 257 = 含系统存储
```

**修复（二选一）**：
1. **让桥接用系统证书库启动** —— 启动前设环境变量：
   ```powershell
   $env:NODE_OPTIONS = "--use-system-ca"
   ```
   或在启动命令里直接带：`node --use-system-ca src/bridge.js`
2. **在该安全软件里放行** —— 把 `api.deepseek.com`（或你的 API 域名）加入
   "不扫描加密连接"/"信任的站点"白名单。

**为什么不做成默认开**：`--use-system-ca` 会让 Node 信任系统存储里的**全部**根证书
（含那个拦截者的）—— 这与浏览器的信任模型一致，但确实**放宽了信任范围**，
所以做成需要你显式开启的选择，而不是默认替你决定。

## 七、切回 DSH

把 config.json 里的 `runtime.type` 改回 `"dsh"`（或整段删掉）再重启即可。
**两种运行时随时可切换**，互相不影响。

## 八、防"同一件事回两遍"（2026-09-27）

**事故形态**（群 200000001 实测）：AI 在 00:26 正常回完"你不是多模态吗"；随后回合里它反复调
`qq_wait_for_messages` 把 12 轮工具预算打满 → 收尾请求结束本轮 → 因为没设置唤醒条件，
护栏②投递【提醒】**开了一轮新对话** → 提醒回合里它一读未读，那条早回过的 @ 还在未读里
（**发消息不会清未读**，只有 `qq_mark_read` 会清），而它的上下文里没有任何"我已经回过"的证据
（direct 的历史只存 assistant 的最终文本，而工具发言那一轮是空串）→ 00:32 又回了一遍。

三处修复，各自守一件事：

| 修复 | 位置 | 作用 |
| --- | --- | --- |
| 【你最近发过的消息】注入唤醒/提醒 prompt | `formatRecentSelfV2`（bridge.js） | 给 AI"我已经说过什么"的证据 |
| 收尾提醒回合**按回合**禁用发送类工具 | `deliverPrompt(..., { noSend: true })` + `listOpenAiTools({ extraExclude })` | 硬护栏：那一轮想重复回也发不出去 |
| 未读里标出"上次发言之前就到的消息" | `/api/socialV2/unread` 的 `repliedBefore` / `repliedHint` | 在它真正查未读时给出判据 |

注意 `extraExclude` 是**按回合**的，不要改成全局 `setExclude` —— 后者会顺带阉掉同一时刻
正在跑的其它会话的发言能力（多个群是并发跑回合的）。

排查看这两条日志：

```
[direct] group:xxxxx 本回合为收尾提醒：已按回合禁用 8 个发送类工具
[reserved2] group:xxxxx qq_wait_for_messages 结束：请求 timeoutMs=… quietMs=… → 实等 …ms，arrived=…
```

自检：`npm run test:anti-repeat`（接线）／`npm run test:anti-repeat-e2e`（沙箱端到端，验到"模型看到的工具表"这一层）。
