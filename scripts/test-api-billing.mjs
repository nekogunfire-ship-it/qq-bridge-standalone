import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeApiUsage, readApiBilling, recordApiUsage } from '../src/api-billing.js';

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
  console.log('=== API 计费用量自检通过 ===');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
