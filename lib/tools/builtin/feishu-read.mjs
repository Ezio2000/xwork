import { patchStoredToolConfig } from '../store.mjs';

const DEFAULT_BASE_URL = 'https://open.feishu.cn';
const DEFAULT_AUTH_BASE_URL = 'https://accounts.feishu.cn';
const DEFAULT_MAX_TEXT_CHARS = 50_000;
const DEFAULT_MAX_CELLS = 2_000;
const DEFAULT_MAX_CELL_CHARS = 1_000;
const DEFAULT_SHEET_RANGE = 'A1:Z100';

const ACTIONS = new Set([
  'read_doc',
  'read_old_doc',
  'read_sheet',
  'get_sheet_meta',
  'get_user',
  'get_current_user',
  'authorize_current_user',
  'complete_current_user_authorization',
]);
const VALUE_RENDER_OPTIONS = new Set(['ToString', 'FormattedValue', 'Formula', 'UnformattedValue']);
const DATETIME_RENDER_OPTIONS = new Set(['FormattedString', 'SerialNumber']);
const USER_ID_TYPES = new Set(['open_id', 'union_id', 'user_id', 'lark_id']);
const DEPARTMENT_ID_TYPES = new Set(['open_department_id', 'department_id']);
const DEFAULT_OAUTH_SCOPE = 'auth:user.id:read';
const LEGACY_BAD_OAUTH_SCOPE = 'auth:user.id:read user_profile';

let cachedTenantToken = null;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function configuredString(config, key, fallback = '') {
  const value = plainObject(config)[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function configuredInteger(config, key, fallback, min, max) {
  const value = plainObject(config)[key];
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') throw new Error('baseUrl must use https');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid Feishu baseUrl: ${baseUrl}`);
  }
}

function configuredBoolean(config, key, fallback) {
  const value = plainObject(config)[key];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
  return Boolean(value);
}

function requiredToken(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > 200) throw new Error(`${name} is too long`);
  return value.trim();
}

function maybeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function extractTokenFromUrl(urlValue, kind) {
  const url = maybeUrl(urlValue);
  if (!url) return {};
  const parts = url.pathname.split('/').filter(Boolean);
  const out = {};

  for (let i = 0; i < parts.length - 1; i += 1) {
    const name = parts[i].toLowerCase();
    const token = decodeURIComponent(parts[i + 1] || '');
    if ((name === 'docx' || name === 'docs') && token) out.documentId = token;
    if ((name === 'doc' || name === 'docs') && token) out.docToken = token;
    if (name === 'sheets' && token) out.spreadsheetToken = token;
    if (name === 'wiki' && token) out.wikiToken = token;
  }

  const sheetId = url.searchParams.get('sheet') || url.searchParams.get('sheet_id');
  if (sheetId) out.sheetId = sheetId;

  if (kind === 'doc') return { documentId: out.documentId || out.docToken, wikiToken: out.wikiToken };
  if (kind === 'old_doc') return { docToken: out.docToken || out.documentId };
  if (kind === 'sheet') return { spreadsheetToken: out.spreadsheetToken, sheetId: out.sheetId };
  return out;
}

function clampText(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n\n... [content truncated]`,
    truncated: true,
  };
}

function cellToDisplay(value, maxChars) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = JSON.stringify(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function trimValueRanges(valueRanges, { maxCells, maxCellChars }) {
  const out = [];
  let usedCells = 0;
  let truncated = false;

  for (const item of Array.isArray(valueRanges) ? valueRanges : []) {
    const rows = [];
    for (const row of Array.isArray(item.values) ? item.values : []) {
      if (usedCells >= maxCells) {
        truncated = true;
        break;
      }
      const nextRow = [];
      for (const cell of Array.isArray(row) ? row : []) {
        if (usedCells >= maxCells) {
          truncated = true;
          break;
        }
        nextRow.push(cellToDisplay(cell, maxCellChars));
        usedCells += 1;
      }
      rows.push(nextRow);
    }
    out.push({
      majorDimension: item.majorDimension || 'ROWS',
      range: item.range || '',
      revision: item.revision,
      values: rows,
    });
    if (truncated) break;
  }

  return { valueRanges: out, usedCells, truncated };
}

function formatSheetAsTsv(valueRanges) {
  const sections = [];
  for (const range of valueRanges) {
    const values = Array.isArray(range.values) ? range.values : [];
    const lines = values.map(row => (Array.isArray(row) ? row : [])
      .map(cell => String(cell ?? '').replace(/\r?\n/g, ' '))
      .join('\t'));
    sections.push(`## ${range.range || 'range'}\n\n${lines.join('\n') || '(empty)'}`);
  }
  return sections.join('\n\n');
}

function normalizeRanges(input, meta, config) {
  const ranges = Array.isArray(input.ranges)
    ? input.ranges.map(item => String(item).trim()).filter(Boolean)
    : [];
  if (typeof input.range === 'string' && input.range.trim()) ranges.push(input.range.trim());
  if (ranges.length) return ranges.map(range => {
    if (range.includes('!')) return range;
    const sheetId = input.sheetId || extractTokenFromUrl(input.url, 'sheet').sheetId;
    return sheetId ? `${sheetId}!${range}` : range;
  });

  const sheetId = input.sheetId || extractTokenFromUrl(input.url, 'sheet').sheetId || meta?.sheets?.[0]?.sheetId;
  if (!sheetId) throw new Error('sheetId or ranges is required when the spreadsheet has no readable sheet metadata');
  return [`${sheetId}!${configuredString(config, 'defaultSheetRange', DEFAULT_SHEET_RANGE)}`];
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
    throw new Error(`Feishu API error ${payload.code}: ${payload.msg || payload.message || 'unknown error'}`);
  }
  return payload;
}

async function getAccessToken(config, signal) {
  const directToken = configuredString(config, 'accessToken', process.env.FEISHU_ACCESS_TOKEN || process.env.LARK_ACCESS_TOKEN);
  if (directToken) return directToken.replace(/^Bearer\s+/i, '').trim();

  const appId = configuredString(config, 'app_id', configuredString(config, 'appId', process.env.FEISHU_APP_ID || process.env.LARK_APP_ID));
  const appSecret = configuredString(config, 'app_secret', configuredString(config, 'appSecret', process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET));
  if (!appId || !appSecret) {
    throw new Error('Feishu credentials are not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET, or configure accessToken.');
  }

  const baseUrl = normalizeBaseUrl(configuredString(config, 'baseUrl', process.env.FEISHU_BASE_URL || DEFAULT_BASE_URL));
  const now = Date.now();
  if (cachedTenantToken?.appId === appId && cachedTenantToken?.baseUrl === baseUrl && cachedTenantToken.expiresAt > now + 60_000) {
    return cachedTenantToken.token;
  }

  const payload = await requestJson(baseUrl, '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: { app_id: appId, app_secret: appSecret },
    signal,
  });
  const token = payload.tenant_access_token;
  if (!token) throw new Error('Feishu did not return tenant_access_token');
  const expireSeconds = Number(payload.expire || 7200);
  cachedTenantToken = {
    appId,
    baseUrl,
    token,
    expiresAt: now + Math.max(60, expireSeconds - 120) * 1000,
  };
  return token;
}

function getUserAccessToken(config) {
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

function configuredOAuthScope(config) {
  const scope = configuredString(config, 'oauthScope', DEFAULT_OAUTH_SCOPE).trim();
  return scope === LEGACY_BAD_OAUTH_SCOPE ? DEFAULT_OAUTH_SCOPE : scope;
}

function shouldStartUserAuthorization(err) {
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

async function createUserAuthorizationRequest(config) {
  const appId = configuredString(config, 'app_id', configuredString(config, 'appId', process.env.FEISHU_APP_ID || process.env.LARK_APP_ID));
  const appSecret = configuredString(config, 'app_secret', configuredString(config, 'appSecret', process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET));
  if (!appId || !appSecret) throw new Error('Feishu app_id/app_secret are required to start device authorization.');
  const authBaseUrl = normalizeBaseUrl(configuredString(config, 'authBaseUrl', process.env.FEISHU_AUTH_BASE_URL || DEFAULT_AUTH_BASE_URL));
  const scope = configuredOAuthScope(config);

  const payload = await requestJson(authBaseUrl, '/oauth/v1/device_authorization', {
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
    action: 'authorize_current_user',
    resourceType: 'authorization',
    authorizationRequired: true,
    flow: 'device',
    verificationUrl,
    authorizationUrl: verificationUrl,
    deviceCode,
    interval: data.interval || 5,
    expiresAt: new Date(Date.now() + Number(data.expires_in || 600) * 1000).toISOString(),
    message: 'Open verificationUrl, approve Feishu access, then call complete_current_user_authorization with the deviceCode. No redirect URL is required.',
  };
}

function feishuBaseUrl(config) {
  return normalizeBaseUrl(configuredString(config, 'baseUrl', process.env.FEISHU_BASE_URL || DEFAULT_BASE_URL));
}

function feishuCredentials(config) {
  const appId = configuredString(config, 'app_id', configuredString(config, 'appId', process.env.FEISHU_APP_ID || process.env.LARK_APP_ID));
  const appSecret = configuredString(config, 'app_secret', configuredString(config, 'appSecret', process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET));
  if (!appId || !appSecret) throw new Error('Feishu app_id/app_secret are required for user authorization.');
  return { appId, appSecret };
}

async function exchangeDeviceCode(config, deviceCode, signal) {
  const { appId, appSecret } = feishuCredentials(config);
  const response = await fetch(`${feishuBaseUrl(config)}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: appId,
      client_secret: appSecret,
      device_code: deviceCode,
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

async function saveUserToken(config, tokenData) {
  await patchStoredToolConfig('feishu_read', currentConfig => ({
    ...currentConfig,
    user_access_token: tokenData.accessToken,
    user_access_token_expires_at: tokenData.expiresIn
      ? new Date(Date.now() + Number(tokenData.expiresIn) * 1000).toISOString()
      : '',
    refresh_token: tokenData.refreshToken || currentConfig.refresh_token || '',
    refresh_token_expires_at: tokenData.refreshExpiresIn
      ? new Date(Date.now() + Number(tokenData.refreshExpiresIn) * 1000).toISOString()
      : '',
  }));
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

async function pollDeviceAuthorization(config, auth, { signal, emit } = {}) {
  const expiresAt = Date.parse(auth.expiresAt || '') || (Date.now() + 10 * 60 * 1000);
  let intervalMs = Math.max(2, Number(auth.interval || 5)) * 1000;

  while (Date.now() < expiresAt) {
    try {
      const tokenData = await exchangeDeviceCode(config, auth.deviceCode, signal);
      await saveUserToken(config, tokenData);
      emit?.({
        phase: 'feishu_auth_complete',
        action: 'get_current_user',
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

async function completeUserAuthorization(input, { config, signal }) {
  const deviceCode = requiredToken(input.deviceCode || input.device_code, 'deviceCode');
  const tokenData = await exchangeDeviceCode(config, deviceCode, signal);
  await saveUserToken(config, tokenData);
  return {
    action: 'complete_current_user_authorization',
    resourceType: 'authorization',
    authorizationRequired: false,
    expiresIn: tokenData.expiresIn,
    hasRefreshToken: Boolean(tokenData.refreshToken),
    message: 'Feishu user authorization completed. The token can now be saved and get_current_user can be retried.',
  };
}

async function feishuApi(config, path, options) {
  const baseUrl = normalizeBaseUrl(configuredString(config, 'baseUrl', process.env.FEISHU_BASE_URL || DEFAULT_BASE_URL));
  const accessToken = await getAccessToken(config, options?.signal);
  return requestJson(baseUrl, path, { ...options, accessToken });
}

async function feishuUserApi(config, path, options) {
  const baseUrl = normalizeBaseUrl(configuredString(config, 'baseUrl', process.env.FEISHU_BASE_URL || DEFAULT_BASE_URL));
  const accessToken = getUserAccessToken(config);
  return requestJson(baseUrl, path, { ...options, accessToken });
}

async function readDoc(input, { config, signal }) {
  const fromUrl = extractTokenFromUrl(input.url, 'doc');
  const documentId = requiredToken(input.documentId || fromUrl.documentId, 'documentId');
  const lang = input.lang === undefined || input.lang === null ? 0 : Number(input.lang);
  const payload = await feishuApi(config, `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, {
    query: { lang },
    signal,
  });
  const maxTextChars = configuredInteger(config, 'maxTextChars', DEFAULT_MAX_TEXT_CHARS, 1000, 200_000);
  const rawContent = payload.data?.content ?? payload.data?.raw_content ?? payload.content ?? '';
  const { text, truncated } = clampText(rawContent, maxTextChars);
  return {
    action: 'read_doc',
    resourceType: 'docx',
    documentId,
    url: input.url || null,
    content: text,
    contentLength: String(rawContent || '').length,
    truncated,
  };
}

async function readOldDoc(input, { config, signal }) {
  const fromUrl = extractTokenFromUrl(input.url, 'old_doc');
  const docToken = requiredToken(input.docToken || fromUrl.docToken, 'docToken');
  const payload = await feishuApi(config, `/open-apis/doc/v2/${encodeURIComponent(docToken)}/raw_content`, { signal });
  const maxTextChars = configuredInteger(config, 'maxTextChars', DEFAULT_MAX_TEXT_CHARS, 1000, 200_000);
  const rawContent = payload.data?.content ?? payload.content ?? '';
  const { text, truncated } = clampText(rawContent, maxTextChars);
  return {
    action: 'read_old_doc',
    resourceType: 'doc',
    docToken,
    url: input.url || null,
    content: text,
    contentLength: String(rawContent || '').length,
    truncated,
  };
}

async function getSheetMeta(input, { config, signal }) {
  const fromUrl = extractTokenFromUrl(input.url, 'sheet');
  const spreadsheetToken = requiredToken(input.spreadsheetToken || fromUrl.spreadsheetToken, 'spreadsheetToken');
  const payload = await feishuApi(config, `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/metainfo`, {
    query: {
      user_id_type: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
    },
    signal,
  });
  const data = payload.data || {};
  return {
    action: 'get_sheet_meta',
    resourceType: 'sheet',
    spreadsheetToken,
    url: input.url || null,
    properties: data.properties || {},
    sheets: Array.isArray(data.sheets) ? data.sheets : [],
  };
}

async function getUser(input, { config, signal }) {
  const userId = requiredToken(input.userId || input.user_id, 'userId');
  const payload = await feishuApi(config, `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`, {
    query: {
      user_id_type: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
      department_id_type: input.departmentIdType || configuredString(config, 'departmentIdType', 'open_department_id'),
    },
    signal,
  });
  return {
    action: 'get_user',
    resourceType: 'user',
    userId,
    userIdType: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
    departmentIdType: input.departmentIdType || configuredString(config, 'departmentIdType', 'open_department_id'),
    user: payload.data?.user || payload.data || {},
  };
}

async function getCurrentUser(input, { config, signal, emit }) {
  let payload;
  try {
    payload = await feishuUserApi(config, '/open-apis/authen/v1/user_info', { signal });
  } catch (err) {
    if (configuredBoolean(config, 'autoAuthorizeUser', true) && shouldStartUserAuthorization(err)) {
      const auth = await createUserAuthorizationRequest(config);
      emit?.({
        phase: 'feishu_auth_pending',
        action: 'get_current_user',
        label: 'Feishu authorization required',
        verificationUrl: auth.verificationUrl,
        authorizationUrl: auth.authorizationUrl,
        deviceCode: auth.deviceCode,
        expiresAt: auth.expiresAt,
        interval: auth.interval,
      });
      const tokenData = await pollDeviceAuthorization(config, auth, { signal, emit });
      payload = await requestJson(feishuBaseUrl(config), '/open-apis/authen/v1/user_info', {
        signal,
        accessToken: tokenData.accessToken,
      });
    } else {
      throw err;
    }
  }
  return {
    action: 'get_current_user',
    resourceType: 'user',
    userId: payload.data?.user_id || payload.data?.open_id || payload.data?.union_id || '',
    userIdType: payload.data?.user_id ? 'user_id' : payload.data?.open_id ? 'open_id' : payload.data?.union_id ? 'union_id' : '',
    user: payload.data || {},
  };
}

async function readSheet(input, { config, signal }) {
  const fromUrl = extractTokenFromUrl(input.url, 'sheet');
  const spreadsheetToken = requiredToken(input.spreadsheetToken || fromUrl.spreadsheetToken, 'spreadsheetToken');
  let meta = null;
  if (!input.ranges?.length && !input.range && !(input.sheetId || fromUrl.sheetId)) {
    meta = await getSheetMeta({ ...input, spreadsheetToken }, { config, signal });
  }
  const ranges = normalizeRanges({ ...input, spreadsheetToken, sheetId: input.sheetId || fromUrl.sheetId }, meta, config);
  const maxRanges = configuredInteger(config, 'maxRanges', 10, 1, 50);
  if (ranges.length > maxRanges) throw new Error(`ranges exceeds maxRanges (${maxRanges})`);

  const payload = await feishuApi(config, `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_batch_get`, {
    query: {
      ranges,
      valueRenderOption: input.valueRenderOption || configuredString(config, 'valueRenderOption', 'ToString'),
      dateTimeRenderOption: input.dateTimeRenderOption || configuredString(config, 'dateTimeRenderOption', 'FormattedString'),
      user_id_type: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
    },
    signal,
  });
  const data = payload.data || {};
  const maxCells = configuredInteger(config, 'maxCells', DEFAULT_MAX_CELLS, 1, 20_000);
  const maxCellChars = configuredInteger(config, 'maxCellChars', DEFAULT_MAX_CELL_CHARS, 100, 10_000);
  const trimmed = trimValueRanges(data.valueRanges, { maxCells, maxCellChars });
  const markdown = formatSheetAsTsv(trimmed.valueRanges);
  return {
    action: 'read_sheet',
    resourceType: 'sheet',
    spreadsheetToken,
    url: input.url || null,
    revision: data.revision,
    totalCells: data.totalCells,
    returnedCells: trimmed.usedCells,
    ranges,
    valueRanges: trimmed.valueRanges,
    content: markdown,
    truncated: trimmed.truncated,
    ...(meta ? { properties: meta.properties, sheets: meta.sheets } : {}),
  };
}

export const feishuReadTool = {
  id: 'feishu_read',
  name: 'feishu_read',
  title: 'Feishu Read',
  description: [
    'Read Feishu/Lark cloud documents, spreadsheets, and user profile data using Feishu OpenAPI. Supports new Docx raw text, legacy Doc raw text, spreadsheet metadata/range values, contact user lookup, and current authorized user lookup.',
    '',
    'Usage notes:',
    '- The tool is read-only and requires a Feishu app token or tenant credentials configured on the server.',
    '- For Docx URLs use action="read_doc"; for legacy docs use action="read_old_doc".',
    '- For spreadsheets use action="read_sheet" with ranges like ["sheetId!A1:D20"]. If no range is provided, the tool reads the first sheet using the configured default range.',
    '- For users use action="get_user" with userId. userIdType controls whether the ID is open_id, union_id, user_id, or lark_id.',
    '- To read the current authorized user, use action="get_current_user" with no userId. If no user_access_token is configured, the tool starts Device Flow and returns verificationUrl/deviceCode.',
    '- After the user approves verificationUrl, call action="complete_current_user_authorization" with deviceCode, then retry get_current_user.',
    '- Prefer narrow spreadsheet ranges to avoid large outputs.',
  ].join('\n'),
  category: 'web',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: false,
  timeoutMs: 30000,
  systemPrompt() {
    return [
      '# feishu_read',
      '- When the user asks for their own Feishu profile, current user, "我", or "当前用户", call feishu_read with action="get_current_user". Do not ask for a user ID first.',
      '- get_current_user handles missing, invalid, or expired user_access_token by starting Feishu Device Flow inside the same tool call. Do not call ask_user for Feishu authorization and do not manually print verification steps unless the tool itself fails.',
      '- If a Feishu authorization UI block appears, wait for the tool result. The tool continues automatically after the user approves access.',
      '- Use action="get_user" only when the user explicitly provides an ID or asks about a specific other user.',
    ].join('\n');
  },
  defaultConfig: {
    baseUrl: DEFAULT_BASE_URL,
    app_id: '',
    app_secret: '',
    user_access_token: '',
    authBaseUrl: DEFAULT_AUTH_BASE_URL,
    oauthScope: DEFAULT_OAUTH_SCOPE,
    autoAuthorizeUser: true,
    defaultSheetRange: DEFAULT_SHEET_RANGE,
    maxTextChars: DEFAULT_MAX_TEXT_CHARS,
    maxCells: DEFAULT_MAX_CELLS,
    maxCellChars: DEFAULT_MAX_CELL_CHARS,
    maxRanges: 10,
    valueRenderOption: 'ToString',
    dateTimeRenderOption: 'FormattedString',
    userIdType: 'open_id',
    departmentIdType: 'open_department_id',
  },
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'Feishu/Lark OpenAPI base URL. Defaults to https://open.feishu.cn.' },
      authBaseUrl: { type: 'string', description: 'Feishu/Lark OAuth authorization base URL. Defaults to https://accounts.feishu.cn.' },
      app_id: { type: 'string', description: 'Optional Feishu app_id. Prefer FEISHU_APP_ID environment variable for shared deployments.' },
      app_secret: { type: 'string', description: 'Optional Feishu app_secret. Prefer FEISHU_APP_SECRET environment variable for shared deployments.' },
      accessToken: { type: 'string', description: 'Optional direct tenant_access_token or user_access_token. Prefer FEISHU_ACCESS_TOKEN environment variable.' },
      user_access_token: { type: 'string', description: 'Optional user_access_token for get_current_user. Prefer FEISHU_USER_ACCESS_TOKEN environment variable.' },
      oauthScope: { type: 'string', description: 'OAuth scopes requested when auto-authorizing current user. Defaults to auth:user.id:read. Add user_profile only after enabling it in the Feishu app permissions.' },
      autoAuthorizeUser: { type: 'boolean', description: 'When get_current_user lacks a user_access_token, start Feishu Device Flow instead of failing.' },
      defaultSheetRange: { type: 'string', description: 'Default A1 range when reading a sheet without ranges.' },
      maxTextChars: { type: 'number', description: 'Maximum document text characters returned.' },
      maxCells: { type: 'number', description: 'Maximum spreadsheet cells returned.' },
      maxCellChars: { type: 'number', description: 'Maximum characters returned per spreadsheet cell.' },
      maxRanges: { type: 'number', description: 'Maximum spreadsheet ranges in one call.' },
      valueRenderOption: { type: 'string', description: 'Sheet value render option: ToString, FormattedValue, Formula, UnformattedValue.' },
      dateTimeRenderOption: { type: 'string', description: 'Sheet datetime render option: FormattedString or SerialNumber.' },
      userIdType: { type: 'string', description: 'User ID type for mentions: open_id, union_id, user_id, or lark_id.' },
      departmentIdType: { type: 'string', description: 'Department ID type for user lookup: open_department_id or department_id.' },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Environment-based credentials',
      config: {
        baseUrl: DEFAULT_BASE_URL,
        authBaseUrl: DEFAULT_AUTH_BASE_URL,
        app_id: 'cli_xxx',
        app_secret: 'xxx',
        user_access_token: 'u-xxx',
        oauthScope: DEFAULT_OAUTH_SCOPE,
        autoAuthorizeUser: true,
        defaultSheetRange: 'A1:Z100',
        maxTextChars: 50000,
        maxCells: 2000,
      },
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation to perform: read_doc, read_old_doc, read_sheet, get_sheet_meta, get_user, get_current_user, authorize_current_user, or complete_current_user_authorization.',
      },
      url: {
        type: 'string',
        description: 'Optional Feishu/Lark document or spreadsheet URL. Tokens will be extracted when possible.',
      },
      documentId: {
        type: 'string',
        description: 'New Docx document_id. Usually the token after /docx/ in the URL.',
      },
      docToken: {
        type: 'string',
        description: 'Legacy Doc token. Usually the token after /docs/ or /doc/ in the URL.',
      },
      spreadsheetToken: {
        type: 'string',
        description: 'Spreadsheet token. Usually the token after /sheets/ in the URL.',
      },
      sheetId: {
        type: 'string',
        description: 'Worksheet sheetId. Can also be included before ! in a range.',
      },
      range: {
        type: 'string',
        description: 'Single spreadsheet range, for example A1:D20 or sheetId!A1:D20.',
      },
      ranges: {
        type: 'array',
        description: 'Spreadsheet ranges, for example ["sheetId!A1:D20", "sheetId!F1:H10"].',
        items: { type: 'string' },
      },
      lang: {
        type: 'number',
        description: 'Docx mention language. 0 default/Chinese, 1 English, 2 Japanese where supported.',
      },
      valueRenderOption: {
        type: 'string',
        description: 'Spreadsheet value render option: ToString, FormattedValue, Formula, UnformattedValue.',
      },
      dateTimeRenderOption: {
        type: 'string',
        description: 'Spreadsheet datetime render option: FormattedString or SerialNumber.',
      },
      userIdType: {
        type: 'string',
        description: 'User ID type for mentions: open_id, union_id, user_id, or lark_id.',
      },
      userId: {
        type: 'string',
        description: 'Feishu user identifier for get_user. Interpreted according to userIdType.',
      },
      user_id: {
        type: 'string',
        description: 'Alias of userId for get_user.',
      },
      departmentIdType: {
        type: 'string',
        description: 'Department ID type for get_user: open_department_id or department_id.',
      },
      deviceCode: {
        type: 'string',
        description: 'Device Flow device_code returned by authorize_current_user. Required for complete_current_user_authorization.',
      },
      device_code: {
        type: 'string',
        description: 'Alias of deviceCode.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  validate(input) {
    if (!ACTIONS.has(input.action)) throw new Error(`action must be one of: ${[...ACTIONS].join(', ')}`);
    if (input.url !== undefined && input.url !== null && !maybeUrl(input.url)) throw new Error('url must be a valid URL');
    if (input.ranges !== undefined && !Array.isArray(input.ranges)) throw new Error('ranges must be an array');
    if (input.lang !== undefined && input.lang !== null && !Number.isInteger(Number(input.lang))) throw new Error('lang must be an integer');
    if (input.valueRenderOption && !VALUE_RENDER_OPTIONS.has(String(input.valueRenderOption))) throw new Error('invalid valueRenderOption');
    if (input.dateTimeRenderOption && !DATETIME_RENDER_OPTIONS.has(String(input.dateTimeRenderOption))) throw new Error('invalid dateTimeRenderOption');
    if (input.userIdType && !USER_ID_TYPES.has(String(input.userIdType))) throw new Error('invalid userIdType');
    if (input.departmentIdType && !DEPARTMENT_ID_TYPES.has(String(input.departmentIdType))) throw new Error('invalid departmentIdType');
  },

  async handler(input, ctx) {
    switch (input.action) {
      case 'read_doc':
        return readDoc(input, ctx);
      case 'read_old_doc':
        return readOldDoc(input, ctx);
      case 'read_sheet':
        return readSheet(input, ctx);
      case 'get_sheet_meta':
        return getSheetMeta(input, ctx);
      case 'get_user':
        return getUser(input, ctx);
      case 'get_current_user':
        return getCurrentUser(input, ctx);
      case 'authorize_current_user':
        return createUserAuthorizationRequest(ctx.config || {});
      case 'complete_current_user_authorization':
        return completeUserAuthorization(input, ctx);
      default:
        throw new Error(`Unsupported action: ${input.action}`);
    }
  },

  parseResult(output) {
    const label = output.resourceType === 'sheet'
      ? `feishu:${output.spreadsheetToken || 'sheet'}`
      : output.resourceType === 'user'
        ? `feishu:user:${output.userId || output.user?.user_id || ''}`
        : output.resourceType === 'authorization'
          ? 'feishu:authorization'
      : `feishu:${output.documentId || output.docToken || 'doc'}`;
    const content = output.content || JSON.stringify(output.resourceType === 'user'
      ? { user: output.user }
      : output.resourceType === 'authorization'
        ? {
          message: output.message,
          flow: output.flow,
          authorizationUrl: output.authorizationUrl,
          verificationUrl: output.verificationUrl,
          deviceCode: output.deviceCode,
          interval: output.interval,
          expiresAt: output.expiresAt,
        }
      : { properties: output.properties, sheets: output.sheets }, null, 2);
    return {
      renderType: 'file-snippet',
      data: {
        path: label,
        encoding: 'utf-8',
        size: Buffer.byteLength(content, 'utf-8'),
        startLine: 1,
        endLine: content.split(/\r?\n/).length,
        truncated: output.truncated === true,
        contentPreview: content.slice(0, 4000),
        content,
      },
    };
  },

  scrubRunRecord(record) {
    return record;
  },

  __test: {
    extractTokenFromUrl,
    trimValueRanges,
    formatSheetAsTsv,
    _resetTokenCache() {
      cachedTenantToken = null;
    },
  },
};
