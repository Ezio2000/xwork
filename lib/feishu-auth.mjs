import { patchStoredToolConfig, readStoredToolConfig } from './tools/store.mjs';

export const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_FEISHU_AUTH_BASE_URL = 'https://accounts.feishu.cn';
export const DEFAULT_FEISHU_OAUTH_SCOPE = 'auth:user.id:read';
export const FEISHU_DOMAIN_SCOPES = {
  docs: ['docx:document:readonly', 'space:document:retrieve'],
  wiki: ['wiki:wiki:readonly', 'wiki:node:read'],
  sheets: ['sheets:spreadsheet:read', 'sheets:spreadsheet.meta:read'],
  contact: ['contact:user.base:readonly', 'contact:user.basic_profile:readonly'],
};

const LEGACY_BAD_OAUTH_SCOPE = 'auth:user.id:read user_profile';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const TOKEN_CONFIG_KEYS = [
  'user_access_token',
  'user_access_token_expires_at',
  'refresh_token',
  'refresh_token_expires_at',
];

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function configuredString(config, key, fallback = '') {
  const value = plainObject(config)[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

export function normalizeBaseUrl(value, fallback = DEFAULT_FEISHU_BASE_URL) {
  const baseUrl = String(value || fallback).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') throw new Error('baseUrl must use https');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid Feishu baseUrl: ${baseUrl}`);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Feishu returned non-JSON response: ${text.slice(0, 300)}`);
  }
}

async function requestJson(baseUrl, path, { method = 'GET', query, body, accessToken, signal } = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    signal,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(`Feishu HTTP ${response.status}: ${payload.msg || payload.message || response.statusText}`);
  }
  if (payload.code !== undefined && payload.code !== 0) {
    const err = new Error(`Feishu API error ${payload.code}: ${payload.msg || payload.message || 'unknown error'}`);
    err.code = payload.code;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function mergeConfig(...configs) {
  const out = {};
  for (const config of configs) {
    for (const [key, value] of Object.entries(plainObject(config))) {
      if (value === undefined || value === null || value === '') continue;
      out[key] = value;
    }
  }
  return out;
}

export async function loadFeishuAuthConfig(config = {}, { includeStoredAuth = true, includeStoredRead = true } = {}) {
  const authStored = includeStoredAuth ? await readStoredToolConfig('feishu_auth') : {};
  const readStored = includeStoredRead ? await readStoredToolConfig('feishu_read') : {};
  return mergeConfig(readStored, authStored, config);
}

export function feishuBaseUrl(config = {}) {
  return normalizeBaseUrl(configuredString(config, 'baseUrl', process.env.FEISHU_BASE_URL || DEFAULT_FEISHU_BASE_URL));
}

function feishuAuthBaseUrl(config = {}) {
  return normalizeBaseUrl(
    configuredString(config, 'authBaseUrl', process.env.FEISHU_AUTH_BASE_URL || DEFAULT_FEISHU_AUTH_BASE_URL),
    DEFAULT_FEISHU_AUTH_BASE_URL,
  );
}

function scopeParts(value) {
  if (Array.isArray(value)) return value.flatMap(scopeParts);
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function mergeOAuthScopes(...values) {
  return [...new Set(values.flatMap(scopeParts))].join(' ');
}

export function scopesForDomains(...values) {
  const domains = scopeParts(values);
  const scopes = [];
  for (const domain of domains) {
    scopes.push(...(FEISHU_DOMAIN_SCOPES[domain] || []));
  }
  return scopes;
}

export function scopesFromAuthInput(input = {}) {
  return [
    ...scopeParts(input.scope),
    ...scopeParts(input.scopes),
    ...scopesForDomains(input.domain, input.domains),
  ];
}

export function configWithOAuthScopes(config = {}, ...extraScopes) {
  return {
    ...config,
    oauthScope: mergeOAuthScopes(configuredString(config, 'oauthScope', DEFAULT_FEISHU_OAUTH_SCOPE), ...extraScopes),
  };
}

function configuredOAuthScope(config = {}) {
  const scope = configuredString(config, 'oauthScope', DEFAULT_FEISHU_OAUTH_SCOPE).trim();
  return scope === LEGACY_BAD_OAUTH_SCOPE ? DEFAULT_FEISHU_OAUTH_SCOPE : scope;
}

function feishuCredentials(config = {}) {
  const appId = configuredString(config, 'app_id', configuredString(config, 'appId', process.env.FEISHU_APP_ID || process.env.LARK_APP_ID));
  const appSecret = configuredString(config, 'app_secret', configuredString(config, 'appSecret', process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET));
  if (!appId || !appSecret) throw new Error('Feishu app_id/app_secret are required for user authorization.');
  return { appId, appSecret };
}

export function getUserAccessToken(config = {}) {
  const token = configuredString(
    config,
    'user_access_token',
    configuredString(
      config,
      'userAccessToken',
      process.env.FEISHU_USER_ACCESS_TOKEN || process.env.LARK_USER_ACCESS_TOKEN || '',
    ),
  ) || configuredString(config, 'accessToken', process.env.FEISHU_ACCESS_TOKEN || process.env.LARK_ACCESS_TOKEN);
  if (!token) {
    throw new Error('Feishu user_access_token is not configured. Set FEISHU_USER_ACCESS_TOKEN or configure user_access_token in the tool settings.');
  }
  return token.replace(/^Bearer\s+/i, '').trim();
}

export function shouldStartUserAuthorization(err) {
  const text = [
    err?.message,
    err?.code,
    err?.payload?.error,
    err?.payload?.error_description,
    err?.payload?.msg,
    err?.payload?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return /user_access_token is not configured|invalid.*token|token.*invalid|expired.*token|token.*expired|unauthorized|access token|access_token|invalid_auth|auth.*failed|20027|99991663|99991668/.test(text);
}

export async function startDeviceAuthorization(config = {}) {
  const { appId, appSecret } = feishuCredentials(config);
  const scope = configuredOAuthScope(config);
  const payload = await requestJson(feishuAuthBaseUrl(config), '/oauth/v1/device_authorization', {
    method: 'POST',
    body: {
      client_id: appId,
      client_secret: appSecret,
      scope,
    },
  });

  const data = payload.data || payload;
  const verificationUrl = data.verification_url || data.verification_uri_complete || data.verification_uri;
  const deviceCode = data.device_code;
  if (!verificationUrl || !deviceCode) throw new Error('Feishu device authorization response is missing verification_url or device_code');

  return {
    action: 'login',
    resourceType: 'authorization',
    authorizationRequired: true,
    flow: 'device',
    verificationUrl,
    authorizationUrl: verificationUrl,
    deviceCode,
    interval: data.interval || 5,
    expiresIn: Number(data.expires_in || 600),
    expiresAt: new Date(Date.now() + Number(data.expires_in || 600) * 1000).toISOString(),
    hint: `Show verification_url to user, then complete authorization with device_code ${deviceCode}. Do not instruct the user to run this command themselves.`,
    message: 'Open verificationUrl and approve Feishu access. No redirect URL is required.',
  };
}

export async function exchangeDeviceCode(config = {}, deviceCode, signal) {
  if (typeof deviceCode !== 'string' || !deviceCode.trim()) throw new Error('deviceCode is required');
  const { appId, appSecret } = feishuCredentials(config);
  const response = await fetch(`${feishuBaseUrl(config)}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: DEVICE_GRANT_TYPE,
      client_id: appId,
      client_secret: appSecret,
      device_code: deviceCode.trim(),
    }),
  });

  const payload = await readJson(response);
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    const err = new Error(payload.error_description || payload.msg || payload.message || response.statusText || 'Feishu device authorization failed');
    err.code = payload.error || payload.code || response.status;
    err.payload = payload;
    throw err;
  }

  const data = payload.data || payload;
  const accessToken = data.access_token || data.user_access_token;
  if (!accessToken) throw new Error('Feishu device authorization did not return access_token');
  return {
    accessToken,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token || '',
    refreshExpiresIn: data.refresh_expires_in,
  };
}

export async function saveUserToken(tokenData) {
  const patch = currentConfig => ({
    ...currentConfig,
    user_access_token: tokenData.accessToken,
    user_access_token_expires_at: tokenData.expiresIn
      ? new Date(Date.now() + Number(tokenData.expiresIn) * 1000).toISOString()
      : '',
    refresh_token: tokenData.refreshToken || currentConfig.refresh_token || '',
    refresh_token_expires_at: tokenData.refreshExpiresIn
      ? new Date(Date.now() + Number(tokenData.refreshExpiresIn) * 1000).toISOString()
      : '',
  });
  await patchStoredToolConfig('feishu_auth', patch);
}

export async function clearUserToken() {
  const patch = currentConfig => {
    const next = { ...currentConfig };
    for (const key of TOKEN_CONFIG_KEYS) delete next[key];
    next.user_access_token = '';
    return next;
  };
  await patchStoredToolConfig('feishu_auth', patch);
}

function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Tool execution aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Tool execution aborted'));
    }, { once: true });
  });
}

export async function pollDeviceAuthorization(config = {}, auth, { signal, emit, action = 'login' } = {}) {
  const expiresAt = Date.parse(auth.expiresAt || '') || (Date.now() + 10 * 60 * 1000);
  let intervalMs = Math.max(2, Number(auth.interval || 5)) * 1000;

  while (Date.now() < expiresAt) {
    try {
      const tokenData = await exchangeDeviceCode(config, auth.deviceCode, signal);
      await saveUserToken(tokenData);
      emit?.({
        phase: 'feishu_auth_complete',
        action,
        label: 'Feishu authorization completed',
      });
      return tokenData;
    } catch (err) {
      const code = String(err.code || '').toLowerCase();
      const message = String(err.message || '');
      if (code === 'authorization_pending' || /authorization_pending|not authorized|pending/i.test(message)) {
        await waitMs(intervalMs, signal);
        continue;
      }
      if (code === 'slow_down') {
        intervalMs += 5000;
        await waitMs(intervalMs, signal);
        continue;
      }
      if (code === 'access_denied') throw new Error('Feishu authorization was denied by the user');
      if (code === 'expired_token' || /expired/i.test(message)) throw new Error('Feishu device authorization expired; please retry');
      throw err;
    }
  }

  throw new Error('Feishu device authorization expired; please retry');
}

export async function authorizeAndWait(config = {}, { signal, emit, action = 'login' } = {}) {
  const auth = await startDeviceAuthorization(config);
  emit?.({
    phase: 'feishu_auth_pending',
    action,
    label: 'Feishu authorization required',
    verificationUrl: auth.verificationUrl,
    authorizationUrl: auth.authorizationUrl,
    deviceCode: auth.deviceCode,
    expiresAt: auth.expiresAt,
    interval: auth.interval,
  });
  const tokenData = await pollDeviceAuthorization(config, auth, { signal, emit, action });
  return { auth, tokenData };
}

export async function completeDeviceAuthorization(input = {}, { config = {}, signal } = {}) {
  const deviceCode = input.deviceCode || input.device_code;
  const tokenData = await exchangeDeviceCode(config, deviceCode, signal);
  await saveUserToken(tokenData);
  return {
    action: input.action || 'complete',
    resourceType: 'authorization',
    authorizationRequired: false,
    expiresIn: tokenData.expiresIn,
    hasRefreshToken: Boolean(tokenData.refreshToken),
    message: 'Feishu user authorization completed. The token was saved for Feishu tools.',
  };
}
