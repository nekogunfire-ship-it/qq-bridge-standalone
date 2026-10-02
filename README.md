# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> [!IMPORTANT]
> **上游引用与原创改进说明**
>
> 本项目引用并基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的桥接方案继续开发。感谢原项目提供的 QQ、SnowLuma 与 DeepSeek Harness 集成基础。
>
> **本仓库由 [@nekogunfire-ship-it](https://github.com/nekogunfire-ship-it) 原创设计与实现的重点部分：**
>
> - 完全脱离 DSH 也能运行的 Direct AI Runtime，以及对应的模型探测、热切换和独立配置逻辑；
> - 桌面图形界面的整体重构、状态引导、故障提示和运行时配置体验；
> - 核心会话与工具调用逻辑优化、公共运行时工具抽取及代码精简；
> - 配置密钥隔离、日志遮罩、隐私扫描、安全打包和发布脱敏流程；
> - 独立运行、桌面端、UI、MCP、安全与发行包的自动化验证体系。
>
> 上游基础与本仓库原创改进的归属分别按上述说明认定；第三方依赖仍遵循各自许可证。

当前版本作者与维护者：[@nekogunfire-ship-it](https://github.com/nekogunfire-ship-it)

> 📘 详细内外核说明书见 **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**（架构、数据流、配置全解、调试与改进指南）。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

<details>
<summary>📚 全部文档索引</summary>

| 文档 | 内容 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | **交接说明（给接手的 AI agent）**：当前状态、红线、架构地图、待办、协作方式 |
| [docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md) | 项目说明书：架构、数据流、配置全解 |
| [docs/DSH_SETUP.md](docs/DSH_SETUP.md) | DSH 侧安装与配置（preset 部署、自检） |
| [docs/SLANG.md](docs/SLANG.md) | 群聊黑话学习与「黑话命中唤醒」 |
| [desktop/README.md](desktop/README.md) | 桌面版：启动方式、看门狗、卸载与配置入口、本机约束 |
| [RULES.md](RULES.md) | 权限边界与安全承诺 |
| [roles/README.md](roles/README.md) | 角色设定怎么加 |
| [docs/PATCH-token-key-dedup.md](docs/PATCH-token-key-dedup.md) | 改动记录：工具 token 参数精简 |
| [docs/DSH-DECOUPLING-ANALYSIS.md](docs/DSH-DECOUPLING-ANALYSIS.md) | 可行性分析：与 DSH 脱钩、改接普通 AI 平台（实测耦合面） |
| [docs/RUNTIME-DIRECT.md](docs/RUNTIME-DIRECT.md) | **切换到 direct 运行时**：预检、配置、排障（不用装 DSH） |
| [docs/AUDIT_REPORT_2026-09-18.md](docs/AUDIT_REPORT_2026-09-18.md) | 审查报告（历史记录） |
| [docs/incident-2026-09-25-lone-surrogate-400.md](docs/incident-2026-09-25-lone-surrogate-400.md) | 事故复盘：孤立代理项导致整会话 400（历史记录） |
| [archive/one-off/README.md](archive/one-off/README.md) | 归档的一次性探针脚本，各自当年查了什么 |

</details>


把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

> ⚠️ **当前版本 `v0.2.1`，兼容 DSH 0.1.5-rc.1，并支持完全脱离 DSH 的 Direct Runtime**。安装程序可选安装 DSH 兼容组件、ComfyUI 环境和 SDXL 图片模型。DSH 模式使用 Cookie 鉴权、斜杠 RPC 和 `/api/remote.mux` 事件流。
>
> 默认分支 `main` **就是**本版本，`git clone` 直接拿到，无需切换分支。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：适配 DSH 0.1.2 起、0.1.5 复核通过的协议——launch token 换 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。会话模型由桥接按 `config.json` 的 `dsh.model` 逐会话 `session.selectModel` 固定（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：`snowluma_status`（默认只读探活）；`start_snowluma` / `stop_snowluma` 需显式开启 `snowluma.allowProcessControl: true` 且仅在 `closed-agent` 模式可用
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset（`~/.dsh/.agent-presets/qq-chat/agent.cordis.yml`），`reserved2` 使用 `qq-chat-v2`（`~/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml`）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ 完整工具（默认用 DSH 自己声明的默认 preset，即 `standard`；可在控制台「closed-agent preset」下拉改为任意 DSH preset），可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）
- **群聊黑话学习与「黑话命中唤醒」**：桥接会从群聊里提取黑话/网络用语候选、自动联网考究，够确定的自动转正入库；已确认词条会注入 AI 聊天上下文，并成为实时识别信号——群里再出现这些词会**大幅提高唤醒概率**（强信号直接叫醒 AI，弱信号按加成系数抬概率）。控制台「08 群聊黑话 / 网络用语库」可增删改、批量转正、一键「回填研究」；详细机制、参数与排障见 [`docs/SLANG.md`](docs/SLANG.md)，自测脚本 `node state/agents/verify-slang-wake.mjs`

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

### 推荐：使用 Windows 安装程序

从 [Releases](https://github.com/nekogunfire-ship-it/qq-bridge-standalone/releases/latest) 下载 `QQ-Bridge-Standalone-Setup-*.exe`。安装程序会先显示安装计划，再由用户决定是否安装下列可选组件：

| 安装选项 | 说明 |
| --- | --- |
| **DSH 兼容环境** | 需要连接 DeepSeek Harness 时选择；不选则保留完全脱离 DSH 的 Direct Runtime 运行方式。 |
| **ComfyUI 官方 Portable** | 安装本地图片生成环境；可根据显卡选择 NVIDIA 新版、NVIDIA 旧版、AMD 或 Intel 方案。 |
| **SDXL Base 1.0** | 可选图片生成模型，下载量约 **6.9 GB**；安装前会显示并要求明确接受 Open RAIL++-M 许可证。 |

未选择的组件不会下载。QQ Bridge 核心安装与可选组件相互隔离：ComfyUI 或模型下载失败不会破坏桥接程序，之后可在桌面应用的 **「出图」** 页面重试、启动或管理环境。

> 安装程序目前未做商业代码签名，Windows 可能显示“未知发布者”。Release 同时提供 `SHA256SUMS-*.json`，建议下载后核对文件摘要。

### 手动安装

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（新版 DSH 用于换取 Cookie 的进程启动 token）。留空时桥接会自动从 `~/.dsh/guard/logs/server-*.out.log` 发现；DSH 重启后遇到 401 也会自动重新发现并换 Cookie |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录（供 agent 自动启动/停止） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |
| `slang.*` | 群聊黑话学习 / 识别 / 黑话命中唤醒的开关与参数，见 [`docs/SLANG.md`](docs/SLANG.md)；最常用的是 `slang.wakeEnabled`、`slang.wakeProbabilityMultiplier`、`slang.autoPromoteConfidence` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/DSH_SETUP.md](docs/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。DSH 已安装并运行，缺的是 SnowLuma 本体 + 桥接侧的 DSH 端安装（**第 2、3 步最容易漏，漏了 QQ 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/nekogunfire-ship-it/qq-bridge-standalone.git
   cd qq-bridge-standalone
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 5 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 QQ 上没反应。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（找回占用 3100 端口的旧实例 → 清理锁 → 重新启动守护 → 校验新路由已加载 → 重启 DSH 子进程）。等价命令：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart-bridge-and-dsh.ps1`
- 想先确认到底哪一步没生效：`npm run probe-routes`（列出运行中桥接实际加载的路由）与 `node scripts\restart-status.mjs`（一行判定"是否已加载新代码 / 是否还在处理消息"）
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 QQ 消息在桥接进程内排队（最多 50 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `~/.dsh/.agent-presets/qq-chat*/` 或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

## 自测（不需要 SnowLuma / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit
npm run test-text-safety   # 32 项断言：emoji 截断不得劈开代理对（否则整会话 400，见下）
npm run test-slang-prompts # 黑话 prompt 在脏文本下不抛错、输出无孤立代理项（7 项断言）
```

本轮审查与修复明细见 [docs/AUDIT_REPORT_2026-09-18.md](docs/AUDIT_REPORT_2026-09-18.md)。升级后会为没有权限元数据的历史映射重建一次 QQ 会话；模式或 preset 变化也会自动重建，避免保留旧权限。旧历史仍在 DSH 中。

> ⚠️ **文本截断的坑**：群消息里的 emoji 在 UTF-16 里占两个码元，用 `String.slice(0, N)` 直接截断
> 可能切出“孤立代理项”（半个 emoji）。这种文本一旦进 prompt，DeepSeek 解析 JSON 就会 400
> （`⚠️ agent 处理出错：DeepSeek Messages request failed (400)`），而且那条历史会**永久污染该会话**，
> 之后每一轮都失败。新增/修改任何“截断后进 prompt 或进状态”的代码，一律用
> `src/text-safety.js` 的 `safeSlice` / `safeSliceTail`；完整复盘见
> [docs/incident-2026-09-25-lone-surrogate-400.md](docs/incident-2026-09-25-lone-surrogate-400.md)。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

验证 ComfyUI 出图链路（不需要 DSH / QQ，只要 ComfyUI 在跑）：

```bash
npm run test-comfy      # 注册面 + 工作流构造（多底模/角色LoRA）+ 路径围栏 + 真机出图
npm run test-comfy-fence   # 对着运行中的桥接测 send-image 路径围栏（9 项断言，只测拒绝，不会真发图）
npm run probe-routes       # 探测运行中的桥接到底加载了哪些路由（区分旧/新代码）
node src/comfy-client.js --prompt "1girl, solo" --out out.png   # 只测出图，不经过 QQ
```

改动 `src/bridge.js` 或 `src/mcp-snowluma-safe.js` 后，重启工具链可自检：

```bash
npm run tooling:check   # 用 Windows PowerShell 5.1 解析器检查 tools\*.ps1 语法
npm run tooling:test    # 隔离测试重启脚本的端口发现与结束进程逻辑（9 项断言）
```

## 改完代码怎么让改动生效

**必须重启，两个都得重启**，原因不同：

| 改了什么 | 为什么要重启 |
| --- | --- |
| `src/bridge.js`（新增 HTTP 端点等） | 运行中的进程已经加载过旧代码，不会自动重载 |
| `src/mcp-snowluma-safe.js`（新增 MCP 工具） | `@deepseek-ai/dsh-mcp-client` 用 `ctx.effect(() => dispose, "mcp-client.connection")` 把 stdio 连接挂在 **Host 生命周期**上；只有重启 DSH 才会重新 spawn MCP server 并重新 `tools/list` |

一条命令（或双击 `tools\重启桥接并让画图工具生效.bat`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart-bridge-and-dsh.ps1
```

它会：结束占用 3100 的旧桥接（`Get-NetTCPConnection`，失败退化为解析 `netstat`）→ 委托权威启动器
`qq-bridge-launcher.ps1 -Action restartAll` 拉起新桥接 → 校验 `/api/socialV2/send-image` 已加载 →
校验已连上 SnowLuma。

**默认不重启 DSH**（所以不会打断你正在用的网页端）——这是刻意的，与启动器里
`Stop-AllServices` 的注释同一个理由。只有当你**新增/删除了 MCP 工具**、需要 DSH 重新挂载工具面时，
才加 `-RestartDsh`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart-bridge-and-dsh.ps1 -RestartDsh
```

加 `-DryRun` 可只做检查、不动任何进程。重启期间 QQ 消息由桥接入队，DSH 回来后自动补投，不丢消息。

> 早期版本默认就重启 DSH，导致「每次跑这个脚本 DSH 就掉线」；已改为默认不动它。

> 为什么不复用旧的 `restart.bat` 实现：它用 WMI（`Get-CimInstance`）找进程，在受限环境会
> 返回「拒绝访问」，脚本静默跳过 → 旧桥接继续占着 3100 → 新实例 `EADDRINUSE` 退出 →
> 表现为「重启了但还是旧代码」。现在 `restart.bat` 已改为委托上面这个 ps1。

改这两个脚本时有两个编码坑，必须守住（否则脚本会直接崩，且报错信息具有误导性）：

- **`.bat` 必须纯 ASCII**。cmd.exe 用系统 ANSI 代码页（cp936）读无 BOM 的 .bat，UTF-8 中文会被
  解坏并**吃掉后一个字符**，于是 `echo` 行断裂、cmd 报 `'xxx' 不是内部或外部命令`，而
  `powershell.exe` 那行根本执行不到 —— 表现为「双击了但什么都没发生」。中文说明一律放
  `.ps1` 或 `tools\messages.json`。
- **`.ps1` 若含中文，必须带 UTF-8 BOM**。Windows PowerShell 5.1 同样按 ANSI 解码无 BOM 的
  .ps1，中文会变乱码并触发 `Missing closing '}'` 这类假语法错误。编辑后跑一次
  `node tools\ensure-ps1-bom.mjs`（`--check` 只检查），别手改。

## QQ 里画图（ComfyUI 集成）

群友在 QQ 里说「画个 xxx」，AI 会在**本机 ComfyUI** 出图并直接回发到群里。

### 应用内一键安装

桌面应用顶部新增了 **「出图」** 页，可直接完成：

1. 按显卡选择 NVIDIA 新版 / NVIDIA 旧版 / AMD / Intel 官方 Windows Portable 环境；
2. 选择安装目录并查看实时下载、解压进度，也可取消下载；
3. 阅读并接受模型许可证后，下载 Stability AI 官方的 SDXL Base 1.0；
4. 自动写入 `config.json` 的 ComfyUI 输出目录与 `sdxl-base` 模型预设；
5. 在同一页启动、停止或打开 ComfyUI，并可直接打开模型目录。

安装状态保存在忽略版本控制的 `state/comfy-install.json`，不会把机器路径写进公开仓库。环境与模型体积较大，下载只在用户点击并确认后开始。

链路：

```
QQ 消息 → 桥接 → DSH agent 调 mcp__snowluma__qq_draw_image（本地出图）
                              → mcp__snowluma__qq_send_image（回发当前会话）
       → 桥接 /api/socialV2/send-image（路径围栏 + 频率限制 + 白名单 + agent 令牌）
       → OneBot send_group_msg（图片段，可带一句配文）
```

三个工具（挂在 `mcp__snowluma__` 命名空间下，因此天然命中 preset 的前缀白名单）：

| 工具 | 作用 |
| --- | --- |
| `qq_draw_image` | 文生图。英文 Danbooru 标签提示词；返回图片在服务器上的路径。**只出图，不发送**。可用 `model` 参数切换底模预设。 |
| `qq_send_image` | 把刚画好的图发到当前会话，可带一句配文（图片+文字同一条消息）。 |
| `qq_comfy_status` | 查 ComfyUI 是否在线、显卡、可用底模预设与 LoRA；画图失败时排查。 |

配置（`config.json` 的 `comfy` 段）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关，`false` 时三个工具不注册、发送端点也拒绝 |
| `host` | ComfyUI 地址，默认 `http://127.0.0.1:8188`（仅回环） |
| `outputDir` | **安全围栏**：`qq_send_image` 只允许发送这个目录内的图片，默认 `E:\comfyui\ComfyUI\output` |
| `defaultModel` | 默认用哪个预设（见 `models`） |
| `models` | **多底模预设表**（见下节） |
| `characterLoras` | **角色 → LoRA 映射**（见下节） |
| `autoLora` | 是否自动挂预设自带的 LoRA；工具传 `loras: []` 可对单次请求关闭 |
| `defaultWidth` / `defaultHeight` | 默认尺寸，工具入参会规整到 8 的倍数、限制在 256~1536 |
| `timeoutMs` | 单张出图等待上限，默认 300 秒 |

### 多底模：可为不同需求切换不同底模

不同底模族的**加载链完全不同**，不能只换文件名，所以每个预设自带整套参数：

| 族 | 加载方式 | 适用 |
| --- | --- | --- |
| `unet` | `UNETLoader` + `CLIPLoader` + `VAELoader`（三文件分开） | Anima/Qwen 系（本项目默认） |
| `checkpoint` | `CheckpointLoaderSimple`（单文件自带 CLIP 与 VAE） | SDXL 系：Illustrious / NoobAI / Pony |

加一个 SDXL 预设只需在 `models` 里加一条，把 6~7GB 底模放进
`E:\comfyui\ComfyUI\models\checkpoints\`：

```jsonc
"illustrious": {
  "label": "Illustrious（角色 LoRA 生态最大）",
  "family": "checkpoint",
  "ckpt": "wai-illustrious.safetensors",
  "steps": 28, "cfg": 5.5, "scheduler": "normal"   // SDXL 与 turbo 的参数差异很大
}
```

AI 通过 `qq_draw_image` 的 `model` 参数选择预设；群友也能直接说「用 XX 模型画」。
`qq_comfy_status` 会列出所有预设，并**逐个校验模型文件是否真的存在**，缺文件会提前报出来。

### 角色 LoRA：自动挂载 + 触发词注入 + 切底模

冷门角色靠提示词很难画准，业界做法是角色 LoRA。把 LoRA 放进 `models\loras\` 后登记：

```jsonc
"characterLoras": {
  "arona (blue archive)": {
    "lora": "arona.safetensors",
    "triggers": ["arona (blue archive)", "blue archive"],  // 缺失时自动注入提示词
    "model": "illustrious"                                  // 命中时自动切到这个底模
  }
}
```

命中后的行为（键或触发词出现在提示词里即命中）：

1. 自动挂上该 LoRA（`unet` 族用 `LoraLoaderModelOnly`；`checkpoint` 族用 `LoraLoader`，它会同时改写 CLIP，因此文本编码会自动接到 LoRA 之后）
2. 把缺失的触发词补进正向提示词（已存在则不重复注入）
3. 若该条目指定了 `model`，自动切换到那个底模

> 只靠提示词画冷门角色的实测结论：底模**认得出大量 ACG 角色**（阿罗娜、琪亚娜、庭渡久侘歌都认得），
> 但**细节容易走形**（例如把头上的鸟翼画成背后的羽毛翼）。补外形特征标签能修正大部分，
> 剩下的一致性只能靠角色 LoRA 解决。

安全边界：

- 出图工具**不发送**，发送必须显式调 `qq_send_image`，因此频率限制/静默模式/白名单/agent 令牌校验全部复用桥接已有逻辑，无法绕过。
- 发送端点先把路径 `realpath` 归一化，再用 `path.relative` 判定是否仍在 `outputDir` 内；`..\` 穿越、绝对路径逃逸、符号链接指向外部都会被拒绝。
- 只放行**真实图片字节**（PNG/JPEG/GIF/WebP 魔数），把改名成 `.png` 的文本/凭据挡在外面。
- 单张上限 32MB（发送侧）、16MB（取图侧），避免把超大图塞进 QQ 消息。
- ComfyUI 只是纯计算，工具不暴露任意文件读取能力；返回给 AI 的只有 `outputDir` 内的路径。

应用安装的标准 Portable 环境由启动器直接运行 `ComfyUI/main.py`；旧环境若带有 `main_wrapper.py` 仍保持兼容。ComfyUI 是可选服务，启动失败不会阻止聊天链路。

新增 MCP 工具后需要让 DSH 重新加载 MCP：**重启 DSH**。

> ⚠️ **不要直接裸调 `POST http://127.0.0.1:3780/api/restart`。** 那是"杀旧实例 + 立刻起新实例"：退出码 1，8 毫秒后新实例起来，**端口和 token 都换新**，用户正在看的那一页永远连不回来（管理器的"运行中"只表示"有实例在跑"，它不做心跳探活，所以会绿着）。
> **请改用守卫脚本**：`powershell -File tools\dsh-restart-guard.ps1 -Restart`
> ——会话 5 分钟内有写入时它会**拒绝**并退出 3（并打印原因）；确认要断线再加 `-Force`。只想看状态就省略 `-Restart`（纯只读）。

工具面在 DSH 启动时确定，热改 `src/mcp-snowluma-safe.js` 不会立刻生效；期间 QQ 消息会被桥接入队，DSH 回来后自动补投，不丢消息。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（真实 config.json 不入库）
  install.bat           # 安装程序（复制到安装目录 + 装依赖 + 建快捷方式 + 登记卸载项）
  uninstall.bat         # 独立卸载程序（提权 → 询问数据去向 → 执行）
  uninstall-quiet.bat   # 静默卸载（保留数据与源码）
  docs/
    PROJECT_GUIDE.md    # 项目说明书（架构、数据流、配置全解）
    DSH_SETUP.md        # DSH 侧安装与配置
    SLANG.md            # 群聊黑话学习与「黑话命中唤醒」
    PATCH-token-key-dedup.md  # 工具 token 参数精简的改动记录
    AUDIT_REPORT_2026-09-18.md / incident-*.md   # 审查与事故复盘（历史记录）
  desktop/              # Electron 桌面版（详见 desktop/README.md）
    main.mjs            # 主进程：窗口 / 托盘 / 看门狗 / IPC
    lib/                # launcher 封装、体检、设置、生命周期日志、看门狗、DSH 监测
    renderer/           # 界面（index.html / app.js / style.css）
  dsh/
    agent-presets/      # qq-chat / qq-chat-v2 的 DSH agent preset 模板
    preset-bundle/      # generate-preset-bundle.mjs 的编译产物（部署到 ~/.dsh 用）
  plugins/qq-mode-console  # DSH 插件：注册 qq-mode 设置命名空间（仅 host 半，UI 卡片未实现）
  roles/                # 角色设定（小鲸鱼.md 等，由 AI 在对话中扮演）
  tools/                # 运维工具（见下）
  scripts/              # 测试脚本与一次性诊断脚本
  src/
    bridge.js           # 主程序（OneBot 接入、会话队列、仿真逻辑、/api/* 端点）
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    comfy-client.js     # ComfyUI 出图客户端 + qq_draw_image/qq_send_image/qq_comfy_status
    mcp-snowluma-safe.js # 暴露给 DSH 的 mcp__snowluma__ 工具集
    self-test.js        # DSH 侧自测
  state/                # 运行时数据（不入库）
  archive/one-off/      # 归档的一次性探针脚本（+README 说明各自当年查了什么）
  dist/                 # 打包产物（不入库）
```

`tools/` 里的东西按用途分三类：

| 用途 | 工具 |
| --- | --- |
| **启停与守护** | `qq-bridge-launcher.ps1`（start/stop/restart/startAll，桥接与 SnowLuma）、`register-watchdog-tasks.mjs`（注册两个看门狗的登录自启） |
| **安装与卸载** | `install-core.mjs`（安装核心）、`uninstall-core.mjs`（卸载核心）、`register-uninstall-entry.mjs`（登记系统卸载项） |
| **配置与分发** | `setup-wizard.mjs`（首次配置向导）、`config-portability.mjs`（导出/导入/脱敏）、`package-dist.mjs`（打包 + 泄漏扫描） |

这几个工具都遵循同一条设计：**默认只出计划，加 `--apply` / `--execute` 才动手**，
且作用对象可注入（`--root` / `--target`），便于在沙箱里验证而不碰真实环境。


## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 4000 字自动分段
- 图片及部分表情可以通过安全下载接入多模态模型（2026-09-26 起 **direct 运行时同样能看图**：图片随 prompt 发 `image_url`，工具返回的图片也会补一条带图消息；可用 `runtime.images=false` 关掉）；语音/视频以及无法取得图片字节的消息仍使用占位文本
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
