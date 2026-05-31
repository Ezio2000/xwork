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
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_BASE_URL = DEFAULT_FEISHU_BASE_URL;
const DEFAULT_MAX_TEXT_CHARS = 50_000;
const DEFAULT_MAX_CELLS = 2_000;
const DEFAULT_MAX_CELL_CHARS = 1_000;
const DEFAULT_SHEET_RANGE = 'A1:Z100';
const DEFAULT_SHEET_MODE = 'all_preview';
const DEFAULT_BLOCK_PAGE_SIZE = 100;
const DEFAULT_MAX_BLOCKS = 2_000;
const DEFAULT_MAX_MODEL_TEXT_CHARS = 12_000;
const DEFAULT_MAX_BLOCK_PREVIEW = 80;
const DEFAULT_MAX_ASSETS = 200;
const DEFAULT_MAX_MEDIA_BYTES = 5_000_000;
const FEISHU_MEDIA_DIR = resolve(process.cwd(), 'data', 'feishu-media');
const MEDIA_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

const ACTIONS = new Set([
  'read_doc',
  'list_doc_media',
  'get_doc_blocks',
  'read_doc_rich',
  'download_media',
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
const SHEET_MODES = new Set(['first', 'all_preview']);
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

function inputInteger(input, config, key, fallback, min, max) {
  const inputValue = plainObject(input)[key];
  const value = inputValue === undefined || inputValue === null || inputValue === ''
    ? plainObject(config)[key]
    : inputValue;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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

function markdownCell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ');
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim();
}

function columnLabel(index) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return label;
}

function sheetIdFromRange(range) {
  const text = String(range || '');
  const bang = text.indexOf('!');
  return bang === -1 ? '' : text.slice(0, bang);
}

function sheetLabelForRange(range, sheetsById) {
  const sheetId = sheetIdFromRange(range);
  const title = sheetsById?.get(sheetId)?.title;
  if (title && sheetId) return `${title} (${range})`;
  return range || title || 'range';
}

function formatRowsAsMarkdownTable(values) {
  if (!values.length) return '(empty)';
  const width = Math.max(...values.map(row => Array.isArray(row) ? row.length : 0), 1);
  const normalizedRows = values.map(row => {
    const cells = Array.isArray(row) ? row : [];
    return Array.from({ length: width }, (_, index) => markdownCell(cells[index]));
  });
  const [firstRow, ...bodyRows] = normalizedRows;
  const header = firstRow.map((cell, index) => cell || columnLabel(index));
  const divider = Array.from({ length: width }, () => '---');
  const body = bodyRows.length ? bodyRows : [Array.from({ length: width }, () => '')];
  return [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function sheetDescriptor(sheet) {
  if (!sheet || typeof sheet !== 'object') return null;
  const sheetId = String(sheet.sheetId || sheet.sheet_id || sheet.id || '').trim();
  if (!sheetId) return null;
  return {
    ...sheet,
    sheetId,
    title: String(sheet.title || sheet.name || sheet.sheetName || sheet.sheet_name || sheetId).trim(),
  };
}

function sheetsById(sheets = []) {
  return new Map((sheets || [])
    .map(sheetDescriptor)
    .filter(Boolean)
    .map(sheet => [sheet.sheetId, sheet]));
}

function formatSheetAsMarkdown(valueRanges, { sheets = [] } = {}) {
  const byId = sheetsById(sheets);
  const sections = [];
  for (const range of valueRanges) {
    const values = Array.isArray(range.values) ? range.values : [];
    sections.push(`## ${sheetLabelForRange(range.range, byId)}\n\n${formatRowsAsMarkdownTable(values)}`);
  }
  return sections.join('\n\n');
}

function blockId(block) {
  return String(block?.block_id || block?.blockId || block?.id || '').trim();
}

function blockParentId(block) {
  return String(block?.parent_id || block?.parentId || '').trim();
}

function blockChildrenIds(block) {
  const children = block?.children || block?.children_ids || block?.childrenIds || block?.child_ids || block?.childIds;
  return Array.isArray(children) ? children.map(item => String(item).trim()).filter(Boolean) : [];
}

function buildBlockTree(blocks) {
  const nodes = [];
  const byId = new Map();
  const originalChildrenById = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = blockId(block);
    if (id) originalChildrenById.set(id, blockChildrenIds(block));
    const node = { ...block, children: [] };
    nodes.push(node);
    if (id) byId.set(id, node);
  }

  const roots = [];
  const attached = new Set();
  for (const node of nodes) {
    const parentId = blockParentId(node);
    const parent = parentId ? byId.get(parentId) : null;
    if (parent) {
      parent.children.push(node);
      attached.add(node);
    }
  }

  for (const parent of nodes) {
    for (const childId of originalChildrenById.get(blockId(parent)) || []) {
      const child = byId.get(childId);
      if (child && child !== parent && !attached.has(child)) {
        parent.children.push(child);
        attached.add(child);
      }
    }
  }

  for (const node of nodes) {
    if (!attached.has(node)) roots.push(node);
  }

  return { roots, byId };
}

function collectMediaTokens(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectMediaTokens(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const token = value.token || value.file_token || value.fileToken;
  if (typeof token === 'string' && token.trim()) {
    out.push({
      token: token.trim(),
      name: value.name || value.file_name || value.fileName || value.title || '',
      mimeType: value.mime_type || value.mimeType || '',
      size: value.size || value.file_size || value.fileSize,
      width: value.width,
      height: value.height,
    });
  }

  for (const child of Object.values(value)) collectMediaTokens(child, out);
  return out;
}

function mediaAssetsFromBlocks(blocks) {
  const seen = new Set();
  const assets = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const tokens = collectMediaTokens(block);
    for (const item of tokens) {
      if (seen.has(item.token)) continue;
      seen.add(item.token);
      assets.push({
        ...item,
        blockId: blockId(block),
        blockType: block.block_type ?? block.blockType ?? block.type ?? '',
      });
    }
  }
  return assets;
}

function textFromElement(element) {
  if (!element || typeof element !== 'object') return '';
  if (typeof element.text_run?.content === 'string') return element.text_run.content;
  if (typeof element.mention_user?.user_name === 'string') return `@${element.mention_user.user_name}`;
  if (typeof element.mention_doc?.title === 'string') return element.mention_doc.title;
  if (typeof element.equation?.content === 'string') return element.equation.content;
  if (typeof element.reminder?.create_user_name === 'string') return element.reminder.create_user_name;
  return '';
}

function textFromBlock(block) {
  if (!block || typeof block !== 'object') return '';
  for (const value of Object.values(block)) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.elements)) return value.elements.map(textFromElement).join('');
  }
  return '';
}

function blockToMarkdownLine(block) {
  const text = textFromBlock(block).trim();
  if (!text) {
    const assets = mediaAssetsFromBlocks([block]);
    if (!assets.length) return '';
    return assets.map(asset => `![${asset.name || asset.token}](feishu-media:${asset.token})`).join('\n');
  }

  const type = Number(block.block_type ?? block.blockType);
  if (type >= 3 && type <= 11) return `${'#'.repeat(Math.min(6, type - 2))} ${text}`;
  if (type === 12) return `- ${text}`;
  if (type === 13) return `1. ${text}`;
  if (type === 14) return `- [ ] ${text}`;
  return text;
}

function formatBlocksAsMarkdown(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(blockToMarkdownLine)
    .filter(Boolean)
    .join('\n\n');
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => (
    value !== undefined
    && value !== null
    && value !== ''
    && !(Array.isArray(value) && value.length === 0)
  )));
}

function compactAsset(asset) {
  return compactObject({
    token: asset.token,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    blockId: asset.blockId,
    blockType: asset.blockType,
  });
}

function compactBlock(block) {
  const assets = mediaAssetsFromBlocks([block]).map(compactAsset);
  return compactObject({
    blockId: blockId(block),
    blockType: block?.block_type ?? block?.blockType ?? block?.type,
    parentId: blockParentId(block),
    text: clampText(textFromBlock(block).trim(), 500).text,
    childCount: blockChildrenIds(block).length || undefined,
    assets,
  });
}

function compactBlockPreview(blocks, maxBlocks = DEFAULT_MAX_BLOCK_PREVIEW) {
  return (Array.isArray(blocks) ? blocks : [])
    .slice(0, maxBlocks)
    .map(compactBlock)
    .filter(item => Object.keys(item).length);
}

function compactContent(text, config) {
  const maxChars = configuredInteger(config, 'maxModelTextChars', DEFAULT_MAX_MODEL_TEXT_CHARS, 1000, 50_000);
  return clampText(text, maxChars);
}

function compactDocResult(result, { config, content = '', includeBlockPreview = false } = {}) {
  const allAssets = mediaAssetsFromBlocks(result.blocks);
  const assets = allAssets.slice(0, DEFAULT_MAX_ASSETS).map(compactAsset);
  const contentResult = content ? compactContent(content, config) : { text: '', truncated: false };
  return compactObject({
    action: result.action,
    resourceType: result.resourceType,
    documentId: result.documentId,
    url: result.url,
    wikiToken: result.wikiToken,
    node: result.node,
    objType: result.objType,
    objToken: result.objToken,
    blockCount: result.blockCount,
    assetCount: allAssets.length,
    assets,
    omittedAssets: Math.max(0, allAssets.length - DEFAULT_MAX_ASSETS),
    hasMore: result.hasMore,
    nextPageToken: result.nextPageToken,
    truncated: result.truncated || contentResult.truncated,
    content: contentResult.text || undefined,
    contentLength: content ? content.length : undefined,
    blockPreview: includeBlockPreview ? compactBlockPreview(result.blocks) : undefined,
    omitted: 'Full Feishu blocks/tree are omitted to keep model context and conversation storage small. Use list_doc_media for media tokens or read_doc for plain text.',
  });
}

function modelVisibleFeishuOutput(output, input, { config } = {}) {
  if (!output || typeof output !== 'object') return output;
  if (output.resourceType === 'media') {
    return compactObject({
      action: output.action,
      resourceType: output.resourceType,
      fileToken: output.fileToken,
      mediaToken: output.mediaToken,
      contentType: output.contentType,
      contentDisposition: output.contentDisposition,
      sizeBytes: output.size,
      encoding: output.encoding,
      filename: output.filename,
      previewUrl: output.previewUrl || output.url,
      displayedInUi: true,
      note: 'Media was saved as a local tool asset and rendered in the UI. Binary bytes are not included in model context.',
      nextStep: 'Do not call browser_action, shell_command, write_file, or read_file to display this media again; summarize briefly to the user.',
    });
  }
  if (
    (output.resourceType === 'docx' || output.resourceType === 'wiki')
    && (output.blocks || output.tree)
    && ['get_doc_blocks', 'read_doc_rich', 'list_doc_media'].includes(input?.action || output.action)
  ) {
    return compactDocResult(output, {
      config,
      content: output.content || '',
      includeBlockPreview: output.action === 'get_doc_blocks',
    });
  }
  return output;
}

function mediaExtension(contentType, contentDisposition = '', fileToken = '') {
  const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (MEDIA_EXTENSIONS[normalizedType]) return MEDIA_EXTENSIONS[normalizedType];
  const filename = String(contentDisposition || '').match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] || '';
  const fromHeader = extname(decodeURIComponent(filename).replace(/["']/g, '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromHeader)) return fromHeader;
  const fromToken = extname(fileToken).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromToken)) return fromToken;
  return '.bin';
}

function mediaFilename(fileToken, buffer, contentType, contentDisposition) {
  const safeToken = String(fileToken || 'media').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'media';
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `${safeToken}-${hash}${mediaExtension(contentType, contentDisposition, safeToken)}`;
}

function mediaUrlFromFilename(filename) {
  return `/api/v1/tool-assets/feishu-media/${encodeURIComponent(filename)}`;
}

function normalizeSheetMode(input, config) {
  const mode = String(input.sheetMode || configuredString(config, 'defaultSheetMode', DEFAULT_SHEET_MODE)).trim();
  return SHEET_MODES.has(mode) ? mode : DEFAULT_SHEET_MODE;
}

function normalizeRanges(input, meta, config, { maxRanges }) {
  const ranges = Array.isArray(input.ranges)
    ? input.ranges.map(item => String(item).trim()).filter(Boolean)
    : [];
  if (typeof input.range === 'string' && input.range.trim()) ranges.push(input.range.trim());
  if (ranges.length) {
    const normalizedRanges = ranges.map(range => {
      if (range.includes('!')) return range;
      const sheetId = input.sheetId || extractTokenFromUrl(input.url, 'sheet').sheetId;
      return sheetId ? `${sheetId}!${range}` : range;
    });
    if (ranges.length > maxRanges) throw new Error(`ranges exceeds maxRanges (${maxRanges})`);
    return {
      ranges: normalizedRanges,
      sheetMode: 'explicit',
      sheetCount: Array.isArray(meta?.sheets) ? meta.sheets.length : null,
      selectedSheets: [],
      omittedSheets: 0,
    };
  }

  const sheetId = input.sheetId || extractTokenFromUrl(input.url, 'sheet').sheetId || meta?.sheets?.[0]?.sheetId;
  const defaultRange = configuredString(config, 'defaultSheetRange', DEFAULT_SHEET_RANGE);
  const metaSheets = Array.isArray(meta?.sheets) ? meta.sheets.map(sheetDescriptor).filter(Boolean) : [];
  if (input.sheetId || extractTokenFromUrl(input.url, 'sheet').sheetId) {
    return {
      ranges: [`${sheetId}!${defaultRange}`],
      sheetMode: 'sheet_preview',
      sheetCount: metaSheets.length || null,
      selectedSheets: metaSheets.filter(sheet => sheet.sheetId === sheetId),
      omittedSheets: 0,
    };
  }
  if (!metaSheets.length) throw new Error('sheetId or ranges is required when the spreadsheet has no readable sheet metadata');

  const sheetMode = normalizeSheetMode(input, config);
  const selectedSheets = sheetMode === 'all_preview'
    ? metaSheets.slice(0, maxRanges)
    : metaSheets.slice(0, 1);
  return {
    ranges: selectedSheets.map(sheet => `${sheet.sheetId}!${defaultRange}`),
    sheetMode,
    sheetCount: metaSheets.length,
    selectedSheets,
    omittedSheets: Math.max(0, metaSheets.length - selectedSheets.length),
  };
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
    const err = new Error(`Feishu HTTP ${response.status}: ${payload.msg || payload.message || response.statusText}`);
    err.code = payload.error || payload.code || response.status;
    err.payload = payload;
    throw err;
  }
  if (payload.code !== undefined && payload.code !== 0) {
    const err = new Error(`Feishu API error ${payload.code}: ${payload.msg || payload.message || 'unknown error'}`);
    err.code = payload.code;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function readErrorPayload(response) {
  const text = await response.text();
  if (!text) return { message: response.statusText || 'request failed' };
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function responseHeaderObject(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const key of ['content-type', 'content-length', 'content-disposition', 'content-range']) {
    const value = typeof headers.get === 'function' ? headers.get(key) : headers[key];
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

async function requestBinary(baseUrl, path, { query, accessToken, signal, headers = {} } = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: 'GET',
    signal,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    const err = new Error(`Feishu HTTP ${response.status}: ${payload.msg || payload.message || response.statusText}`);
    err.code = payload.error || payload.code || response.status;
    err.payload = payload;
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    status: response.status,
    headers: responseHeaderObject(response.headers),
    buffer: Buffer.from(arrayBuffer),
  };
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

async function feishuUserBinaryRequest(config, path, options = {}) {
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
    return await requestBinary(feishuBaseUrl(scopedConfig), path, { ...requestOptions, signal, accessToken });
  } catch (err) {
    if (configuredBoolean(scopedConfig, 'autoAuthorizeUser', true) && shouldStartUserAuthorization(err)) {
      const { tokenData } = await authorizeAndWait(scopedConfig, { signal, emit, action: authAction });
      return await requestBinary(feishuBaseUrl(scopedConfig), path, { ...requestOptions, signal, accessToken: tokenData.accessToken });
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

async function getDocBlocksRaw(input, { config, signal, emit }) {
  if (isWikiUrl(input.url)) {
    const wiki = await getWikiNode(input, { config, signal, emit, extraAuthDomains: ['docs'] });
    if (String(wiki.node?.obj_type || '').toLowerCase() !== 'docx') {
      throw new Error(`Wiki obj_type must be docx for get_doc_blocks, got ${wiki.node?.obj_type || '(empty)'}`);
    }
    const result = await getDocBlocksRaw({ ...input, documentId: wiki.node.obj_token, url: undefined }, { config, signal, emit });
    return {
      ...result,
      resourceType: 'wiki',
      wikiToken: wiki.wikiToken,
      node: wiki.node,
      objType: 'docx',
      objToken: wiki.node.obj_token,
    };
  }

  const fromUrl = extractTokenFromUrl(input.url, 'doc');
  const documentId = requiredToken(input.documentId || fromUrl.documentId, 'documentId');
  const pageSize = inputInteger(input, config, 'pageSize', DEFAULT_BLOCK_PAGE_SIZE, 1, 500);
  const maxBlocks = inputInteger(input, config, 'maxBlocks', DEFAULT_MAX_BLOCKS, 1, 20_000);
  let pageToken = input.pageToken || input.page_token || '';
  const blocks = [];
  let hasMore = false;
  let nextPageToken = '';

  do {
    const payload = await feishuUserApiRequest(config, `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`, {
      query: {
        page_size: Math.min(pageSize, maxBlocks - blocks.length),
        ...(pageToken ? { page_token: pageToken } : {}),
        ...(input.documentRevisionId || input.document_revision_id ? { document_revision_id: input.documentRevisionId || input.document_revision_id } : {}),
        ...(input.userIdType || configuredString(config, 'userIdType', '') ? { user_id_type: input.userIdType || configuredString(config, 'userIdType', '') } : {}),
      },
      signal,
      emit,
      action: 'get_doc_blocks',
      authDomains: ['docs'],
    });
    const data = payload.data || {};
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.blocks) ? data.blocks : [];
    blocks.push(...items);
    hasMore = Boolean(data.has_more || data.hasMore);
    nextPageToken = data.page_token || data.next_page_token || data.pageToken || '';
    pageToken = nextPageToken;
  } while (hasMore && pageToken && blocks.length < maxBlocks);

  const assets = mediaAssetsFromBlocks(blocks);
  const tree = input.includeTree === false ? null : buildBlockTree(blocks).roots;
  return {
    action: 'get_doc_blocks',
    resourceType: 'docx',
    documentId,
    url: input.url || null,
    blockCount: blocks.length,
    blocks,
    tree,
    assets,
    hasMore,
    nextPageToken,
    truncated: hasMore && Boolean(nextPageToken),
  };
}

async function getDocBlocks(input, ctx) {
  const result = await getDocBlocksRaw(input, ctx);
  return compactDocResult(result, {
    config: ctx.config,
    includeBlockPreview: true,
  });
}

async function listDocMedia(input, ctx) {
  const result = await getDocBlocksRaw(input, ctx);
  const assets = mediaAssetsFromBlocks(result.blocks).map(compactAsset);
  return compactObject({
    action: 'list_doc_media',
    resourceType: result.resourceType,
    documentId: result.documentId,
    url: result.url,
    wikiToken: result.wikiToken,
    node: result.node,
    objType: result.objType,
    objToken: result.objToken,
    blockCount: result.blockCount,
    assetCount: assets.length,
    assets: assets.slice(0, DEFAULT_MAX_ASSETS),
    omittedAssets: Math.max(0, assets.length - DEFAULT_MAX_ASSETS),
    hasMore: result.hasMore,
    nextPageToken: result.nextPageToken,
    truncated: result.truncated || assets.length > DEFAULT_MAX_ASSETS,
    omitted: 'Only Feishu media metadata is returned. Full blocks/tree are intentionally omitted.',
  });
}

async function readDocRich(input, ctx) {
  const result = await getDocBlocksRaw(input, ctx);
  const markdown = formatBlocksAsMarkdown(result.blocks);
  return compactDocResult({
    ...result,
    action: 'read_doc_rich',
  }, {
    config: ctx.config,
    content: markdown,
  });
}

async function downloadMedia(input, { config, signal, emit }) {
  const fileToken = requiredToken(input.fileToken || input.file_token || input.mediaToken || input.media_token || input.token, 'fileToken');
  const maxBytes = inputInteger(input, config, 'maxMediaBytes', DEFAULT_MAX_MEDIA_BYTES, 1, 50_000_000);
  const response = await feishuUserBinaryRequest(config, `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
    signal,
    emit,
    action: 'download_media',
    authDomains: ['docs', 'media'],
  });
  if (response.buffer.length > maxBytes) {
    throw new Error(`Feishu media is ${response.buffer.length} bytes, exceeds maxMediaBytes (${maxBytes})`);
  }
  const contentType = response.headers['content-type'] || '';
  const contentDisposition = response.headers['content-disposition'] || '';
  const filename = mediaFilename(fileToken, response.buffer, contentType, contentDisposition);
  const filePath = resolve(FEISHU_MEDIA_DIR, filename);
  await mkdir(FEISHU_MEDIA_DIR, { recursive: true });
  await writeFile(filePath, response.buffer);
  return {
    action: 'download_media',
    resourceType: 'media',
    fileToken,
    mediaToken: fileToken,
    contentType,
    contentDisposition,
    size: response.buffer.length,
    encoding: 'binary-file',
    filename,
    filePath,
    url: mediaUrlFromFilename(filename),
    previewUrl: mediaUrlFromFilename(filename),
    headers: response.headers,
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

async function getWikiNode(input, { config, signal, emit, extraAuthDomains = [] }) {
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
    authDomains: ['wiki', ...extraAuthDomains],
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
  const wiki = await getWikiNode(input, { ...ctx, extraAuthDomains: ['docs', 'sheets'] });
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
  const maxRanges = configuredInteger(config, 'maxRanges', 10, 1, 50);
  const rangeSelection = normalizeRanges(
    { ...input, spreadsheetToken, sheetId: input.sheetId || fromUrl.sheetId },
    meta,
    config,
    { maxRanges },
  );

  const payload = await feishuUserApiRequest(config, `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values_batch_get`, {
    query: {
      ranges: rangeSelection.ranges,
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
  const markdown = formatSheetAsMarkdown(trimmed.valueRanges, { sheets: meta?.sheets || [] });
  return {
    action: 'read_sheet',
    resourceType: 'sheet',
    spreadsheetToken,
    url: input.url || null,
    revision: data.revision,
    totalCells: data.totalCells,
    returnedCells: trimmed.usedCells,
    ranges: rangeSelection.ranges,
    sheetMode: rangeSelection.sheetMode,
    sheetCount: rangeSelection.sheetCount,
    selectedSheets: rangeSelection.selectedSheets,
    omittedSheets: rangeSelection.omittedSheets,
    valueRanges: trimmed.valueRanges,
    content: markdown,
    truncated: trimmed.truncated,
    ...(meta ? { properties: meta.properties, sheets: meta.sheets } : {}),
  };
}

export const tool = {
  id: 'feishu_read',
  name: 'feishu_read',
  title: 'Feishu Read',
  description: [
    'Read Feishu/Lark cloud documents, spreadsheets, media assets, and user profile data using Feishu OpenAPI with user authorization. Supports new Docx raw text/media discovery/compact block previews/rich content previews, legacy Doc raw text, spreadsheet metadata/range values, media downloads, contact user lookup, and current authorized user lookup.',
    '',
    'All actions use user_access_token authorization. If no valid token is configured, the tool automatically starts a Device Flow authorization popup and waits for the user to approve.',
    '',
    'Usage notes:',
    '- For Docx URLs use action="read_doc"; for legacy docs use action="read_old_doc".',
    '- For document images or attachments, use action="list_doc_media" first, then action="download_media" with the returned token.',
    '- For Docx block structure use action="get_doc_blocks"; it returns a compact blockPreview only, never full raw blocks/tree.',
    '- For structured rich content with media references use action="read_doc_rich"; it returns compact Markdown and media metadata, never full raw blocks/tree.',
    '- For images or attachments from Docx blocks use action="download_media" with the block media token/file_token. It saves the binary asset locally, renders it in the UI, and returns small metadata only, not base64 content.',
    '- After download_media succeeds for an image, the image is already shown to the user by the UI. Do not call browser_action, shell_command, write_file, read_file, or create HTML just to display it again.',
    '- Required OAuth scopes are added automatically by resource domain: Docx block/rich reads use docx:document:readonly and space:document:retrieve; media downloads also use docs:document.media:download.',
    '- For Wiki URLs like /wiki/<token>, use action="read_wiki". Wiki node tokens must be resolved to obj_token before reading content.',
    '- For spreadsheets use action="read_sheet" with ranges like ["sheetId!A1:D20"]. If no range is provided, the tool reads spreadsheet metadata and returns Markdown previews for sheets using the configured default range.',
    '- For users use action="get_user" with userId. userIdType controls whether the ID is open_id, union_id, user_id, or lark_id.',
    '- To read the current authorized user, use action="get_current_user" with no userId.',
    '- All actions trigger the Feishu Device Flow automatically when user_access_token is missing or invalid.',
    '- pageSize controls Feishu API paging only. It is not a total output limit; use maxBlocks to limit Docx scan size.',
    '- Prefer narrow spreadsheet ranges to avoid large outputs.',
  ].join('\n'),
  category: 'web',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 120000,
  systemPrompt() {
    return [
      '# feishu_read',
      '- When the user asks for their own Feishu profile, current user, "我", or "当前用户", call feishu_read with action="get_current_user". Do not ask for a user ID first.',
      '- All feishu_read actions use user_access_token. If user_access_token is missing, invalid, or expired, the tool starts the Feishu Device Flow automatically and waits. Do not call ask_user for Feishu authorization and do not manually print verification steps unless the tool itself fails.',
      '- For a URL containing /wiki/, call feishu_read once with action="read_wiki" and the full url. Do not try read_doc, read_old_doc, get_wiki_node, or alternate token parameter names first.',
      '- When the user asks for document images or attachments, call action="list_doc_media" first, then download_media for the returned token. Do not call read_doc_rich/get_doc_blocks just to find media tokens.',
      '- When the user asks for exact Docx structure, call action="get_doc_blocks". It returns compact blockPreview and media assets only; full raw blocks/tree are intentionally unavailable to the model.',
      '- To fetch an image or attachment returned in assets/token fields, call action="download_media" with fileToken/token. A successful image download is automatically rendered as a feishu-media UI block.',
      '- After a successful download_media call, stop using tools for display. Do not call browser_action, shell_command, write_file, read_file, or create local HTML to show the same image.',
      '- Do not embed base64 data, local file contents, or markdown data URLs in answers.',
      '- list_doc_media/get_doc_blocks/read_doc_rich require docs scopes; download_media requires docs plus media download scope. The authorization flow appends these scopes automatically.',
      '- pageSize is only the Feishu API page size. To limit scanned Docx blocks, use maxBlocks.',
      '- If a feishu_read call fails with an authorization error, do not retry the same URL with different parameters. Use the built-in authorization flow and wait for that tool result.',
      '- When the user explicitly asks to authorize, login, reconnect, or refresh Feishu access, call feishu_auth with action="login" instead of feishu_read.',
      '- If a Feishu authorization UI block appears, wait for the tool result. The tool continues automatically after the user approves access.',
      '- Use action="get_user" only when the user explicitly provides an ID or asks about a specific other user.',
      '- For Feishu wiki URLs, call action="read_wiki" instead of read_doc/read_old_doc/read_sheet.',
      '- For spreadsheets without a user-specified range, use the default all-sheet preview first. Ask for a specific sheet/range only when the preview is truncated or the user needs full details.',
    ].join('\n');
  },
  defaultConfig: {
    autoAuthorizeUser: true,
    defaultSheetRange: DEFAULT_SHEET_RANGE,
    defaultSheetMode: DEFAULT_SHEET_MODE,
    maxTextChars: DEFAULT_MAX_TEXT_CHARS,
    maxCells: DEFAULT_MAX_CELLS,
    maxCellChars: DEFAULT_MAX_CELL_CHARS,
    maxRanges: 10,
    maxBlocks: DEFAULT_MAX_BLOCKS,
    maxModelTextChars: DEFAULT_MAX_MODEL_TEXT_CHARS,
    pageSize: DEFAULT_BLOCK_PAGE_SIZE,
    maxMediaBytes: DEFAULT_MAX_MEDIA_BYTES,
    valueRenderOption: 'ToString',
    dateTimeRenderOption: 'FormattedString',
    userIdType: 'open_id',
    departmentIdType: 'open_department_id',
    user_access_token: '',
  },
  configSchema: {
    type: 'object',
    properties: {
      autoAuthorizeUser: { type: 'boolean', description: 'When user_access_token is missing or invalid, start Feishu Device Flow instead of failing.' },
      defaultSheetRange: { type: 'string', description: 'Default A1 range when reading a sheet without ranges.' },
      defaultSheetMode: { type: 'string', description: 'No-range spreadsheet mode: first or all_preview.' },
      maxTextChars: { type: 'number', description: 'Maximum document text characters returned.' },
      maxCells: { type: 'number', description: 'Maximum spreadsheet cells returned.' },
      maxCellChars: { type: 'number', description: 'Maximum characters returned per spreadsheet cell.' },
      maxRanges: { type: 'number', description: 'Maximum spreadsheet ranges in one call.' },
      maxBlocks: { type: 'number', description: 'Maximum Docx blocks scanned by list_doc_media/get_doc_blocks/read_doc_rich.' },
      maxModelTextChars: { type: 'number', description: 'Maximum Markdown/text characters returned to the model for compact Docx rich previews.' },
      pageSize: { type: 'number', description: 'Docx API page size only; not a total output limit.' },
      maxMediaBytes: { type: 'number', description: 'Maximum bytes saved by download_media.' },
      valueRenderOption: { type: 'string', description: 'Sheet value render option: ToString, FormattedValue, Formula, UnformattedValue.' },
      dateTimeRenderOption: { type: 'string', description: 'Sheet datetime render option: FormattedString or SerialNumber.' },
      userIdType: { type: 'string', description: 'User ID type for mentions: open_id, union_id, user_id, or lark_id.' },
      departmentIdType: { type: 'string', description: 'Department ID type for user lookup: open_department_id or department_id.' },
      user_access_token: { type: 'string', description: 'Optional user token override. Normally empty; feishu_auth stores authorization state.' },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Read limits',
      config: {
        autoAuthorizeUser: true,
        defaultSheetRange: 'A1:Z100',
        defaultSheetMode: 'all_preview',
        maxTextChars: 50000,
        maxCells: 2000,
        maxBlocks: 2000,
        maxModelTextChars: DEFAULT_MAX_MODEL_TEXT_CHARS,
        maxMediaBytes: 5000000,
      },
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation to perform: read_doc, list_doc_media, get_doc_blocks, read_doc_rich, download_media, read_old_doc, read_wiki, get_wiki_node, read_sheet, get_sheet_meta, get_user, get_current_user, authorize_current_user, or complete_current_user_authorization.',
      },
      url: {
        type: 'string',
        description: 'Optional Feishu/Lark document or spreadsheet URL. Tokens will be extracted when possible.',
      },
      documentId: {
        type: 'string',
        description: 'New Docx document_id. Usually the token after /docx/ in the URL.',
      },
      documentRevisionId: {
        type: 'number',
        description: 'Optional Docx document_revision_id for block reads.',
      },
      document_revision_id: {
        type: 'number',
        description: 'Alias of documentRevisionId.',
      },
      pageToken: {
        type: 'string',
        description: 'Optional Docx blocks page token.',
      },
      page_token: {
        type: 'string',
        description: 'Alias of pageToken.',
      },
      pageSize: {
        type: 'number',
        description: 'Docx API page size only. This is not a total output limit; use maxBlocks to limit scanned blocks.',
      },
      maxBlocks: {
        type: 'number',
        description: 'Maximum Docx blocks to scan.',
      },
      includeTree: {
        type: 'boolean',
        description: 'Deprecated. Full parent/child trees are no longer returned to the model; use blockPreview/assets instead.',
      },
      fileToken: {
        type: 'string',
        description: 'Media file_token for download_media.',
      },
      file_token: {
        type: 'string',
        description: 'Alias of fileToken.',
      },
      mediaToken: {
        type: 'string',
        description: 'Alias of fileToken.',
      },
      media_token: {
        type: 'string',
        description: 'Alias of fileToken.',
      },
      maxMediaBytes: {
        type: 'number',
        description: 'Maximum bytes to save from download_media.',
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
      sheetMode: {
        type: 'string',
        description: 'Default no-range sheet reading mode: first or all_preview. Explicit ranges are always respected.',
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
    for (const key of ['documentRevisionId', 'document_revision_id', 'pageSize', 'maxBlocks', 'maxMediaBytes']) {
      if (input[key] !== undefined && input[key] !== null && !Number.isInteger(Number(input[key]))) throw new Error(`${key} must be an integer`);
    }
    if (input.valueRenderOption && !VALUE_RENDER_OPTIONS.has(String(input.valueRenderOption))) throw new Error('invalid valueRenderOption');
    if (input.dateTimeRenderOption && !DATETIME_RENDER_OPTIONS.has(String(input.dateTimeRenderOption))) throw new Error('invalid dateTimeRenderOption');
    if (input.sheetMode && !SHEET_MODES.has(String(input.sheetMode))) throw new Error('invalid sheetMode');
    if (input.userIdType && !USER_ID_TYPES.has(String(input.userIdType))) throw new Error('invalid userIdType');
    if (input.departmentIdType && !DEPARTMENT_ID_TYPES.has(String(input.departmentIdType))) throw new Error('invalid departmentIdType');
  },

  async handler(input, ctx) {
    switch (input.action) {
      case 'read_doc':
        return readDoc(input, ctx);
      case 'list_doc_media':
        return listDocMedia(input, ctx);
      case 'get_doc_blocks':
        return getDocBlocks(input, ctx);
      case 'read_doc_rich':
        return readDocRich(input, ctx);
      case 'download_media':
        return downloadMedia(input, ctx);
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

  modelOutput(output, input, ctx) {
    return modelVisibleFeishuOutput(output, input, ctx);
  },

  parseResult(output) {
    const label = output.resourceType === 'sheet'
      ? `feishu:${output.spreadsheetToken || 'sheet'}`
      : output.resourceType === 'media'
        ? `feishu:media:${output.filename || output.fileToken || output.mediaToken || 'asset'}`
      : output.resourceType === 'wiki'
        ? `feishu:wiki:${output.node?.title || output.wikiToken || output.objToken || ''}`
      : output.resourceType === 'user'
        ? `feishu:user:${output.userId || output.user?.user_id || ''}`
        : output.resourceType === 'authorization'
          ? 'feishu:authorization'
      : `feishu:${output.documentId || output.docToken || 'doc'}`;
    const content = output.content || output.contentPreview || JSON.stringify(output.resourceType === 'media'
      ? {
        fileToken: output.fileToken,
        contentType: output.contentType,
        contentDisposition: output.contentDisposition,
        size: output.size ?? output.sizeBytes,
        encoding: output.encoding,
        filename: output.filename,
        previewUrl: output.previewUrl,
        displayedInUi: true,
      }
      : output.resourceType === 'user'
      ? { user: output.user }
      : output.resourceType === 'wiki'
        ? { node: output.node, blockCount: output.blockCount, assetCount: output.assetCount, assets: output.assets, blockPreview: output.blockPreview, omitted: output.omitted }
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
      : output.resourceType === 'docx'
        ? { documentId: output.documentId, blockCount: output.blockCount, assetCount: output.assetCount, assets: output.assets, blockPreview: output.blockPreview, omitted: output.omitted }
      : { properties: output.properties, sheets: output.sheets }, null, 2);
    if (output.resourceType === 'media') {
      return {
        renderType: 'feishu-media',
        data: {
          path: label,
          fileToken: output.fileToken,
          filename: output.filename,
          previewUrl: output.previewUrl,
          contentType: output.contentType,
          contentDisposition: output.contentDisposition,
          size: output.size ?? output.sizeBytes,
        },
      };
    }
    return {
      renderType: 'file-snippet',
      data: {
        path: label,
        encoding: 'utf-8',
        size: Buffer.byteLength(content, 'utf-8'),
        startLine: 1,
        endLine: content.split(/\r?\n/).length,
        truncated: output.truncated === true,
        contentFormat: output.content ? 'markdown' : 'text',
        contentPreview: content.slice(0, 4000),
      },
    };
  },

  scrubRunRecord(record) {
    if (record?.output?.resourceType === 'media') {
      return {
        ...record,
        output: {
          action: record.output.action,
          resourceType: record.output.resourceType,
          fileToken: record.output.fileToken,
          contentType: record.output.contentType,
          contentDisposition: record.output.contentDisposition,
          size: record.output.size ?? record.output.sizeBytes,
          encoding: record.output.encoding,
          filename: record.output.filename,
          previewUrl: record.output.previewUrl,
        },
      };
    }
    return record;
  },

  __test: {
    extractTokenFromUrl,
    trimValueRanges,
    formatSheetAsMarkdown,
    buildBlockTree,
    mediaAssetsFromBlocks,
    formatBlocksAsMarkdown,
  },
};
