# 群聊黑话学习与「黑话命中唤醒」

这套机制让桥接在群里**边聊边学**：把群友的黑话/网络用语/群内梗提取出来、联网查证、写进黑话库；
之后群里再出现这些词，桥接能认出来，并**大幅提高唤醒概率**（必要时直接叫醒 AI 来接话）。

- 词库文件：`state/slang.json`（JSON 数组，一条一个词）
- 实现：`src/slang-learner.js`（纯函数：匹配 / 加成 / prompt 构造）+ `src/bridge.js`（调度、落盘、唤醒）
- 控制台：`http://127.0.0.1:3100` → 「08 群聊黑话 / 网络用语库」
- 自测：`node state/agents/verify-slang-wake.mjs`（离线、只读，不发 QQ 消息）

---

## 1. 两条流水线

### 学习流水线

```
群消息 ──► 滚动窗口(每会话) ──► 提取(DSH learner 会话，JSON 候选)
                              └─► 入库(candidate) ──► 联网考究(web_search/web_fetch)
                                                       ├─ 够确定 → 自动转正 confirmed
                                                       └─ 不确定 → 留候选，回填重试
confirmed ──► ① 注入聊天上下文（黑话表）  ② 成为实时识别信号
```

| 环节 | 触发条件 | 关键配置 |
| --- | --- | --- |
| 提取 | 窗口内消息数 ≥ `extractMinMessages`，且距上次提取 ≥ `extractCooldownMs` | `extractMinMessages` / `extractCooldownMs` / `extractMaxItems` |
| 研究 | 词条出现次数命中 `inferenceThresholds`，或 AI 主动提交，或后台回填 | `inferenceThresholds` / `researchMaxBatch` |
| 自动转正 | 研究结果 `confirmed=true` + 有含义 + 置信度 ≥ `autoPromoteConfidence` +（可选）有来源 | `autoPromote` / `autoPromoteConfidence` / `autoPromoteRequireSource` |
| 回填重试 | 候选研究过但没转正；每个词最多研究 `researchRetryMax+1` 次 | `researchRetryMax` / `researchBacklogMax` |

**回填研究**是历史遗留候选的兜底：桥接启动 / DSH 恢复后会自动跑一轮，控制台也可以手动点
「回填研究（自动转正）」（`POST /api/slang/backlog`）。它优先处理「已经抓到含义和来源」的词——
这类词研究一次就能转正，收益最大。

AI 自己也能加速学习：唤醒提示里会附一份「待学习黑话」清单，AI 看懂后用
`qq_slang_submit(content=词, context=原句, meaning=含义, confidence=0.8, sources=[...])` 提交，
满足转正条件就直接入库，不用等人工点确认。

### 识别与唤醒流水线

```
群消息 ──► detectSlangHits(文本, 词库)
            ├─ confirmed 命中：已确认词条精确命中（中文包含 / 短英文按词边界）
            └─ pattern  命中：形态像黑话但库里没有（拼音缩写、圈子缩写、整条就是短词）
          ──► ① 能直接唤醒 → scheduleWakeV2(key, "slang:词1、词2")
              ② 不能直接唤醒 → 抬高「普通消息概率」后再掷骰子
              ③ 无论是否唤醒，命中词都会写进唤醒 prompt（【本次消息里的黑话】）
```

判定顺序上，**黑话命中排在随机概率之前**：黑话是这套桥接最想抓的信号，不该被随机数筛掉。
但它排在 `@ / 私聊 / 提问 / 关键词 / 指定成员` 之后——有人直接找你时，理由仍显示为更"硬"的那个。

---

## 2. 什么算「命中」

**已确认命中**（`hits.confirmed`）：词库里 `status=confirmed` 且有含义的词条。
- 纯中文词条：按包含匹配（`绝绝子` 命中「这波操作绝绝子」）
- 纯 ASCII 词条：按词边界匹配（`cy` 不会命中 `fancy`，`DS` 不会命中 `ADS`）

**疑似命中**（`hits.pattern`）：库里没有、但形状像黑话的词。
- 字母缩写：`xswl`、`tql`、`kale`（2~8 位，排除常见英文词）
- 字母+数字：`b50`、`pc50`
- 汉字短词：2~6 字，**且**是整条消息 / 被标点隔开的独立片段，**且**不含 `的了吗呢吧啊` 这类虚词，
  **且**不在停用词表里（笑声、日常搭配、 高频功能词都在表里）

刻意不命中的：`@机器人 /命令`、链接、代码片段、`哈哈哈哈`（单发）、`今天天气不错，我们一起去吃饭吧`。
这些判定都有自测用例覆盖，见第 4 节。

---

## 3. 唤醒概率怎么算

```
基础概率 p0            = 会话 WakeConfig 的 triggers.probability
加成倍率 M             = clamp(1 + Σ命中强度 × wakeProbabilityMultiplier, 1, wakeMaxMultiplier)
加成后概率 p1          = min(wakeMaxProbability, 1 - (1 - p0) / M)
```

命中强度：已确认命中 `2 + 词长/6 + 出现次数/10`（下限约 2，上限 3）；疑似命中里字母缩写 1.5、
编号缩写 1.3、单个汉字短词 0.35（弱信号，且必须≥2 个才计入）。

实例（`p0 = 0.4`，默认参数）：

| 消息 | 命中 | 结果 |
| --- | --- | --- |
| 「这波操作绝绝子」（库里有该词） | confirmed ×1 | 直接唤醒（`slang:绝绝子`） |
| 「xswl tql」 | pattern ×2（强信号） | 直接唤醒 |
| 「kale 是什么意思」 | pattern ×1（字母缩写） | 直接唤醒 |
| 「@Bot /schedule.rank 1」 | 无 | 不唤醒，概率不变 |
| 「哈哈哈哈」 | 弱信号 ×1 | 不唤醒，概率不变 |
| 有弱信号但没直接唤醒时 | — | p 从 0.4 抬到 0.65~0.9 |

直接唤醒还有每会话冷却 `wakeCooldownMs`（默认 60s），避免连珠炮；全局仍受
`socialV2.wake.maxWakePerMinute` / `maxWakePerHour` 硬限制约束。

---

## 4. 配置项（`config.json` → `slang`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 黑话系统总开关（关掉后不学习也不识别） |
| `extractMinMessages` | `8` | 窗口内多少条消息触发一次提取 |
| `extractCooldownMs` | `180000` | 同一会话提取冷却 |
| `extractMaxItems` | `20` | 单轮提取最多几个候选 |
| `inferenceThresholds` | `[1,2,4,8]` | 出现次数达到这些值时送研究 |
| `injectMax` | `16` | 黑话表最多注入几条 |
| `learningBlockMax` | `12` | 唤醒提示里「待学习黑话」最多几条 |
| `autoResearch` | `true` | 自动联网研究（关掉则只入库不查证） |
| `detectEnabled` | `true` | 实时识别总开关 |
| `detectPattern` | `true` | 是否识别「库里没有的疑似黑话」 |
| `detectMaxHits` | `8` | 单条消息最多记几个疑似词 |
| `wakeEnabled` | `true` | 命中黑话是否**直接唤醒**（关掉就只抬概率） |
| `wakeOnPattern` | `true` | 疑似黑话（库里没有）是否也能直接唤醒 |
| `wakeMinPatternHits` | `2` | 只有弱信号时，需要凑够几个才算 |
| `wakeProbabilityMultiplier` | `2` | 加成系数 |
| `wakeMaxMultiplier` | `12` | 加成倍率上限 |
| `wakeMaxProbability` | `0.98` | 加成后概率上限 |
| `wakeCooldownMs` | `60000` | 同一会话黑话直接唤醒的最小间隔 |
| `autoPromote` | `true` | 研究够确定时自动转正 |
| `autoPromoteConfidence` | `0.6` | 自动转正需要的置信度下限 |
| `autoPromoteRequireSource` | `true` | 自动转正是否必须带来源 URL |
| `researchRetryMax` | `2` | 单个候选最多被研究几次 |
| `researchMaxBatch` | `8` | 单轮研究最多带几个候选 |
| `researchBacklogMax` | `40` | 后台回填一次最多处理几个 |
| `learnerPreset` / `workspaceTitle` | `qq-chat` / `QQ 黑话学习` | 学习会话用的 preset 与工作区名 |

**嫌吵就调这几个**：`wakeEnabled=false`（只抬概率不直接叫醒）、`wakeProbabilityMultiplier=1`、
`wakeMinPatternHits=3`、`wakeCooldownMs=300000`、`detectPattern=false`（只认已确认词条）。

**想学得更狠**：`extractCooldownMs` 调到 `60000`、`inferenceThresholds` 用 `[1,2]`、
`autoPromoteConfidence` 调到 `0.5`、`researchBacklogMax` 调到 `100`。

---

## 5. 词条状态机

```
candidate ──研究够确定/人工确认──► confirmed ──► 注入黑话表 + 参与实时识别
    │                                   ▲
    │──AI 带含义提交(confidence 达标)────┘
    └──人工拒绝 / 自动判定非黑话形态──► rejected（不再学习、不再参与识别）
```

- 只有 `confirmed` 且有 `meaning` 的词会进黑话表和实时识别。
- 编辑词条内容会重置 `status` 为 `candidate`（防止"改了词条但没重新确认"）。
- 桥接会自动把明显不是黑话的历史垃圾（`/schedule.rank`、超长短语等）从候选转成 `rejected`。

---

## 6. HTTP 接口（控制台 / 排障用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/slang` | 词条列表 + `slang` 配置 |
| POST | `/api/slang/config` | 保存 `slang` 配置（含识别/加成/转正参数） |
| POST | `/api/slang/extract` | 立即提取一次 |
| POST | `/api/slang/research` | 研究指定候选或全部候选 |
| POST | `/api/slang/backlog` | **回填研究**：把历史遗留候选分批补研究 |
| GET | `/api/slang/detect-stats` | 识别开关、词库计数、待回填数、加成参数 |
| POST | `/api/slang/:id/confirm` | 人工确认转正 |
| GET | `/api/socialV2/slang/query` | AI 侧查询（含黑话表 + 待学习清单） |
| POST | `/api/socialV2/slang/submit` | AI 侧提交（可带 meaning/confidence/sources 直接转正） |

---

## 7. 排障

| 现象 | 先看什么 |
| --- | --- |
| 黑话表是空的 | `/api/slang/detect-stats` 的 `confirmed` 是不是 0；是就点「回填研究」 |
| 命中了但没唤醒 | 日志里找 `黑话加成生效`；检查 `wakeEnabled`、`wakeCooldownMs`、会话 `probability` 是否为 0 |
| 唤醒太频繁 | 调高 `wakeCooldownMs` / `wakeMinPatternHits`，或把 `wakeEnabled` 关掉只留概率加成 |
| 候选一直不转正 | 研究日志里 `未确认（confidence=…）`；模型搜不到就永远转不了，需要人工在控制台补含义后确认 |
| 学不到新词 | `bridge.log` 搜 `黑话提取`；若长期「新增 0 条」，检查 learner 会话是否还活着（`state/slang-session.json`） |

自测（离线，不发消息、不改状态）：

```powershell
D:\DSH\node\node.exe state\agents\verify-slang-wake.mjs
```

覆盖：确认词命中 / 短英文词边界不误伤 / 疑似黑话识别 / 笑声与日常句不误报 / 机器人指令不误报 /
加成数学与上限 / 真实词库可识别性。
