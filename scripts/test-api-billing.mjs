import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeApiUsage, readApiBilling, recordApiUsage } from '../src/api-billing.js';
import { parseDeepSeekPricing } from '../desktop/lib/official-pricing.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-billing-'));
try {
  assert.deepEqual(normalizeApiUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }), {
    inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedTokens: 0
  });
  assert.deepEqual(normalizeApiUsage({ input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 50 }), {
    inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedTokens: 50
  });
  const now = new Date('2026-10-03T08:00:00.000Z');
  recordApiUsage(root, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }, 'model-a', now);
  recordApiUsage(root, { input_tokens: 80, output_tokens: 20 }, 'model-b', now);
  const data = readApiBilling(root, now);
  assert.equal(data.total.requests, 2);
  assert.equal(data.total.inputTokens, 200);
  assert.equal(data.total.outputTokens, 50);
  assert.equal(data.total.totalTokens, 250);
  assert.equal(data.today.totalTokens, 250);
  assert.equal(data.models['model-a'].requests, 1);
  const text = fs.readFileSync(path.join(root, 'state', 'api-billing.json'), 'utf8');
  assert.ok(!/api[_-]?key|password|token\s*:/i.test(text), '计费文件不得包含凭据字段');
  const officialHtml = `PRICING 1M INPUT TOKENS (CACHE HIT) OFF-PEAK $0.003 $0.022 PEAK $0.006 $0.044
    1M INPUT TOKENS (CACHE MISS) OFF-PEAK $0.15 $0.66 PEAK $0.3 $1.32
    1M OUTPUT TOKENS OFF-PEAK $0.6 $1.98 PEAK $1.2 $3.96`;
  const offPeak = parseDeepSeekPricing(officialHtml, 'deepseek-v4-pro', new Date('2026-10-03T12:00:00Z'));
  assert.equal(offPeak.inputPerMillion, 0.66);
  assert.equal(offPeak.cachedInputPerMillion, 0.022);
  assert.equal(offPeak.outputPerMillion, 1.98);
  assert.equal(offPeak.tier, '非峰值');
  const peak = parseDeepSeekPricing(officialHtml, 'deepseek-flash', new Date('2026-10-02T07:00:00Z'));
  assert.equal(peak.inputPerMillion, 0.3);
  assert.equal(peak.cachedInputPerMillion, 0.006);
  assert.equal(peak.outputPerMillion, 1.2);
  assert.equal(peak.tier, '工作日峰值');
  console.log('=== API 计费用量自检通过 ===');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
