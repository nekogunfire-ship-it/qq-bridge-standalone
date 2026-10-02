# 事故复盘：单个 emoji 把整个群会话打成 400（2026-09-25）

## 现象

- QQ 群里（`group:200000002`）机器人从 10:56 起彻底不出声，只在被 @ 时回一句：
  `⚠️ agent 处理出错：DeepSeek Messages request failed (400)`。
- 桥接日志正常（SnowLuma 已连接、消息已入未读、唤醒都成功），只有 agent 回合以 error 结束。
- 12:54 重启桥接**无效**，照样 400。

## 定位过程（可复用）

1. **看会话日志**：DSH 会话文件 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`
   是**多帧 zstd**（每个 JSONL 追加一段一个 frame），`zstdDecompressSync` 只能解开第一帧，
   必须按 magic `28 B5 2F FD` 切帧逐段解压才能读全。
   读出来后按 seq 排序可见：**turn 84 起每一轮都是**
   `assistant/attempt → finish.reason.kind=error, message="DeepSeek Messages request failed (400)"`，
   且失败发生在 `step/start` 之后 **0.5 秒内**——不是超时、不是模型问题，是**请求体被拒**。
2. **排除体积**：`session_projcache/sessions/<id>.json` 里的 `costUsage.last` 记录了每次请求的
   token 用量。坏会话最后一次成功请求 `cacheRead=563,968`，而另一个**正常**会话（`group:200000003`）
   已经跑到 `576,512` 还活着 → 与上下文长度无关。
3. **复现服务端行为**：直接用 API key 打 `https://api.deepseek.com/anthropic/v1/messages` 做对照实验：
   - 伪造 `file_id` → 400，但错误体是标准 JSON（`error.message` 有内容）；
   - 超长上下文 → 400，同样是标准 JSON；
   - **请求体里塞一个落单的 `\ud83d` 转义 → 400，错误体是纯文本**：
     `Failed to parse the request body as JSON: ... unexpected end of hex escape`。
     纯文本错误体没有 `error.message`，DSH 只能兜底成 `DeepSeek Messages request failed (400)`
     ——与日志里看到的一字不差。
4. **在会话里找脏字符**：扫描会话所有字符串，正则
   `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`
   命中 4 处，全部来自 turn 84 的注入 prompt：

   ```
   - 10:53 落晴.~喵：中秋没事干？…每日收入0元，就是为了操操操群主。 🐇 🐇 … 🐇 🐇 <半个🐇>
   ```

## 根因

`src/bridge.js` 构造【刚收到的消息】摘要时写了 `String(m.text).replace(/\s+/g,' ').slice(0, 80)`。
那条刷屏消息正文长 37 个码元，后面跟一串 `🐇 `（每只 3 个码元），第 80 个码元正好落在一只兔子的
**高代理项**上：

```
正文(37) + 14 只兔子(42) = 79，第 80 个码元 = 第 15 只 🐇 的 \uD83D  ← 半个 emoji
```

这半个 emoji 随 prompt 写进 DSH 会话历史 → 之后**每一次**请求都会把它序列化进请求体
（`JSON.stringify` 会把它写成落单的 `\ud83d`）→ DeepSeek 每次都 400。
同理，`slice(0, 200)` / `slice(-200)` 等所有按码元截断的写法都有这个风险，只是恰好这次是 80 那一刀。

## 修复

新增 `src/text-safety.js`：

| 函数 | 用途 |
| --- | --- |
| `safeSlice(text, n)` | 取前 n 个码元；结尾是高代理项就回退一位，绝不劈开 |
| `safeSliceTail(text, n)` | 取后 n 个码元；起点是低代理项就后移一位 |
| `stripLoneSurrogates(text)` | 清掉已存在的孤立代理项（外部/历史脏数据兜底） |
| `stripLoneSurrogatesDeep(v)` | 递归清理对象/数组里的字符串（状态文件加载用） |

接入点（`src/bridge.js` / `src/slang-learner.js`）：

- 所有“截断后进状态或进 prompt”的地方改用 `safeSlice` / `safeSliceTail`：
  `appendRecentMessage`、`appendSummary`、未读队列 `text/plain/tail`、引用消息文本、
  【刚收到的消息】摘要（事故点）、【此刻状态】摘要、自己发言记录、黑话证据、learner prompt 语料。
- **投递兜底**：所有 `api.sessions.prompt()` 的文本一律先过 `stripLoneSurrogates()`
  （`withSlangContext` 内 + 两个 learner 调用点）——即使以后再漏，也进不了会话历史。
- **加载净化**：`loadSocialV2State` / `loadSlang` 载入时 `stripLoneSurrogatesDeep`，
  `saveSlang` 落盘时也清理一遍，历史脏数据自动自愈。

回归测试：`npm run test-text-safety`（`scripts/test-text-safety.mjs`，32 项断言），
其中包含事故字符串的**逐字复现**、穷举全切点性质测试，以及“旧写法确实会劈开 emoji”的对照组；
另有 `npm run test-slang-prompts`（`scripts/smoke-slang-prompts.mjs`）覆盖黑话 prompt 构造。

排查/巡检工具（`tools/`）：

- `node tools/read-dsh-session-log.mjs <session.v4.jsonl.zstd> [tail]`
  —— DSH 会话日志是多帧 zstd，这个脚本按 magic 切帧全解出来（`zstdDecompressSync` 只解第一帧，
  直接读会以为会话只有一行）。
- `node tools/scan-lone-surrogates.mjs [--session] <file...>`
  —— 扫孤立代理项，**同时扫原始字符和 `\ud83d` 这种落单转义**（JSON 文件里以后者形式存在，
  只扫原始字符会漏报）。

### 上线时又踩的一个坑（值得记住）

补丁首次上线后桥接日志出现：

```
[reserved2] 计划唤醒异常 group:200000002: stripLoneSurrogates is not defined
```

原因：`src/slang-learner.js` 里用了 `stripLoneSurrogates`，但 import 只带了 `safeSlice` /
`stripLoneSurrogatesDeep`。`node --check` 只查语法，**查不出未定义的标识符**——这类错误只能在
运行时暴露。所以改完必须：① 跑 `npm run test-text-safety`；② 跑会真正调用这些函数的冒烟测试
（`npm run test-slang-prompts` 就是为此补的）；③ 重启后扫一眼 `state/bridge.log` 有没有
`is not defined` / `计划唤醒异常`。

## 已损坏会话怎么救

会话历史里已经写进脏字符的会话**不会自愈**（除非压缩上下文到把它丢掉），处理方式二选一：

1. **清除上下文（推荐，代价最小）**：桥接控制台点「清除上下文」，或
   `POST http://127.0.0.1:3100/api/session/reset  {"key":"group:xxxx"}`。
   桥接会归档旧 DSH 会话、下次消息重建新会话；DSH 侧旧历史仍留在 `~/.dsh/sessions/`。
2. **手术式修复会话日志**（保留上下文，需停机）：把 `session.v4.jsonl.zstd` 全部帧解压 →
   替换落单转义 → 重新压成 zstd → 删掉 `~/.dsh/storages/session_projcache/sessions/<id>.json`
   → 重启 DSH 让它重新加载。因为 DSH 进程里持有会话内存态，**必须重启**才生效。

本次采用方案 1，并顺手把 `state/sessions.json` 里该群的映射删掉（保留 bridge 侧状态：
未读、唤醒配置、agentToken），重启桥接时一并完成，避免整块状态被重置。

实际执行记录（2026-09-25 13:12–13:22）：

1. 停掉桥接（那会儿桥接/SnowLuma 已经因为 SnowLuma 断连 + 手工停摆处于停摆状态）；
2. 备份并改写 `state/sessions.json`：删掉 `group:200000002` 的 `sessions` / `sessionPolicies`
   两条（备份：`state/sessions.json.bak-20260925-131241-before-lone-surrogate-reset`）；
3. 用 `tools/qq-bridge-launcher.ps1 -Action restartAll` 重新拉起 SnowLuma + 桥接（**不重启 DSH**）；
4. 桥接日志立刻出现
   `新会话 group:200000002 -> session-7600aba1-7c07-41a2-ab5e-117f9737a8e4（模式 reserved2，preset: qq-chat-v2）`，
   紧接着 `工具统一发送 group:200000002: 成功 1/1 条` —— 群里机器人恢复正常说话。

> 踩坑提醒：用 `Start-Process -RedirectStandardOutput` 调启动器会 `spawn EPERM`；直接
> `& powershell -File tools\qq-bridge-launcher.ps1 ... *> log` 会在管道上挂住（子进程继承 stdout，
> 命令一直不返回，被 DSH 丢进后台 job）。另外**别用 job_kill 杀那个卡住的启动器任务**：
> 它和启动器/子进程是同一棵进程树，杀 job 会把刚拉起来的桥接一起带走。
>
> 好用的姿势是让启动器**脱离当前控制台**跑，命令立刻返回、也不留后台 job：
>
> ```powershell
> cmd /c 'start "" /min powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\...\tools\qq-bridge-launcher.ps1" -Action restart -Target bridge -OutFile "C:\...\tools\runtime\launcher-bridge-restart.json"'
> ```
>
> 之后看 `launcher-bridge-restart.json`（`ok/health/services`）和 `state/bridge.log` 的
> `桥接已启动` 即可确认。
