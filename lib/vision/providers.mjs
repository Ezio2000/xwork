import { streamChat } from '../api.mjs';
import { findChannelModel } from '../channels.mjs';

export const VISION_SUMMARY_PROMPT = [
  '请识别这张图片，输出可供后续文本模型使用的通用结果。',
  '请用简体中文，包含：',
  '1. 画面/截图/文档的主要内容。',
  '2. 图片中的文字 OCR，尽量保留原文和结构。',
  '3. 对用户后续提问可能有用的关键细节。',
  '不要回答用户的具体业务问题，只做客观识别。',
].join('\n');

export class VisionProviderError extends Error {
  constructor(message, {
    providerType = '',
    code = 'vision_provider_error',
    status = null,
    traceId = '',
    retryable = false,
  } = {}) {
    super(message);
    this.name = 'VisionProviderError';
    this.providerType = providerType;
    this.code = code;
    this.status = status;
    this.traceId = traceId;
    this.retryable = retryable;
  }
}

function modelSupportsImages(modelConfig) {
  return modelConfig?.capabilities?.imageInput === true;
}

function parseVisionText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { caption: '', ocrText: '' };
  const ocrMatch = raw.match(/(?:OCR|文字|文本)[：:]\s*([\s\S]*)/i);
  return {
    caption: raw,
    ocrText: ocrMatch ? ocrMatch[1].trim() : '',
  };
}

function dataUrlForAsset(asset, base64) {
  return `data:${asset.mediaType || 'image/png'};base64,${base64}`;
}

function traceIdFromHeaders(headers, configuredHeader = '') {
  if (configuredHeader) return headers?.get?.(configuredHeader) || '';
  return headers?.get?.('trace-id') || headers?.get?.('x-request-id') || headers?.get?.('Trace-Id') || '';
}

function abortErrorMessage(err) {
  return err?.name === 'AbortError' ? 'Vision request aborted' : err?.message || String(err);
}

function getPath(value, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : undefined
  ), value);
}

function setPath(target, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function responseValueEquals(actual, expected) {
  if (expected === undefined) return Boolean(actual);
  return actual === expected || String(actual) === String(expected);
}

async function summarizeWithAnthropicModel({ provider, appConfig, asset, base64, signal }) {
  const config = provider.config || provider;
  const providerType = provider.adapter || provider.type;
  const channel = (appConfig?.channels || []).find(item => item.id === config.channelId);
  if (!channel) {
    throw new VisionProviderError('Vision channel not found', {
      providerType,
      code: 'vision_channel_not_found',
    });
  }
  if (!channel.apiKey) {
    throw new VisionProviderError('API key not configured for the vision channel', {
      providerType,
      code: 'vision_api_key_missing',
    });
  }
  const modelConfig = findChannelModel(channel, config.modelId);
  if (!modelConfig) {
    throw new VisionProviderError('Vision model not found in selected channel', {
      providerType,
      code: 'vision_model_not_found',
    });
  }
  if (!modelSupportsImages(modelConfig)) {
    throw new VisionProviderError('Selected vision model does not support image input', {
      providerType,
      code: 'vision_model_no_image_input',
    });
  }

  const result = await streamChat(
    {
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: config.modelId,
      maxTokens: channel.maxTokens || 8192,
      maxTurns: channel.maxTurns || 5,
      extraHeaders: channel.extraHeaders || {},
      tools: [],
      modelConfig,
      channelId: channel.id,
      appConfig,
    },
    [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: asset.mediaType,
            data: base64,
          },
        },
        { type: 'text', text: VISION_SUMMARY_PROMPT },
      ],
    }],
    () => {},
    () => {},
    () => {},
    (err) => {
      if (err) throw err;
    },
    () => {},
    { signal },
  );

  if (result.stopReason === 'error') {
    throw new VisionProviderError('Vision model failed to summarize image', {
      providerType,
      code: 'vision_model_failed',
      retryable: true,
    });
  }

  const parsed = parseVisionText(result.text);
  return {
    ...parsed,
    providerType,
    providerRef: `${channel.id}/${config.modelId}`,
  };
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), rawText: text };
  } catch {
    return { data: null, rawText: text };
  }
}

async function summarizeWithHttpJson({ provider, asset, base64, signal }) {
  const config = provider.config || {};
  if (config.auth?.type === 'bearer' && !config.auth.apiKey) {
    throw new VisionProviderError('Vision HTTP JSON provider API key is not configured', {
      providerType: provider.adapter,
      code: 'vision_api_key_missing',
    });
  }

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs || 90_000;
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Vision HTTP JSON request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const forwardAbort = () => controller.abort(signal.reason || new Error('Vision request aborted'));
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  let res;
  try {
    const body = cloneJson(config.request?.bodyTemplate);
    setPath(body, config.request?.promptPath || 'prompt', VISION_SUMMARY_PROMPT);
    setPath(
      body,
      config.request?.imagePath || 'image_url',
      config.request?.imageFormat === 'base64' ? base64 : dataUrlForAsset(asset, base64),
    );
    res = await fetch(config.url, {
      method: config.method || 'POST',
      signal: controller.signal,
      headers: {
        ...(config.auth?.type === 'bearer' ? { Authorization: `Bearer ${config.auth.apiKey}` } : {}),
        ...(config.headers || {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new VisionProviderError(`Vision HTTP JSON request failed: ${abortErrorMessage(err)}`, {
      providerType: provider.adapter,
      code: err?.name === 'AbortError' ? 'vision_request_aborted' : 'vision_network_error',
      retryable: err?.name !== 'AbortError',
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', forwardAbort);
  }

  const traceId = traceIdFromHeaders(res.headers, config.response?.traceHeader);
  const { data, rawText } = await readJsonResponse(res);
  if (!res.ok) {
    throw new VisionProviderError(`Vision HTTP JSON provider returned HTTP ${res.status}`, {
      providerType: provider.adapter,
      code: 'vision_http_error',
      status: res.status,
      traceId,
      retryable: res.status >= 500,
    });
  }
  if (!data || typeof data !== 'object') {
    throw new VisionProviderError('Vision HTTP JSON provider returned non-JSON response', {
      providerType: provider.adapter,
      code: 'vision_invalid_json',
      traceId,
      retryable: false,
    });
  }

  const successPath = config.response?.successPath || '';
  if (successPath) {
    const actual = getPath(data, successPath);
    if (!responseValueEquals(actual, config.response?.successValue)) {
      const errorCode = getPath(data, config.response?.errorCodePath) ?? actual ?? 'unknown';
      const errorMessage = getPath(data, config.response?.errorMessagePath) || rawText.slice(0, 200) || 'unknown error';
      throw new VisionProviderError(`Vision HTTP JSON provider failed: ${errorCode} ${errorMessage}`, {
        providerType: provider.adapter,
        code: `vision_provider_${errorCode}`,
        traceId,
        retryable: Number(errorCode) >= 5000,
      });
    }
  }

  const content = String(getPath(data, config.response?.textPath || 'content') || '').trim();
  if (!content) {
    throw new VisionProviderError('Vision HTTP JSON provider returned empty content', {
      providerType: provider.adapter,
      code: 'vision_empty_content',
      traceId,
      retryable: true,
    });
  }

  const parsed = parseVisionText(content);
  return {
    ...parsed,
    providerType: provider.adapter,
    providerRef: provider.id || config.url,
    traceId,
  };
}

const PROVIDERS = Object.freeze({
  anthropic_model: summarizeWithAnthropicModel,
  http_json: summarizeWithHttpJson,
});

export async function summarizeImageWithVisionProvider({ provider, appConfig, asset, base64, signal }) {
  const handler = PROVIDERS[provider?.adapter || provider?.type];
  if (!handler) {
    throw new VisionProviderError('Vision provider is not supported', {
      providerType: provider?.adapter || provider?.type || '',
      code: 'vision_provider_unsupported',
    });
  }
  return handler({ provider, appConfig, asset, base64, signal });
}
