const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TITLE_LEN = 200;
const MAX_MODEL_LEN = 200;
const MAX_MESSAGE_LEN = 200_000;
const MAX_HEADER_COUNT = 50;
const PRICING_UNIT = 'per_1m_tokens';
const PRICING_FIELDS = [
  'inputTokenPrice',
  'cacheReadInputTokenPrice',
  'cacheCreationInputTokenPrice',
  'outputTokenPrice',
  'webSearchRequestPrice',
];

export class SchemaValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SchemaValidationError';
    this.status = status;
  }
}

export function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function validationErrorResult(err) {
  if (err instanceof SchemaValidationError) {
    return { error: err.message, status: err.status };
  }
  throw err;
}

function fail(message, status = 400) {
  throw new SchemaValidationError(message, status);
}

function nonEmptyString(value, field, maxLen = 10_000) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${field} must be a non-empty string`);
  }
  if (value.length > maxLen) fail(`${field} is too long`);
  return value.trim();
}

function optionalString(value, field, maxLen = 10_000) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > maxLen) fail(`${field} is too long`);
  return value;
}

export function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function validateSafeId(value, field = 'id') {
  if (!isSafeId(value)) {
    fail(`${field} must be a safe id`);
  }
  return value;
}

export function validateOptionalSafeId(value, field = 'id') {
  if (value === undefined || value === null || value === '') return undefined;
  return validateSafeId(value, field);
}

export function validateConversationTitle(value) {
  if (value === undefined || value === null || value === '') return 'New Chat';
  if (typeof value !== 'string') fail('title must be a string');
  return value.slice(0, MAX_TITLE_LEN);
}

export const normalizeConversationTitle = validateConversationTitle;

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

function validatePrice(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${field} must be a non-negative number`);
  return n;
}

function validatePricingRate(value) {
  if (!isPlainObject(value)) fail('pricing entry must be an object');
  const out = {};
  const currency = optionalString(value.currency, 'currency', 3) || 'USD';
  if (!/^[A-Za-z]{3}$/.test(currency)) fail('currency must be a 3-letter ISO code');
  out.currency = currency.toUpperCase();
  out.unit = optionalString(value.unit, 'unit', 40) || PRICING_UNIT;
  if (out.unit !== PRICING_UNIT) fail(`unit must be ${PRICING_UNIT}`);
  for (const field of PRICING_FIELDS) {
    out[field] = validatePrice(value[field], field);
  }
  out.sourceUrl = optionalString(value.sourceUrl, 'sourceUrl', 2_000) || '';
  out.updatedAt = optionalString(value.updatedAt, 'updatedAt', 100) || new Date().toISOString();
  const validUntil = optionalString(value.validUntil, 'validUntil', 100);
  if (validUntil) out.validUntil = validUntil;
  const notes = optionalString(value.notes, 'notes', 1_000);
  if (notes) out.notes = notes;
  return out;
}

function validateChannelPricing(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return { models: {} };
  if (!isPlainObject(value)) fail('pricing must be an object');
  const rawModels = value.models === undefined ? {} : value.models;
  if (!isPlainObject(rawModels)) fail('pricing.models must be an object');
  const models = {};
  for (const [model, pricing] of Object.entries(rawModels)) {
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (!normalizedModel) continue;
    if (normalizedModel.length > MAX_MODEL_LEN) fail('pricing model is too long');
    models[normalizedModel] = validatePricingRate(pricing);
  }
  return { models };
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

export function validateChatRequest(payload) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  return {
    conversationId: validateOptionalSafeId(payload.conversationId, 'conversationId'),
    message: nonEmptyString(payload.message, 'message', MAX_MESSAGE_LEN),
    channelId: validateOptionalSafeId(payload.channelId, 'channelId'),
    model: optionalString(payload.model, 'model', MAX_MODEL_LEN),
  };
}

export function validateToolConfigPatch(payload) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  const out = {};
  if (payload.enabled !== undefined) out.enabled = Boolean(payload.enabled);
  if (payload.timeoutMs !== undefined) {
    const n = Number(payload.timeoutMs);
    if (!Number.isInteger(n) || n < 1 || n > 300_000) {
      fail('timeoutMs must be an integer between 1 and 300000');
    }
    out.timeoutMs = n;
  }
  if (payload.config !== undefined) {
    if (!isPlainObject(payload.config)) fail('config must be an object');
    out.config = { ...payload.config };
  }
  return out;
}

function normalizeContentPart(part) {
  if (!isPlainObject(part) || typeof part.type !== 'string' || !part.type) return null;
  const out = { ...part, type: part.type };
  if (out.text !== undefined && typeof out.text !== 'string') out.text = String(out.text);
  if (out.content !== undefined && typeof out.content !== 'string' && !Array.isArray(out.content)) {
    out.content = JSON.stringify(out.content);
  }
  return out;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(normalizeContentPart).filter(Boolean);
}

export function normalizeMessage(message) {
  if (!isPlainObject(message)) return null;
  if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return null;
  const out = {
    ...message,
    role: message.role,
    content: normalizeContent(message.content),
  };
  if (typeof out.model !== 'string') delete out.model;
  if (Array.isArray(message.blocks)) {
    out.blocks = message.blocks
      .filter(block => isPlainObject(block) && typeof block.type === 'string' && block.type)
      .map(block => ({ ...block }));
  } else {
    delete out.blocks;
  }
  if (!Array.isArray(out.sources)) delete out.sources;
  if (typeof out.searchCount !== 'number') delete out.searchCount;
  if (!isPlainObject(out.trace)) delete out.trace;
  return out;
}

export function normalizeMessageList(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeMessage).filter(Boolean);
}

export function normalizeConversation(data, fallbackId) {
  if (!isPlainObject(data)) return null;
  const id = isSafeId(data.id) ? data.id : fallbackId;
  if (!isSafeId(id)) return null;
  const now = new Date().toISOString();
  return {
    id,
    title: typeof data.title === 'string' ? data.title.slice(0, MAX_TITLE_LEN) : 'New Chat',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
    messages: normalizeMessageList(data.messages),
  };
}

function normalizeChannel(channel) {
  if (!isPlainObject(channel) || !isSafeId(channel.id)) return null;
  try {
    const normalized = validateChannelPayload(channel, { partial: false });
    const pricing = validateChannelPricing(channel.pricing) ?? { models: {} };
    return { id: channel.id, ...normalized, pricing };
  } catch {
    return null;
  }
}

export function normalizeAppConfig(cfg) {
  const channels = Array.isArray(cfg?.channels)
    ? cfg.channels.map(normalizeChannel).filter(Boolean)
    : [];
  const activeChannelId = isSafeId(cfg?.activeChannelId) ? cfg.activeChannelId : null;
  const activeModel = typeof cfg?.activeModel === 'string' ? cfg.activeModel : null;
  return { channels, activeChannelId, activeModel };
}
