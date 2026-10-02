// 生成 archive/one-off/README.md：说明每个归档脚本当时在查什么、对应哪个已解决的问题。
//
// 描述取自各脚本自身的头部注释（"用途" 行），避免手写产生偏差；
// 每个条目的"服务于"字段来自本仓库的开发历史（本次整理时的实际背景）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/ExampleUser/Documents/deepseek-harness/\u9ed8\u8ba4\u5de5\u4f5c\u533a/qq-bridge';
const ARCHIVE = path.join(ROOT, 'archive', 'one-off');

// 每个脚本：服务于哪个已完成的任务 + 结论（写清"为什么不再需要它"）
const CONTEXT = {
  'diag-send-image': {
    topic: 'QQ 发图渲染成 [object Object]',
    outcome: '定位到桥接调用 onebotSend 时把 segments 数组当字符串传参。已修复为 sendSegments()。'
  },
  'diag-ab-image': {
    topic: '同上：确认是桥接路径的问题而非 SnowLuma',
    outcome: 'A/B 对照证明 OneBot 直连能发、桥接路径发不出，锁定问题在桥接侧。'
  },
  'diag-onebot-image': {
    topic: '同上：确认 SnowLuma 接受哪种 file 来源',
    outcome: '证明 base64:// 可行，本地路径不可行。'
  },
  'diag-onebot-format': {
    topic: '同上：确认 SnowLuma 接受哪种 message 形式',
    outcome: '证明必须用结构化数组，纯字符串与 message_format 参数都不行。'
  },
  'diag-onebot-proxy': {
    topic: '同上：抓桥接实际发出的 body',
    outcome: '本地代理记录到桥接发出的原始请求，直接看到错误构造。'
  },
  'diag-empty-text': {
    topic: '同上：验证"图片 + 空文本段"是否整条渲染坏',
    outcome: '确认空 text 段是元凶之一，修复时加了空文本守卫。'
  },
  'diag-image-multiseg': {
    topic: '同上：多段数组是否就是失败原因',
    outcome: '确认单段图片可行、图片+文字也可行，问题不在多段本身而在构造方式。'
  },
  'diag-image-source-field': {
    topic: '同上：image 段该用 file 还是 url',
    outcome: '确定用 file 传 base64:// 是正解。'
  },
  'diag-image-size-sweep': {
    topic: '同上：图片体积是否有上限',
    outcome: '排除了"图片过大导致失败"这一假设。'
  },
  'diag-verify-base64': {
    topic: '同上：base64 字符串拼接是否被截断',
    outcome: '逐字节比对确认 base64 与源文件一致，排除编码损坏。'
  },
  'diag-verify-fix': {
    topic: '同上：验证修复后的段构造真的能送达',
    outcome: '复刻修复后的逻辑实发成功，作为修复生效的证据。'
  },
  'probe-015': {
    topic: 'DSH 0.1.5-rc.1 升级适配',
    outcome: '探明新版 Web API 协议表面后，适配已完成；后续版本变更可临时重跑参考。'
  },
  'probe-events': {
    topic: 'remote.mux 事件流协议',
    outcome: '事件形状已确认并落到 dsh-client.js；此探针用于将来协议变更时复核。'
  },
  'probe-mcp-tools': {
    topic: '验证 MCP 工具注册面（失败方案）',
    outcome: '用 StdioClientTransport spawn 子进程在文件沙箱里必然 EPERM，脚本永远跑不通。'
      + '文件头已写明「留着只会误导」；注册面验证改由 scripts/test-comfy-tools.mjs 承担。'
  },
  'probe-rpc-compat': {
    topic: 'DSH 0.1.5：逐条验证桥接使用的 RPC 参数形状仍被接受',
    outcome: '全部参数形状通过，适配完成。'
  },
  'probe-workspace': {
    topic: 'DSH 0.1.5：workspace/session RPC 参数形状与返回结构',
    outcome: '形状确认并对照 bridge.js 实际用法验证通过。'
  },
  'verify-dsh-015-adaptation': {
    topic: 'DSH 0.1.5 适配总验证（一次跑完所有关键断言）',
    outcome: 'PASS，升级适配收官；曾作为 npm run verify:adaptation 使用，'
      + '该 npm 脚本已随归档一并移除。'
  }
};

function describe(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').slice(0, 18);
  const comments = lines
    .filter((l) => l.trim().startsWith('//'))
    .map((l) => l.replace(/^\s*\/\/\s?/, '').trim())
    .filter((l) => l && !l.startsWith('用法') && !l.startsWith('node '));
  // 首行通常是标题，取前两行拼成一句话
  return comments.slice(0, 2).join(' ').slice(0, 200);
}

const files = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith('.mjs')).sort();
const rows = [];
for (const f of files) {
  const key = f.replace(/\.mjs$/, '');
  const ctx = CONTEXT[key] ?? { topic: '（未记录）', outcome: '（未记录）' };
  rows.push({ file: f, desc: describe(path.join(ARCHIVE, f)), topic: ctx.topic, outcome: ctx.outcome, size: fs.statSync(path.join(ARCHIVE, f)).size });
}

const md = `# 归档：一次性排查脚本

这里存放**已完成任务的排查/验证脚本**。它们不是工具，不要在正常使用或发布版里运行 ——
多数要求桥接正在运行、且会**真的往 QQ 发消息**。

保留原因：这些脚本记录了问题是怎么被定位的（每一步对照、每一次假设的验证），
将来遇到同类问题（图片渲染、OneBot 协议形状、DSH 协议变更）可以直接翻出来改改再用。

排序按文件名。每个脚本的"服务于"是它当年要解决的问题，"结论"是那次排查得到的答案。

${rows.map((r, i) => `## ${i + 1}. \`${r.file}\`

- **用途**：${r.desc || '（见文件头部注释）'}
- **服务于**：${r.topic}
- **结论**：${r.outcome}
- **体积**：${r.size} 字节
`).join('\n')}
## 注意

- 这些脚本可能引用**当时的**文件结构或已移除的功能，不保证现在还能直接跑通。
- 其中直接调 OneBot / 桥接发送接口的脚本（\`diag-onebot-*\`、\`diag-send-image\`、
  \`diag-ab-image\`、\`diag-verify-fix\`）**会真的发出 QQ 消息**，重跑前请先确认目标会话。
- 想复查 safetensors 架构（模型/LoRA 兼容性判断）请用仍在维护的
  \`scripts/inspect-safetensors.mjs\`，不要翻这里的旧脚本。
`;

fs.writeFileSync(path.join(ARCHIVE, 'README.md'), md, 'utf8');
console.log(`已生成 archive/one-off/README.md（${rows.length} 个脚本）`);
console.log('');
for (const r of rows) {
  console.log(`  ${r.file.padEnd(30)} 服务于: ${r.topic}`);
}
