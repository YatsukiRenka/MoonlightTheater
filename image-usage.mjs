const million = 1_000_000;
const currencyCode = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Standard Google image prices are identical for Gemini Developer API and Vertex's global endpoint.
const googleRates = {
  'gemini-nano-banana-2.1': {input: 1.5, output: 7.5, imageOutput: 30},
  'gemini-3.1-flash-image': {input: 0.5, output: 3, imageOutput: 60},
  'gemini-3.1-flash-lite-image': {input: 0.25, output: 1.5, imageOutput: 30},
  'gemini-3-pro-image': {input: 2, output: 12, imageOutput: 120},
};

export function catalogPrice(pricing) {
  const currency = currencyCode(pricing?.currency);
  if (!currency) return null;
  const perImage = number(pricing.per_image ?? (pricing.unit === 'per_image' ? pricing.output : null));
  if (perImage !== null) return {currency, perImage, source: 'catalog'};
  const divisor = pricing.unit === 'per_token' ? million : pricing.unit === 'per_million_tokens' ? 1 : 0;
  const input = number(pricing.input_per_million_tokens ?? (divisor ? number(pricing.input ?? pricing.prompt) : null));
  const output = number(pricing.output_per_million_tokens ?? (divisor ? number(pricing.output ?? pricing.completion) : null));
  if (input === null || output === null) return null;
  const inputRate = pricing.input_per_million_tokens != null ? input : input * divisor;
  const outputRate = pricing.output_per_million_tokens != null ? output : output * divisor;
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  return {currency, input: inputRate, output: outputRate, source: 'catalog'};
}

export function modelPrice(provider, model, prices) {
  if (prices && Object.hasOwn(prices, model)) return prices[model];
  let rates;
  if (provider === 'openai') {
    if (/^gpt-image-2(?:\.[56]-(?:sunburst|flare))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
      rates = {input: 5, imageInput: 8, imageOutput: 30};
    } else if (model === 'gpt-image-1.5') {
      rates = {input: 5, imageInput: 8, imageOutput: 32};
    } else if (model === 'gpt-image-1-mini') {
      rates = {input: 2, imageInput: 2.5, imageOutput: 8};
    }
  } else if (provider === 'gemini' || provider === 'gemini-oauth') {
    const id = model.replace(/-preview$/, '');
    if (Object.hasOwn(googleRates, id)) rates = googleRates[id];
  }
  return rates ? {...rates, currency: 'USD', source: 'official'} : null;
}

function tokenUsage(response, format) {
  if (format === 'openai') {
    const usage = response.usage || {};
    const input = number(usage.input_tokens ?? usage.prompt_tokens);
    const output = number(usage.output_tokens ?? usage.completion_tokens);
    return {
      input, output, thinking: null,
      total: number(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null),
      inputImage: number(usage.input_tokens_details?.image_tokens),
      outputImage: number(usage.output_tokens_details?.image_tokens),
    };
  }
  const usage = response.usageMetadata || response.usage_metadata || {};
  const input = number(usage.promptTokenCount ?? usage.prompt_token_count);
  const output = number(usage.candidatesTokenCount ?? usage.candidates_token_count);
  const thinking = number(usage.thoughtsTokenCount ?? usage.thoughts_token_count);
  const details = usage.candidatesTokensDetails ?? usage.candidates_tokens_details;
  const images = Array.isArray(details) ? details.flatMap(part => {
    const count = number(part?.tokenCount ?? part?.token_count);
    return part?.modality === 'IMAGE' && count !== null ? [count] : [];
  }) : [];
  return {
    input, output, thinking,
    total: number(usage.totalTokenCount ?? usage.total_token_count)
      ?? (input !== null && output !== null ? input + output + (thinking ?? 0) : null),
    outputImage: images.length ? images.reduce((sum, count) => sum + count, 0) : null,
  };
}

function reportedCost(response) {
  const usage = response.usage || response.usageMetadata || response.usage_metadata || {};
  const cost = usage.cost ?? response.cost;
  const usd = number(usage.cost_usd ?? response.cost_usd);
  if (usd !== null) return {value: usd, currency: 'USD', source: 'reported'};
  const value = number(cost?.amount ?? cost);
  const currency = currencyCode(cost?.currency ?? usage.currency ?? response.currency);
  return value !== null && currency ? {value, currency, source: 'reported'} : null;
}

function estimate(usage, rate, format, imageCount) {
  if (!rate) return null;
  const {currency, source} = rate;
  if (rate.perImage !== undefined) return {value: rate.perImage * imageCount, currency, source};
  if (usage.input === null || usage.output === null) return null;
  let value;
  let upperBound = false;
  if (rate.imageOutput === undefined) {
    value = (usage.input * rate.input + (usage.output + (usage.thinking ?? 0)) * rate.output) / million;
  } else if (format === 'openai') {
    const imageInput = Math.min(usage.inputImage ?? 0, usage.input);
    value = ((usage.input - imageInput) * rate.input + imageInput * (rate.imageInput ?? rate.input)
      + (usage.outputImage ?? usage.output) * rate.imageOutput) / million;
  } else {
    const imageOutput = Math.min(usage.outputImage ?? usage.output, usage.output);
    upperBound = usage.outputImage === null && usage.output > 0;
    const textOutput = usage.output - imageOutput + (usage.thinking ?? 0);
    value = (usage.input * rate.input + textOutput * rate.output + imageOutput * rate.imageOutput) / million;
  }
  return Number.isFinite(value) ? {value, currency, source, upperBound} : null;
}

export function summarizeImageUsage(response, format, price, imageCount) {
  const tokens = tokenUsage(response, format);
  return {tokens, cost: reportedCost(response) ?? estimate(tokens, price, format, imageCount)};
}

export function money(value, currency) {
  return new Intl.NumberFormat('zh-HK', {
    style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 6,
  }).format(value);
}

export function priceLabel(rate) {
  if (!rate) return '暂无可用单价';
  const source = rate.source === 'catalog' ? '接口目录' : '官方参考价';
  if (rate.perImage !== undefined) return source + ' · ' + money(rate.perImage, rate.currency) + ' / 张';
  return source + ' · 输入 ' + money(rate.input, rate.currency)
    + ' / 百万 Token · ' + (rate.imageOutput === undefined ? '输出 ' : '图片输出 ')
    + money(rate.imageOutput ?? rate.output, rate.currency) + ' / 百万 Token';
}
