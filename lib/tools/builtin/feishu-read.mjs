import {
  authorizeAndWait,
  completeDeviceAuthorization,
  configWithOAuthScopes,
  DEFAULT_FEISHU_BASE_URL,
  feishuBaseUrl,
  getUserAccessToken,
  loadFeishuAuthConfig,
  scopesForDomains,
  shouldStartUserAuthorization,
  startDeviceAuthorization,
} from '../../feishu-auth.mjs';

const DEFAULT_BASE_URL = DEFAULT_FEISHU_BASE_URL;
const DEFAULT_MAX_TEXT_CHARS = 50_000;
const DEFAULT_MAX_CELLS = 2_000;
const DEFAULT_MAX_CELL_CHARS = 1_000;
const DEFAULT_SHEET_RANGE = 'A1:Z100';

const ACTIONS = new Set([
  'read_doc',
  'read_old_doc',
  'read_wiki',
  'get_wiki_node',
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
  if (kind === 'wiki') return { wikiToken: out.wikiToken, documentId: out.documentId || out.docToken, docToken: out.docToken || out.documentId, spreadsheetToken: out.spreadsheetToken };
  if (kind === 'sheet') return { spreadsheetToken: out.spreadsheetToken, sheetId: out.sheetId };
  return out;
}

function isWikiUrl(value) {
  return Boolean(extractTokenFromUrl(value, 'wiki').wikiToken);
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
    const err = new Error(`Feishu API error ${payload.code}: ${payload.msg || payload.message || 'unknown error'}`);
    err.code = payload.code;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function feishuUserApiRequest(config, path, options = {}) {
  const {
    signal,
    emit,
    action: authAction = 'read_resource',
    authDomains = [],
    authScopes = [],
    ...requestOptions
  } = options;
  const authConfig = await loadFeishuAuthConfig(config || {}, { authOverridesConfig: true });
  const scopedConfig = configWithOAuthScopes(authConfig, scopesForDomains(authDomains), authScopes);

  async function tryGetToken(conf) {
    try {
      return getUserAccessToken(conf);
    } catch (err) {
      if (configuredBoolean(conf, 'autoAuthorizeUser', true) && shouldStartUserAuthorization(err)) {
        const { tokenData } = await authorizeAndWait(conf, { signal, emit, action: authAction });
        return tokenData.accessToken;
      }
      throw err;
    }
  }

  const accessToken = await tryGetToken(scopedConfig);

  try {
    return await requestJson(feishuBaseUrl(scopedConfig), path, { ...requestOptions, signal, accessToken });
  } catch (err) {
    if (configuredBoolean(scopedConfig, 'autoAuthorizeUser', true) && shouldStartUserAuthorization(err)) {
      const { tokenData } = await authorizeAndWait(scopedConfig, { signal, emit, action: authAction });
      return await requestJson(feishuBaseUrl(scopedConfig), path, { ...requestOptions, signal, accessToken: tokenData.accessToken });
    }
    throw err;
  }
}

async function readDoc(input, { config, signal, emit }) {
  if (isWikiUrl(input.url)) return readWiki(input, { config, signal, emit });
  const fromUrl = extractTokenFromUrl(input.url, 'doc');
  const documentId = requiredToken(input.documentId || fromUrl.documentId, 'documentId');
  const lang = input.lang === undefined || input.lang === null ? 0 : Number(input.lang);
  const payload = await feishuUserApiRequest(config, `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, {
    query: { lang },
    signal,
    emit,
    action: 'read_doc',
    authDomains: ['docs'],
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

async function readOldDoc(input, { config, signal, emit }) {
  if (isWikiUrl(input.url)) return readWiki(input, { config, signal, emit });
  const fromUrl = extractTokenFromUrl(input.url, 'old_doc');
  const docToken = requiredToken(input.docToken || fromUrl.docToken, 'docToken');
  const payload = await feishuUserApiRequest(config, `/open-apis/doc/v2/${encodeURIComponent(docToken)}/raw_content`, {
    signal,
    emit,
    action: 'read_old_doc',
    authDomains: ['docs'],
  });
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

async function getWikiNode(input, { config, signal, emit }) {
  const fromUrl = extractTokenFromUrl(input.url, 'wiki');
  const token = requiredToken(input.wikiToken || input.nodeToken || input.token || fromUrl.wikiToken || fromUrl.documentId || fromUrl.docToken || fromUrl.spreadsheetToken, 'wikiToken');
  const objType = input.objType || input.obj_type;
  const payload = await feishuUserApiRequest(config, '/open-apis/wiki/v2/spaces/get_node', {
    query: {
      token,
      ...(objType ? { obj_type: objType } : {}),
    },
    signal,
    emit,
    action: 'get_wiki_node',
    authDomains: ['wiki'],
  });
  const node = payload.data?.node || payload.data || {};
  return {
    action: 'get_wiki_node',
    resourceType: 'wiki',
    wikiToken: token,
    node,
  };
}

async function readWiki(input, ctx) {
  const wiki = await getWikiNode(input, ctx);
  const node = wiki.node || {};
  const objType = String(node.obj_type || '').toLowerCase();
  const objToken = node.obj_token;
  if (!objToken) throw new Error('Wiki node response did not include obj_token');

  if (objType === 'docx') {
    const doc = await readDoc({ ...input, documentId: objToken, url: undefined }, ctx);
    return {
      ...doc,
      action: 'read_wiki',
      resourceType: 'wiki',
      wikiToken: wiki.wikiToken,
      node,
      objType,
      objToken,
    };
  }
  if (objType === 'doc') {
    const doc = await readOldDoc({ ...input, docToken: objToken, url: undefined }, ctx);
    return {
      ...doc,
      action: 'read_wiki',
      resourceType: 'wiki',
      wikiToken: wiki.wikiToken,
      node,
      objType,
      objToken,
    };
  }
  if (objType === 'sheet') {
    const sheet = await readSheet({ ...input, spreadsheetToken: objToken, url: undefined }, ctx);
    return {
      ...sheet,
      action: 'read_wiki',
      resourceType: 'wiki',
      wikiToken: wiki.wikiToken,
      node,
      objType,
      objToken,
    };
  }

  throw new Error(`Unsupported wiki obj_type: ${objType || '(empty)'}`);
}

async function getSheetMeta(input, { config, signal, emit }) {
  const fromUrl = extractTokenFromUrl(input.url, 'sheet');
  const spreadsheetToken = requiredToken(input.spreadsheetToken || fromUrl.spreadsheetToken, 'spreadsheetToken');
  const payload = await feishuUserApiRequest(config, `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/metainfo`, {
    query: {
      user_id_type: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
    },
    signal,
    emit,
    action: 'get_sheet_meta',
    authDomains: ['sheets'],
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

async function getUser(input, { config, signal, emit }) {
  const userId = requiredToken(input.userId || input.user_id, 'userId');
  const payload = await feishuUserApiRequest(config, `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`, {
    query: {
      user_id_type: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
      department_id_type: input.departmentIdType || configuredString(config, 'departmentIdType', 'open_department_id'),
    },
    signal,
    emit,
    action: 'get_user',
    authDomains: ['contact'],
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
  const payload = await feishuUserApiRequest(config, '/open-apis/authen/v1/user_info', {
    signal,
    emit,
    action: 'get_current_user',
  });
  return {
    action: 'get_current_user',
    resourceType: 'user',
    userId: payload.data?.user_id || payload.data?.open_id || payload.data?.union_id || '',
    userIdType: payload.data?.user_id ? 'user_id' : payload.data?.open_id ? 'open_id' : payload.data?.union_id ? 'union_id' : '',
    user: payload.data || {},
  };
}

async function readSheet(input, { config, signal, emit }) {
  if (isWikiUrl(input.url)) return readWiki(input, { config, signal, emit });
  const fromUrl = extractTokenFromUrl(input.url, 'sheet');
  const spreadsheetToken = requiredToken(input.spreadsheetToken || fromUrl.spreadsheetToken, 'spreadsheetToken');
  let meta = null;
  if (!input.ranges?.length && !input.range && !(input.sheetId || fromUrl.sheetId)) {
    meta = await getSheetMeta({ ...input, spreadsheetToken }, { config, signal, emit });
  }
  const ranges = normalizeRanges({ ...input, spreadsheetToken, sheetId: input.sheetId || fromUrl.sheetId }, meta, config);
  const maxRanges = configuredInteger(config, 'maxRanges', 10, 1, 50);
  if (ranges.length > maxRanges) throw new Error(`ranges exceeds maxRanges (${maxRanges})`);

  const payload = await feishuUserApiRequest(config, `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_batch_get`, {
    query: {
      ranges,
      valueRenderOption: input.valueRenderOption || configuredString(config, 'valueRenderOption', 'ToString'),
      dateTimeRenderOption: input.dateTimeRenderOption || configuredString(config, 'dateTimeRenderOption', 'FormattedString'),
      user_id_type: input.userIdType || configuredString(config, 'userIdType', 'open_id'),
    },
    signal,
    emit,
    action: 'read_sheet',
    authDomains: ['sheets'],
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
    'Read Feishu/Lark cloud documents, spreadsheets, and user profile data using Feishu OpenAPI with user authorization. Supports new Docx raw text, legacy Doc raw text, spreadsheet metadata/range values, contact user lookup, and current authorized user lookup.',
    '',
    'All actions use user_access_token authorization. If no valid token is configured, the tool automatically starts a Device Flow authorization popup and waits for the user to approve.',
    '',
    'Usage notes:',
    '- For Docx URLs use action="read_doc"; for legacy docs use action="read_old_doc".',
    '- For Wiki URLs like /wiki/<token>, use action="read_wiki". Wiki node tokens must be resolved to obj_token before reading content.',
    '- For spreadsheets use action="read_sheet" with ranges like ["sheetId!A1:D20"]. If no range is provided, the tool reads the first sheet using the configured default range.',
    '- For users use action="get_user" with userId. userIdType controls whether the ID is open_id, union_id, user_id, or lark_id.',
    '- To read the current authorized user, use action="get_current_user" with no userId.',
    '- All actions trigger the Feishu Device Flow automatically when user_access_token is missing or invalid.',
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
      '- All feishu_read actions use user_access_token. If user_access_token is missing, invalid, or expired, the tool starts the Feishu Device Flow automatically and waits. Do not call ask_user for Feishu authorization and do not manually print verification steps unless the tool itself fails.',
      '- For a URL containing /wiki/, call feishu_read once with action="read_wiki" and the full url. Do not try read_doc, read_old_doc, get_wiki_node, or alternate token parameter names first.',
      '- If a feishu_read call fails with an authorization error, do not retry the same URL with different parameters. Use the built-in authorization flow and wait for that tool result.',
      '- When the user explicitly asks to authorize, login, reconnect, or refresh Feishu access, call feishu_auth with action="login" instead of feishu_read.',
      '- If a Feishu authorization UI block appears, wait for the tool result. The tool continues automatically after the user approves access.',
      '- Use action="get_user" only when the user explicitly provides an ID or asks about a specific other user.',
      '- For Feishu wiki URLs, call action="read_wiki" instead of read_doc/read_old_doc/read_sheet.',
    ].join('\n');
  },
  defaultConfig: {
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
      autoAuthorizeUser: { type: 'boolean', description: 'When user_access_token is missing or invalid, start Feishu Device Flow instead of failing.' },
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
      title: 'Read limits',
      config: {
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
        description: 'Operation to perform: read_doc, read_old_doc, read_wiki, get_wiki_node, read_sheet, get_sheet_meta, get_user, get_current_user, authorize_current_user, or complete_current_user_authorization.',
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
      wikiToken: {
        type: 'string',
        description: 'Wiki node token. Usually the token after /wiki/ in the URL.',
      },
      nodeToken: {
        type: 'string',
        description: 'Alias of wikiToken.',
      },
      token: {
        type: 'string',
        description: 'Generic token for get_wiki_node/read_wiki.',
      },
      objType: {
        type: 'string',
        description: 'Optional object type when resolving wiki node from an actual cloud document token.',
      },
      obj_type: {
        type: 'string',
        description: 'Alias of objType.',
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
      case 'read_wiki':
        return readWiki(input, ctx);
      case 'get_wiki_node':
        return getWikiNode(input, ctx);
      case 'read_sheet':
        return readSheet(input, ctx);
      case 'get_sheet_meta':
        return getSheetMeta(input, ctx);
      case 'get_user':
        return getUser(input, ctx);
      case 'get_current_user':
        return getCurrentUser(input, ctx);
      case 'authorize_current_user':
        return startDeviceAuthorization(await loadFeishuAuthConfig(ctx.config || {}, { authOverridesConfig: true }));
      case 'complete_current_user_authorization':
        return completeDeviceAuthorization(input, {
          config: await loadFeishuAuthConfig(ctx.config || {}, { authOverridesConfig: true }),
          signal: ctx.signal,
        });
      default:
        throw new Error(`Unsupported action: ${input.action}`);
    }
  },

  parseResult(output) {
    const label = output.resourceType === 'sheet'
      ? `feishu:${output.spreadsheetToken || 'sheet'}`
      : output.resourceType === 'wiki'
        ? `feishu:wiki:${output.node?.title || output.wikiToken || output.objToken || ''}`
      : output.resourceType === 'user'
        ? `feishu:user:${output.userId || output.user?.user_id || ''}`
        : output.resourceType === 'authorization'
          ? 'feishu:authorization'
      : `feishu:${output.documentId || output.docToken || 'doc'}`;
    const content = output.content || JSON.stringify(output.resourceType === 'user'
      ? { user: output.user }
      : output.resourceType === 'wiki'
        ? { node: output.node }
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
  },
};
