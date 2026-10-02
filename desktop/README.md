# QQ 桥接桌面控制台

独立桌面窗口，两个视图：

- **管理**：一键启停服务、自动检查、自动保存、托盘常驻、操作时间线、DSH 重启记录
- **聊天与出图**：一键打开原有的网页控制台（聊天 / 出图 / 角色 / 黑话 / 记忆等功能都在那里），
  以**独立窗口**打开，可与管理窗口并排

## 为什么是"外壳"而不是重写

桥接已经提供 85 个 HTTP API 和一套完整的网页控制台（`public/console.html`）。
桌面版因此**不自己 spawn node、不复制状态判断逻辑**，而是：

| 能力 | 实现方式 |
| --- | --- |
| 启停服务 | 调用权威启动器 `tools/qq-bridge-launcher.ps1` 的 `startAll` / `stopAll` / `restartAll`，另有只重启桥接的轻量档 |
| 自动检查 | `desktop/lib/health.js`：探测+接口双路校验，每项都带**可操作建议** |
| 自动保存 | `desktop/lib/settings.js`：原子写 + 防抖，存 `state/desktop-settings.json` |
| DSH 重启监测 | `desktop/lib/dsh-watch.js`：对比端点变化，记录中断时长到 `state/dsh-restart.log` |
| 控制台 | 独立窗口加载 `http://127.0.0.1:3100/?embed=1&token=…`（令牌经主进程注入，不落盘） |
| 打开 DSH | 从 launcher 的 status 里取 `dshUrl`（含令牌），交给系统浏览器 |

好处：启动/停止的判定只有一处（launcher），不会出现"桌面版说已启动、桥接其实没起来"这类不一致。

## 安装与启动

```bash
# 1. 装 Electron（约 150MB，只需一次）
cd desktop
npm install
# 国内网络慢的话：
#   npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/

# 2. 启动（任选其一）
双击桌面快捷方式「QQ 桥接控制台」          ← 最省事，无控制台黑框
cd ..        &&  npm run desktop
cd desktop   &&  npm start
双击 desktop\start.bat                      ← 有中文报错指引，排障用
```

`start.mjs` 会在缺 Electron 时给出中文安装指引，而不是抛一段英文堆栈。

### 桌面快捷方式

由 `tools/create-app-shortcut.ps1` 创建，可重复运行（已存在则覆盖）：

```powershell
# 创建 / 重建
powershell -NoProfile -ExecutionPolicy Bypass -File tools\create-app-shortcut.ps1
# 删除
powershell -NoProfile -ExecutionPolicy Bypass -File tools\create-app-shortcut.ps1 -Remove
```

**它指向 `node.exe` + `start.mjs`，窗口样式设为最小化（7）**。这两个选择都是踩坑后的结论：

- ⚠️ **不能指向 `electron.exe`** —— 那会绕过 `start.mjs`，而它负责清理缓存与指定干净
  userData。实测直接跑 electron.exe：退出码 `-2147483645`，且 `state\desktop.log` **零新增行**
  （= Electron 在加载应用代码前就退出，表现为"点了图标打不开"）。
- 也不绕 VBS 隐藏控制台：VBS 需要 UTF-16 LE + BOM，该环境下 `cscript` 报错无输出、难以诊断
  （已放弃并删除相关文件）。用「node + 最小化窗口」既完整又**可被自动化测试验证**。

图标取 `D:\DSH\assets\dsh.ico`。

## 界面分区

窗口分**三个区**（顶部标签切换，标题栏只留「一键启动」与「检查」）：

- **总览** —— 服务体检卡（异常卡自带修复按钮）+ 当前状态胶囊 + 最近事件 + 诊断输出。
  按服务粒度重启/停止在这里（不在标题栏，避免误点）。
- **监测** —— 「实时监测 QQ 对话」（这是本项目的需求原话第一条，此前在应用里完全看不到）：
  · 左：**会话列表**（未读多的排前面；显示模式、上次唤醒、最近 AI 回复、触发条件；点开看最近消息）
  · 右：**活动流**（结构化行 + 按类型着色，报错红 / 发送绿 / 唤醒黄 / 工具蓝；
    可按下拉筛选、可暂停自动刷新；它来自桥接 `/api/status` 的 `activity`）
  · 顶部按钮：打开网页控制台窗口 / 在系统浏览器里打开
- **设置** —— 卡片网格 + **红边独立危险区**（卸载）。含「AI 运行时」（见下）、
  日常偏好（自动检查间隔 / 启动时自动拉起 / 关闭到托盘）、看门狗、配置导出导入。
- **托盘**：显示窗口、打开网页控制台、一键启动/重启/停止、退出

监测页的数据全部复用桥接**已有**的 `/api/*` 端点，由主进程经 IPC 取回 ——
**控制台令牌不进渲染层**。

## AI 运行时（设置页首家：dsh / direct 二选一）

因为「装不装 DSH」是用户自己的选择，运行时要能在界面上直接管：

- **切换运行时**：挂 DSH / 直连 AI API（选 DSH 时直连字段置灰但保留值）
- **连接信息**：接口地址 / 模型（下拉，选项来自接口的 `GET /models`）/ API key
  （**密钥不回填、不回传渲染层** —— 只显示"填过没有"；留空 = 不修改）
- **行为开关**：看图（`runtime.images`）、温度（`runtime.temperature`）
- **↻ 切换模型** —— **热切换，不用重启桥接**。流程是「先探新模型能不能用 →
  探通了才写 config.json → 再通知桥接立即生效」；**探不通什么都不改**
  （避免换成一个不存在的模型名后机器人静默哑掉）
- **模型检测** —— 主动问接口有哪些可用模型，并把结果**显示出来**
  （几个 / 耗时 / 用的哪把 key / 哪个在运行 / 哪个是配置里的）；
  失败时按 401 / 404 / 域名 / 连不上分类给**下一步**；
  接口通了但没返回列表算**警告**而非错误
- **「✅ 已生效」/「⚠️ 需重启才生效：模型」** —— 把**配置里写的**与**桥接正在跑的**
  实时比对。光看配置文件答不出这个问题，因为**桥接只在启动时读一次配置**。

### ⚠️ 为什么检测/探测走**桥接**而不是应用自己发请求

实测（2026-09-26）：Electron 主进程的 `fetch` 在这台机器上**持续**报
`SELF_SIGNED_CERT_IN_CHAIN`（安全软件拦 HTTPS 插的证书不在其根证书集里），
而**桥接那个进程能通** —— 同一个 API、同一把 key、同一个 node。
`--use-system-ca` 又没法通过 `NODE_OPTIONS` 传给 Electron（Node 的白名单不允许）。

所以桥接提供两个端点代劳，应用优先走它们、不可用才退回本地：
```
POST /api/runtime/models  { baseUrl?, apiKey? }         → {ok, models, latencyMs}
POST /api/runtime/probe   { baseUrl?, model?, apiKey? }  → {ok, latencyMs, reply}
```
**这不只是绕开证书** —— 要测的本来就是"机器人这条路通不通"，
用一个**不同的** HTTP 客户端去测，结果本身就是可疑的。

### 配置写入的谨慎要求（`desktop/lib/runtime-config.js`）
`config.json` 含 QQ 号 / DSH 令牌 / key，**不在版本控制里**，所以每次写入都要求：
先备份到 `archive/` → **只替换 `runtime` 那一段文本**（不 parse→reserialize）→
写完校验（JSON 合法 + 其它顶层键一个不少 + 没有意外的新键）→ 任一步不过就放弃或回滚 →
原子写并保留原有 BOM / CRLF / 缩进。
⚠️ **已知字段只用来"排序"，未知字段原样保留** —— 否则用户自己加的配置项会被界面吃掉。

## 检查项的等级

| 等级 | 含义 |
| --- | --- |
| 关键项（配置文件 / 桥接 / DSH / SnowLuma） | 任一失败 → 整体 `error`，聊天不可用 |
| 可选（ComfyUI / 出图底模） | 失败只显示 `未运行`，不影响聊天，只是画不了图 |

## 已知限制

- **ComfyUI 与 SnowLuma 不打进安装包** —— SnowLuma 是第三方 QQ 网关，ComfyUI 光模型就有 16GB，只能检测 + 引导
- **AI 回复依赖 DSH 或一个 AI API** —— 桌面版会检测它、能打开它的界面，但不负责安装它；
  运行时可二选一（见上「AI 运行时」）
- 关闭窗口 = 收进托盘（可在设置里关掉这个行为）
- 服务本身的日志、配置、状态仍在 `state/` 与 `config.json`，桌面版不改它们的格式

## 为什么控制台是「独立窗口」而不是 iframe 内嵌

**这是一次基于实测的返工，改动前请先看完这段**，不要再试图把它嵌进 iframe。

最初的实现是把控制台放进本窗口的 iframe。它在 Electron 里**始终无法渲染**：

- iframe 的 `load` 事件不触发（表现为纯黑 + 我们的状态栏提示「15 秒未加载」）
- 而服务端一切正常：`curl` 返回完整 HTML（118 KB）、`X-Frame-Options` 已按下面方式放行为
  `SAMEORIGIN`、模拟 iframe 请求（带 `Sec-Fetch-Dest: iframe`、`Origin: null`、
  `Referer: file://…`）也都返回 200 + `SAMEORIGIN`

也就是说，**iframe 方案同时受三重限制**：`X-Frame-Options`、CSP `frame-src`、
以及 `file://` 源与 `http://127.0.0.1` 的跨源规则 —— 前两项都已确认放行，问题仍出在跨源这一层。

改为**独立窗口**（`consoleWindow`）后，控制台作为**顶层页面**加载：没有 frame 限制、
没有跨源问题、`prompt()` 之类的 API 也正常工作（iframe 里会被浏览器忽略），
还能与管理窗口并排、自由缩放。`?embed=1` 仍带着（它是无害的显式标记，见下节）。

因此 `renderer` 的 CSP **不再需要 `frame-src`**，只保留 `connect-src` 放行本机控制台：

```
connect-src 'self' http://127.0.0.1:3100
```

放行范围刻意收窄：**只允许 127.0.0.1:3100 这一个源**，不放行 `*` 或任意 http/https
（`scripts/test-desktop-wiring.mjs` 有断言守住，并断言"不再使用 iframe"）。

令牌怎么进去：控制台支持 `?token=`，由主进程 `consoleUrlWithToken()` 拼进 URL
（`console:openWindow` 通道），令牌**只交给那个窗口，不写日志、不落盘**。

## 桥接的嵌入放行头（保留，供将来复用）

桥接对控制台响应默认发：

```
X-Frame-Options: DENY          ← 禁止被任何页面嵌入（防点击劫持）
```

即使现在用独立窗口，这条**也不该整体去掉**。已按用户的决定改成"显式放行"：
只对带 `?embed=1` 的请求放宽为 `SAMEORIGIN`：

| 请求 | 响应头 | 含义 |
| --- | --- | --- |
| `GET /?embed=1&token=…` | `X-Frame-Options: SAMEORIGIN` | 显式请求嵌入时才放行 |
| `GET /?token=…`（无 embed） | `DENY` | 外部网页无法嵌入 |
| 任何 `/api/*` | `DENY` | 没有放开整站 |

**为什么不干脆全站改成 SAMEORIGIN**：Electron 渲染页是 `file://` 源，与
`http://127.0.0.1:3100` **不同源**，SAMEORIGIN 依然嵌不进去；而放宽为"完全允许"
会削弱 CSRF 防护。用显式标记只放宽内嵌请求，影响面最小。

改完桥接代码 **必须管理员重启桥接**才生效。回归测试：

```bash
npm run test:embed-headers      # 5 项：三条边界 + 其它安全头未被削弱
```

## 控制台页面的容错要求（改它之前先看）

`public/console.html` 里的**令牌存储必须容错**，不能用裸 `localStorage`：

```js
// 正确：tokenStore 会探测可用性，不可用时退回内存
tokenStore.set(token);
```

原因：嵌入式场景（父页是 `file://` 源）下 Chromium 的分区存储策略可能让
`localStorage` 抛 `SecurityError`。而原实现把它放在**页面最前面的 IIFE** 里，
一旦抛异常，**本页后续所有脚本都不执行** → 整页空白，和"被安全策略拦掉"表现一模一样
（排查时极易误判）。

回归测试：

```bash
npm run test:console-scripts    # 校验内联脚本语法 + 揪出未被 try 保护的 localStorage 调用
```

## userData 目录：为什么不用默认的 %APPDATA%

这是踩过坑之后的设计，**改动前请先看完**。

曾出现「窗口一闪即退」，日志里是：

```
GPU process launch failed: error_code=18        （反复重试）
Failed to open persistent cache ... (0x20 另一个程序正在使用此文件)
FATAL: GPU process isn't usable. Goodbye.
```

用 `scripts/probe-desktop-launch.mjs` 逐组测试 7 套启动开关后，结果是 **7/7 全部成功，
包括"不加任何开关"的默认组，且 0 次 GPU fatal** —— 说明 **GPU 开关不是关键变量**。
真正的差异是：探针每组都用独立的 `--user-data-dir`，绕开了默认
`%APPDATA%\qq-bridge-desktop` 里那份**损坏且被占用的缓存**。

因此 `start.mjs` 现在固定：

1. 使用项目内的 `state/electron-profile` 作为 userData（`--user-data-dir=`）
2. 每次启动前清掉其中的缓存子目录（`GPUPersistentCache` / `GPUCache` / `DawnGraphiteCache` / `Cache` / `Code Cache` / `ShaderCache`）

`main.mjs` 里另有关闭 GPU 加速的一组开关作为**第二道保险**，但请记住：
**起作用的是干净的 userData，不是那些开关**。

> 后记（2026-09-25）：这组 GPU 开关后来被证明**不是**控制台窗口黑屏的原因（虽然日志里
> 出现过同源的 `launch-failed exitCode=18`）。真正的开关是 **`--no-sandbox`**，见下一节。

## `--no-sandbox`：控制台窗口黑屏的真正原因

症状：控制台窗口打开后 **12 毫秒**就 `渲染进程结束：reason=launch-failed exitCode=18`，界面全黑。

定位过程（可复用）：用外部 Electron 探针加载**同一个页面**，同机同权限下渲染完美 →
把探针与应用的差异**逐项对比**，最后只剩命令行开关：探针带了 `--no-sandbox`，应用没带。
加上后 `launch-failed` 立刻消失。

**判据（很值得记住）**：窗口黑要**先分清是"渲染进程没起来"还是"起来了但没画出来"**。
- 前者看 `render-process-gone` / `did-fail-load`，多为启动期失败（沙箱、开关、权限）；
- 后者才查 DOM 与绘制。
把两类混在一起查会走很多弯路 —— 本项目先后错怪过 `X-Frame-Options`、`localStorage`、
GPU 开关组、`webPreferences.sandbox` 四项。

配套诊断已固化在 `main.mjs` 的 `attachRendererDiagnostics()`：把两个窗口的
`did-finish-load` / `did-fail-load` / `render-process-gone` / 页面告警，以及加载后 2.5 秒的
**渲染指标**（title、readyState、`body.innerText` 长度、`scrollHeight`、`main` 的
display/visibility/opacity/尺寸）写进 `state/desktop.log`。

## 看门狗：服务掉线自动拉起

**为什么需要**：实测到桥接会在 `SnowLuma 连接断开（code=1006）` 之后**自己消失**
（进程退出、`bridge.log` 无崩溃记录），结果是**机器人静默掉线、用户毫不知情**。
这类"没被察觉的失效"最适合自动兜住。

**为什么放在主进程**：界面上的「自动检查」跑在渲染层（`renderer` 的 `setInterval`），
而窗口收进托盘后 Chromium 会**节流/暂停**渲染层定时器 —— 恰恰在"窗口关着、最需要
看门狗"的时候它会睡着。所以看门狗用**主进程**的 30 秒定时器。

**三个安全阀**（判定逻辑在 `lib/watchdog.js`，单独成模块以便单测）：
1. **冷却时间**（默认 180s）内不重复拉起，避免服务起不来时被高频重试打爆；
2. 有其它生命周期动作在执行时不插手（免得两个动作打架）；
3. 可在设置里整体关掉。

设置项：`watchdogEnabled`（默认开）、`watchdogCooldownSeconds`（默认 180）。
触发时会以 `watchdog:startAll` 的名义写入操作时间线，但**不会**接管界面按钮/进度条
（用户没点任何东西，不该看到按钮变灰）。

```bash
npm run test:desktop-watchdog    # 12 项：冷却/忙时不插手/开关关闭/退出中/异常冷却值
```

> ⚠️ 不要给 Electron 加 `--in-process-gpu`。它把 GPU 初始化放进主进程，
> 一旦失败就直接终止整个应用（正是上面那条 `Goodbye` 的表现）；
> 让 GPU 留在独立子进程里，Chromium 才能降级到软件渲染。

## 排障

```bash
npm run desktop              # 正常启动
node start.mjs --probe       # 自检模式（提示看哪个日志）
node scripts/probe-desktop-launch.mjs   # 逐组测试启动开关（约 1.5 分钟）
```

启动日志固定写到 `state/desktop.log`，包含：启动参数、缓存清理结果、窗口创建、
渲染进程/子进程结束原因、未捕获异常、退出码。**GUI 崩溃时先看这个文件** ——
窗口一闪即逝时控制台通常来不及显示任何东西。

## 文件结构

```
desktop/
├── main.mjs            主进程：窗口/托盘/IPC/生命周期
├── preload.cjs         白名单式桥 API（不提供通用 IPC 转发）
├── start.mjs           启动器（环境校验 + 中文报错）
├── start.bat           双击入口（纯 ASCII + CRLF）
├── lib/
│   ├── launcher.js     封装 qq-bridge-launcher.ps1
│   ├── health.js       四项体检 + 建议 + 可选相机
│   └── settings.js     原子写 + 防抖自动保存
└── renderer/
    ├── index.html      分区布局
    ├── style.css       深色主题
    └── app.js          渲染逻辑（只调 preload 暴露的方法）
```

## 自检

```bash
npm run test:desktop    # launcher 封装 / 端口探测 / 体检 / 建议字段
```
