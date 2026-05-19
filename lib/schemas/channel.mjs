import {
  MAX_HEADER_COUNT,
  fail,
  isPlainObject,
  nonEmptyString,
  optionalString,
} from './common.mjs';
import { validateChannelPricing } from './pricing.mjs';

function validateUrl(value, field) {
  const text = nonEmptyString(value, field, 2_000);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${field} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail(`${field} must use http or https`);
  }
  return text.replace(/\/+$/, '');
}

function validateModelList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('models must be an array');
  return value
    .map(item => {
      if (typeof item !== 'string') fail('models must contain strings');
      return item.trim();
    })
    .filter(Boolean)
    .slice(0, 100);
}

function validateMaxTokens(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
    fail('maxTokens must be an integer between 1 and 1000000');
  }
  return n;
}

function validateExtraHeaders(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('extraHeaders must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADER_COUNT) fail('extraHeaders has too many entries');
  const out = {};
  for (const [key, raw] of entries) {
    if (typeof key !== 'string' || !key.trim()) fail('extraHeaders keys must be strings');
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) fail(`invalid header name: ${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof raw)) {
      fail(`invalid header value for ${key}`);
    }
    out[key] = String(raw);
  }
  return out;
}

export function validateChannelPayload(payload, { partial = false } = {}) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  const out = {};

  if (!partial || payload.name !== undefined) {
    out.name = nonEmptyString(payload.name, 'name', 120);
  }
  if (!partial || payload.baseUrl !== undefined) {
    out.baseUrl = validateUrl(payload.baseUrl, 'baseUrl');
  }
  if (payload.apiKey !== undefined) {
    out.apiKey = optionalString(payload.apiKey, 'apiKey', 10_000) ?? '';
  }
  if (!partial || payload.models !== undefined) {
    out.models = validateModelList(payload.models) ?? [];
  }
  if (!partial || payload.maxTokens !== undefined) {
    out.maxTokens = validateMaxTokens(payload.maxTokens) ?? 8192;
  }
  if (!partial || payload.extraHeaders !== undefined) {
    out.extraHeaders = validateExtraHeaders(payload.extraHeaders) ?? {};
  }
  if (!partial || payload.pricing !== undefined) {
    out.pricing = validateChannelPricing(payload.pricing) ?? { models: {} };
  }

  return out;
}
