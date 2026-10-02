import fs from 'node:fs';
import path from 'node:path';

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeApiUsage(usage = {}) {
  const inputTokens = number(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = number(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = number(usage.total_tokens) || inputTokens + outputTokens;
  const cachedTokens = number(usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens);
  return { inputTokens, outputTokens, totalTokens, cachedTokens };
}

function emptyStats() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 };
}

function add(target, usage) {
  target.requests += 1;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens']) target[key] += usage[key];
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

export function recordApiUsage(root, usageRaw, model = 'unknown', at = new Date()) {
  const usage = normalizeApiUsage(usageRaw);
  if (!usage.totalTokens) return null;
  const file = path.join(root, 'state', 'api-billing.json');
  const data = read(file);
  data.version = 1;
  data.total ??= emptyStats();
  data.daily ??= {};
  data.models ??= {};
  const day = at.toISOString().slice(0, 10);
  const modelKey = String(model || 'unknown').trim().slice(0, 120) || 'unknown';
  data.daily[day] ??= emptyStats();
  data.models[modelKey] ??= emptyStats();
  add(data.total, usage);
  add(data.daily[day], usage);
  add(data.models[modelKey], usage);
  data.updatedAt = at.toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return data;
}

export function readApiBilling(root, now = new Date()) {
  const data = read(path.join(root, 'state', 'api-billing.json'));
  return {
    updatedAt: data.updatedAt ?? '',
    total: { ...emptyStats(), ...(data.total ?? {}) },
    today: { ...emptyStats(), ...(data.daily?.[now.toISOString().slice(0, 10)] ?? {}) },
    daily: data.daily ?? {},
    models: data.models ?? {}
  };
}
