import {
  MAX_HEADER_COUNT,
  MAX_MODEL_LEN,
  fail,
  isPlainObject,
  isSafeId,
  nonEmptyString,
  optionalString,
} from './common.mjs';
import { validateChannelPricing } from './pricing.mjs';
import { validateVisionFailureAction } from './vision-provider.mjs';

export const UNSUPPORTED_IMAGE_ACTIONS = Object.freeze([
  'vision_to_text',
  'ask_user',
  'reject',
]);

const UNSUPPORTED_IMAGE_ACTION_SET = new Set(UNSUPPORTED_IMAGE_ACTIONS);

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
      if (!isPlainObject(item)) fail('models must contain model objects');
      return validateModelConfig(item);
    })
    .slice(0, 100);
}

function validateCapabilities(value) {
  if (value === undefined || value === null) return { imageInput: false };
  if (!isPlainObject(value)) fail('capabilities must be an object');
  return {
    imageInput: value.imageInput === true,
  };
}

function validateVisionModelRef(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isPlainObject(value)) fail('visionModel must be an object');
  const channelId = optionalString(value.channelId, 'visionModel.channelId', 128) || '';
  const modelId = optionalString(value.modelId, 'visionModel.modelId', MAX_MODEL_LEN) || '';
  if (!channelId && !modelId) return undefined;
  if (!channelId || !modelId) fail('visionModel must include channelId and modelId');
  return { channelId, modelId };
}

function validateProviderId(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (!isSafeId(text)) fail(`${field} must be a safe id`);
  return text;
}

function validateUnsupportedImagePolicy(value) {
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) fail('unsupportedImagePolicy must be an object');
  const action = String(raw.action || 'vision_to_text');
  if (!UNSUPPORTED_IMAGE_ACTION_SET.has(action)) {
    fail(`unsupportedImagePolicy.action must be one of ${UNSUPPORTED_IMAGE_ACTIONS.join(', ')}`);
  }
  const visionModel = validateVisionModelRef(raw.visionModel);
  const visionProviderId = validateProviderId(raw.visionProviderId, 'unsupportedImagePolicy.visionProviderId');
  const legacyVisionProvider = raw.visionProvider && isPlainObject(raw.visionProvider)
    ? JSON.parse(JSON.stringify(raw.visionProvider))
    : undefined;
  const onVisionFailure = validateVisionFailureAction(raw.onVisionFailure, 'unsupportedImagePolicy.onVisionFailure');
  return {
    action,
    ...(visionProviderId ? { visionProviderId } : {}),
    ...(visionModel ? { visionModel } : {}),
    ...(legacyVisionProvider ? { visionProvider: legacyVisionProvider } : {}),
    onVisionFailure,
  };
}

export function validateModelConfig(value) {
  if (!isPlainObject(value)) fail('model must be an object');
  const id = nonEmptyString(value.id, 'model.id', MAX_MODEL_LEN);
  const name = optionalString(value.name, 'model.name', 200);
  const capabilities = validateCapabilities(value.capabilities);
  const unsupportedImagePolicy = validateUnsupportedImagePolicy(value.unsupportedImagePolicy);
  return {
    id,
    ...(name ? { name: name.trim() } : {}),
    capabilities,
    unsupportedImagePolicy,
  };
}

function validateMaxTokens(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
    fail('maxTokens must be an integer between 1 and 1000000');
  }
  return n;
}

function validateMaxTurns(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    fail('maxTurns must be an integer between 1 and 100');
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
  if (!partial || payload.maxTurns !== undefined) {
    out.maxTurns = validateMaxTurns(payload.maxTurns) ?? 5;
  }
  if (!partial || payload.extraHeaders !== undefined) {
    out.extraHeaders = validateExtraHeaders(payload.extraHeaders) ?? {};
  }
  if (!partial || payload.pricing !== undefined) {
    out.pricing = validateChannelPricing(payload.pricing) ?? { models: {} };
  }

  return out;
}

export function validateVisionConfig(value) {
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) fail('vision must be an object');
  const defaultChannelId = optionalString(raw.defaultChannelId, 'vision.defaultChannelId', 128) || null;
  const defaultModelId = optionalString(raw.defaultModelId, 'vision.defaultModelId', MAX_MODEL_LEN) || null;
  if ((defaultChannelId && !defaultModelId) || (!defaultChannelId && defaultModelId)) {
    fail('vision default channel and model must be set together');
  }
  const defaultProviderId = validateProviderId(raw.defaultProviderId, 'vision.defaultProviderId') || null;
  const defaultProvider = raw.defaultProvider && isPlainObject(raw.defaultProvider)
    ? JSON.parse(JSON.stringify(raw.defaultProvider))
    : null;
  const defaultFailureAction = validateVisionFailureAction(raw.defaultFailureAction, 'vision.defaultFailureAction');
  return { defaultChannelId, defaultModelId, defaultProviderId, defaultProvider, defaultFailureAction };
}
