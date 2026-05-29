import {
  fail,
  isPlainObject,
  isSafeId,
  nonEmptyString,
  optionalString,
} from './common.mjs';

export const VISION_PROVIDER_ADAPTERS = Object.freeze([
  'anthropic_model',
  'http_json',
]);

export const VISION_FAILURE_ACTIONS = Object.freeze([
  'reject',
  'remove_images',
  'ask_user',
]);

const VISION_PROVIDER_ADAPTER_SET = new Set(VISION_PROVIDER_ADAPTERS);
const VISION_FAILURE_ACTION_SET = new Set(VISION_FAILURE_ACTIONS);
const DEFAULT_HTTP_TIMEOUT_MS = 90_000;

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

function validateOptionalSafeId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!isSafeId(text)) fail(`${field} must be a safe id`);
  return text;
}

function validateInteger(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function validateStringMap(value, field) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) fail(`${field} must be an object`);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || typeof key !== 'string') fail(`${field} keys must be strings`);
    if (!['string', 'number', 'boolean'].includes(typeof raw)) {
      fail(`${field}.${key} must be a string, number, or boolean`);
    }
    out[key] = String(raw);
  }
  return out;
}

function clonePlainObject(value, field, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (!isPlainObject(value)) fail(`${field} must be an object`);
  return JSON.parse(JSON.stringify(value));
}

function validatePath(value, field, fallback) {
  const text = optionalString(value, field, 300) || fallback;
  if (!text) return '';
  if (!/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(text)) {
    fail(`${field} must be a dot path`);
  }
  return text;
}

function validateImageFormat(value, field) {
  const format = String(value || 'data_url');
  if (!['data_url', 'base64'].includes(format)) {
    fail(`${field} must be data_url or base64`);
  }
  return format;
}

function validateAnthropicModelConfig(value, field) {
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) fail(`${field} must be an object`);
  const channelId = nonEmptyString(raw.channelId, `${field}.channelId`, 128);
  const modelId = nonEmptyString(raw.modelId, `${field}.modelId`, 300);
  return { channelId, modelId };
}

function validateHttpJsonConfig(value, field) {
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) fail(`${field} must be an object`);
  const request = isPlainObject(raw.request) ? raw.request : {};
  const response = isPlainObject(raw.response) ? raw.response : {};
  const auth = isPlainObject(raw.auth) ? raw.auth : {};
  const authType = String(auth.type || 'none');
  if (!['none', 'bearer'].includes(authType)) fail(`${field}.auth.type must be none or bearer`);

  return {
    url: validateUrl(raw.url, `${field}.url`),
    method: String(raw.method || 'POST').toUpperCase(),
    timeoutMs: validateInteger(raw.timeoutMs, `${field}.timeoutMs`, DEFAULT_HTTP_TIMEOUT_MS, 1_000, 300_000),
    headers: validateStringMap(raw.headers, `${field}.headers`),
    auth: {
      type: authType,
      ...(authType === 'bearer' ? { apiKey: optionalString(auth.apiKey, `${field}.auth.apiKey`, 10_000) || '' } : {}),
    },
    request: {
      bodyTemplate: clonePlainObject(request.bodyTemplate, `${field}.request.bodyTemplate`, {}),
      promptPath: validatePath(request.promptPath, `${field}.request.promptPath`, 'prompt'),
      imagePath: validatePath(request.imagePath, `${field}.request.imagePath`, 'image_url'),
      imageFormat: validateImageFormat(request.imageFormat, `${field}.request.imageFormat`),
    },
    response: {
      textPath: validatePath(response.textPath, `${field}.response.textPath`, 'content'),
      successPath: validatePath(response.successPath, `${field}.response.successPath`, ''),
      successValue: response.successValue === undefined ? undefined : response.successValue,
      errorCodePath: validatePath(response.errorCodePath, `${field}.response.errorCodePath`, ''),
      errorMessagePath: validatePath(response.errorMessagePath, `${field}.response.errorMessagePath`, ''),
      traceHeader: optionalString(response.traceHeader, `${field}.response.traceHeader`, 120) || '',
    },
  };
}

export function validateVisionFailureAction(value, field, fallback = 'reject') {
  const action = String(value || fallback);
  if (!VISION_FAILURE_ACTION_SET.has(action)) {
    fail(`${field} must be one of ${VISION_FAILURE_ACTIONS.join(', ')}`);
  }
  return action;
}

export function validateVisionProviderPayload(payload, { partial = false } = {}) {
  if (!isPlainObject(payload)) fail('vision provider must be an object');
  const out = {};

  if (payload.id !== undefined) {
    const id = validateOptionalSafeId(payload.id, 'visionProvider.id');
    if (id) out.id = id;
  }
  if (!partial || payload.name !== undefined) {
    out.name = nonEmptyString(payload.name, 'visionProvider.name', 120);
  }
  if (!partial || payload.adapter !== undefined) {
    const adapter = String(payload.adapter || '');
    if (!VISION_PROVIDER_ADAPTER_SET.has(adapter)) {
      fail(`visionProvider.adapter must be one of ${VISION_PROVIDER_ADAPTERS.join(', ')}`);
    }
    out.adapter = adapter;
  }
  if (payload.enabled !== undefined) {
    out.enabled = payload.enabled !== false;
  } else if (!partial) {
    out.enabled = true;
  }

  const adapter = out.adapter || payload.adapter;
  if (!partial || payload.config !== undefined) {
    if (adapter === 'anthropic_model') {
      out.config = validateAnthropicModelConfig(payload.config, 'visionProvider.config');
    } else if (adapter === 'http_json') {
      out.config = validateHttpJsonConfig(payload.config, 'visionProvider.config');
    } else if (!partial) {
      fail('visionProvider.adapter is required before config can be validated');
    }
  }

  return out;
}

export function normalizeVisionProvider(value) {
  if (!isPlainObject(value) || !isSafeId(value.id)) return null;
  try {
    const provider = validateVisionProviderPayload(value, { partial: false });
    return {
      id: value.id,
      name: provider.name,
      adapter: provider.adapter,
      enabled: provider.enabled !== false,
      config: provider.config,
    };
  } catch {
    return null;
  }
}

export function validateVisionProviderList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('visionProviders must be an array');
  return value.map(normalizeVisionProvider).filter(Boolean).slice(0, 100);
}

export function minimaxTokenPlanVisionProvider({
  id = 'minimax-token-plan-vlm',
  name = 'MiniMax Token Plan VLM',
  apiKey = '',
  baseUrl = 'https://api.minimaxi.com',
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  apiSource = 'Minimax-MCP',
} = {}) {
  return normalizeVisionProvider({
    id,
    name,
    adapter: 'http_json',
    enabled: true,
    config: {
      url: `${String(baseUrl || 'https://api.minimaxi.com').replace(/\/+$/, '')}/v1/coding_plan/vlm`,
      method: 'POST',
      timeoutMs,
      headers: { 'MM-API-Source': apiSource || 'Minimax-MCP' },
      auth: { type: 'bearer', apiKey },
      request: {
        bodyTemplate: {},
        promptPath: 'prompt',
        imagePath: 'image_url',
        imageFormat: 'data_url',
      },
      response: {
        textPath: 'content',
        successPath: 'base_resp.status_code',
        successValue: 0,
        errorCodePath: 'base_resp.status_code',
        errorMessagePath: 'base_resp.status_msg',
        traceHeader: 'trace-id',
      },
    },
  });
}

export function legacyVisionProviderToProvider(value, id = 'legacy-vision-provider') {
  if (!isPlainObject(value)) return null;
  if (value.type === 'anthropic_model') {
    return normalizeVisionProvider({
      id,
      name: 'Legacy Anthropic Vision Model',
      adapter: 'anthropic_model',
      enabled: true,
      config: {
        channelId: value.channelId,
        modelId: value.modelId,
      },
    });
  }
  if (value.type === 'minimax_coding_plan_vlm') {
    return minimaxTokenPlanVisionProvider({
      id,
      name: 'MiniMax Token Plan VLM',
      apiKey: value.apiKey || '',
      baseUrl: value.baseUrl || 'https://api.minimaxi.com',
      timeoutMs: value.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS,
      apiSource: value.apiSource || 'Minimax-MCP',
    });
  }
  return null;
}
