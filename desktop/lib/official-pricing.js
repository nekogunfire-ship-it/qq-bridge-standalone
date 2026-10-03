import fs from 'node:fs';
import path from 'node:path';

const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FX_URL = 'https://api.frankfurter.app/latest?from=USD&to=CNY,EUR,JPY,GBP';

function cacheFile(root) { return path.join(root, 'state', 'official-pricing-cache.json'); }
function fxCacheFile(root) { return path.join(root, 'state', 'exchange-rate-cache.json'); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function plainText(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#36;/g, '$').replace(/\s+/g, ' ');
}

export function parseDeepSeekPricing(html, model, now = new Date()) {
  const text = plainText(html);
  const pattern = /CACHE HIT\).*?OFF-PEAK \$([\d.]+) \$([\d.]+).*?PEAK \$([\d.]+) \$([\d.]+).*?CACHE MISS\).*?OFF-PEAK \$([\d.]+) \$([\d.]+).*?PEAK \$([\d.]+) \$([\d.]+).*?OUTPUT TOKENS.*?OFF-PEAK \$([\d.]+) \$([\d.]+).*?PEAK \$([\d.]+) \$([\d.]+)/i;
  const match = text.match(pattern);
  if (!match) throw new Error('官方定价页格式已变化，暂时无法自动解析');
  const pro = /(?:^|[-_])(?:v4-)?pro(?:$|[-_])/i.test(model);
  const column = pro ? 1 : 0;
  const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  const hour = now.getUTCHours();
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const pair = (offFlash, offPro, peakFlash, peakPro) => Number(match[peak ? peakFlash + column : offFlash + column]);
  return {
    provider: 'DeepSeek', model, currency: 'USD', tier: peak ? '工作日峰值' : '非峰值',
    cachedInputPerMillion: pair(1, 2, 3, 4),
    inputPerMillion: pair(5, 6, 7, 8),
    outputPerMillion: pair(9, 10, 11, 12),
    sourceUrl: DEEPSEEK_PRICING_URL,
    fetchedAt: now.toISOString()
  };
}

export async function getOfficialPricing(root, { baseUrl = '', model = '', force = false } = {}) {
  const host = (() => { try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; } })();
  if (host !== 'api.deepseek.com') {
    return { ok: false, error: '当前接口不是 DeepSeek 官方地址，无法确认模型官网定价', model };
  }
  const cached = readJson(cacheFile(root));
  if (!force && cached?.model === model && Date.now() - Date.parse(cached.fetchedAt || 0) < CACHE_MAX_AGE_MS) {
    return { ok: true, pricing: cached, cached: true };
  }
  try {
    const response = await fetch(DEEPSEEK_PRICING_URL, { headers: { 'user-agent': 'qq-bridge-pricing/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`官方定价页 HTTP ${response.status}`);
    const pricing = parseDeepSeekPricing(await response.text(), model);
    writeJson(cacheFile(root), pricing);
    return { ok: true, pricing, cached: false };
  } catch (error) {
    if (cached?.model === model) return { ok: true, pricing: cached, cached: true, warning: `官网更新失败，使用缓存：${error.message}` };
    return { ok: false, error: error?.message ?? String(error), model };
  }
}

export async function getExchangeRates(root, { force = false } = {}) {
  const cached = readJson(fxCacheFile(root));
  if (!force && cached?.rates && Date.now() - Date.parse(cached.fetchedAt || 0) < CACHE_MAX_AGE_MS) {
    return { ok: true, ...cached, cached: true };
  }
  try {
    const response = await fetch(FX_URL, { headers: { 'user-agent': 'qq-bridge-pricing/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`汇率接口 HTTP ${response.status}`);
    const body = await response.json();
    const rates = { USD: 1 };
    for (const code of ['CNY', 'EUR', 'JPY', 'GBP']) {
      const value = Number(body?.rates?.[code]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`汇率接口缺少 ${code}`);
      rates[code] = value;
    }
    const data = { base: 'USD', rates, rateDate: body.date, fetchedAt: new Date().toISOString(), source: 'Frankfurter / ECB reference rates' };
    writeJson(fxCacheFile(root), data);
    return { ok: true, ...data, cached: false };
  } catch (error) {
    if (cached?.rates) return { ok: true, ...cached, cached: true, warning: `汇率更新失败，使用缓存：${error.message}` };
    return { ok: false, rates: { USD: 1 }, error: error?.message ?? String(error) };
  }
}
