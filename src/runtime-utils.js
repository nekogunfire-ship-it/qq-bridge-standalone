// 桥接进程与 MCP 服务共用的无状态运行时工具。

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析。
export function escapeCqText(value) {
  return String(value ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

// 工具调用偶尔会把消息数组再次 JSON 序列化；统一在边界处还原。
export function normalizeMessageInput(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
