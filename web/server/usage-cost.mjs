// OpenAI public Standard prices on 2026-11-19 (USD per million tokens).
// https://developers.openai.com/api/docs/pricing
// Entries are [input, cached input, output, long-context pricing].
const standardRates = new Map(Object.entries({
  'gpt-6.2-astra': [8, 0.40, 40, true],
  'gpt-6.2-sol': [2, 0.10, 10, true],
  'gpt-6-astra': [10, 1, 50, true],
  'gpt-6.1-sol': [2, 0.10, 10, true],
  'gpt-6.1-terra': [1, 0.05, 5, true],
  'gpt-6-luna': [0.10, 0.01, 0.50, true],
  'gpt-6-sol': [2, 0.20, 10, true],
  'gpt-5.6-sol': [4, 0.40, 20, true],
  'gpt-5.6-terra': [2, 0.20, 12, true],
  'gpt-5.6-luna': [0.20, 0.02, 1.20, true],
  'gpt-5.5': [5, 0.50, 30, true],
  'gpt-5.5-pro': [30, null, 180, true],
  'gpt-5.4': [2.50, 0.25, 15, true],
  'gpt-5.4-pro': [30, null, 180, true],
  'gpt-5.4-mini': [0.75, 0.075, 4.50],
  'gpt-5.4-nano': [0.20, 0.02, 1.25],
  'gpt-5.2': [1.75, 0.175, 14],
  'gpt-5.2-pro': [21, null, 168],
  'gpt-5.1': [1.25, 0.125, 10],
  'gpt-5': [1.25, 0.125, 10],
  'gpt-5-mini': [0.25, 0.025, 2],
  'gpt-5-nano': [0.05, 0.005, 0.40],
  'gpt-5-pro': [15, null, 120],
  'gpt-4.1': [2, 0.50, 8],
  'gpt-4.1-mini': [0.40, 0.10, 1.60],
  'gpt-4.1-nano': [0.10, 0.025, 0.40],
  'gpt-4o': [2.50, 1.25, 10],
  'gpt-4o-mini': [0.15, 0.075, 0.60],
  'o3-pro': [20, null, 80],
  'o3': [2, 0.50, 8],
}));

const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

export function estimateTokenCostNanos(model, { inputTokens, outputTokens }, details, serviceTier) {
  const rates = standardRates.get(model);
  if (!rates || (serviceTier != null && serviceTier !== 'default')) return null;

  const [inputRate, cacheRate, outputRate, longContext] = rates;
  const cached = details?.cached_tokens ?? 0;
  const written = details?.cache_write_tokens ?? 0;
  const writesByLifetime = details?.cache_write_tokens_details;
  // kivo does not request an extended cache lifetime. Older responses can give
  // the write total alone, which uses the default 30-minute rate.
  const written30m = writesByLifetime?.ttl_30m_tokens ?? written;
  const written12h = writesByLifetime?.ttl_12h_tokens ?? 0;
  if (![inputTokens, outputTokens, cached, written, written30m, written12h].every(tokenCount)
    || cached + written > inputTokens || written30m + written12h !== written
    || (cached > 0 && cacheRate === null)
    || (written > 0 && !/^gpt-(?:6[.-]|5\.6-)/.test(model))) return null;

  // Above 272K input tokens, the extended rates apply to the whole request.
  const extended = longContext && inputTokens > 272_000;
  const inputMultiplier = extended ? 2 : 1;
  const ordinary = inputTokens - cached - written;
  const input = ordinary * inputRate + cached * (cacheRate ?? 0)
    + (written30m * 1.25 + written12h * 2.5) * inputRate;
  const output = outputTokens * outputRate * (extended ? 1.5 : 1);
  const nanos = Math.round((input * inputMultiplier + output) * 1000);
  return Number.isSafeInteger(nanos) ? nanos : null;
}
