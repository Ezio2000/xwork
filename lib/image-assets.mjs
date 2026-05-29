import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from './sqlite-store.mjs';
import { fail, isPlainObject, isSafeId } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
export const IMAGE_UPLOAD_DIR = join(DATA_DIR, 'uploads', 'images');

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPerMessage: 5,
});

const ALLOWED_MEDIA_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const assetStore = createSqliteDocumentStore({
  key: 'image-assets',
  legacyFilePath: null,
  defaultValue: { assets: {} },
  normalize: normalizeAssetStore,
  serialize: normalizeAssetStore,
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeAssetStore(value) {
  const raw = isPlainObject(value) ? value : {};
  const assets = {};
  if (isPlainObject(raw.assets)) {
    for (const [id, asset] of Object.entries(raw.assets)) {
      const normalized = normalizeImageAsset({ ...asset, id });
      if (normalized) assets[normalized.id] = normalized;
    }
  }
  return { assets };
}

function normalizeImageAsset(value) {
  if (!isPlainObject(value) || !isSafeId(value.id)) return null;
  const mediaType = String(value.mediaType || '').toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) return null;
  const filename = typeof value.filename === 'string' ? value.filename : `${value.id}${ALLOWED_MEDIA_TYPES.get(mediaType)}`;
  const storedName = typeof value.storedName === 'string' ? value.storedName : filename;
  const size = Number(value.size || 0);
  return {
    id: value.id,
    filename,
    storedName,
    mediaType,
    size: Number.isFinite(size) ? size : 0,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
    url: imageAssetUrl(value.id),
    ...(isPlainObject(value.vision) ? { vision: normalizeVisionCache(value.vision) } : {}),
  };
}

function normalizeVisionCache(value) {
  return {
    caption: typeof value.caption === 'string' ? value.caption : '',
    ocrText: typeof value.ocrText === 'string' ? value.ocrText : '',
    visionModel: typeof value.visionModel === 'string' ? value.visionModel : '',
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    traceId: typeof value.traceId === 'string' ? value.traceId : '',
  };
}

function sanitizeFilename(name) {
  const base = String(name || 'image').split(/[\\/]/).pop() || 'image';
  return base.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'image';
}

function mediaTypeFromDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,/i);
  return match ? match[1].toLowerCase() : '';
}

function bufferFromDataUrl(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (comma < 0 || !/^data:[^;,]+;base64,/i.test(text.slice(0, comma + 1))) {
    fail('image dataUrl must be a base64 data URL');
  }
  return Buffer.from(text.slice(comma + 1), 'base64');
}

export function validateImageRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('images must be an array');
  if (value.length > IMAGE_LIMITS.maxPerMessage) {
    fail(`images must contain at most ${IMAGE_LIMITS.maxPerMessage} items`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) fail(`images[${index}] must be an object`);
    const id = String(item.id || '');
    if (!isSafeId(id)) fail(`images[${index}].id must be a safe id`);
    return { id };
  });
}

export function imageAssetUrl(id) {
  return `/api/v1/images/${encodeURIComponent(id)}`;
}

export async function createImageAsset({ dataUrl, filename = 'image' } = {}) {
  const mediaType = mediaTypeFromDataUrl(dataUrl);
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    fail('unsupported image media type');
  }
  const buffer = bufferFromDataUrl(dataUrl);
  if (!buffer.length) fail('image is empty');
  if (buffer.length > IMAGE_LIMITS.maxBytes) {
    fail(`image must be at most ${IMAGE_LIMITS.maxBytes} bytes`);
  }

  await mkdir(IMAGE_UPLOAD_DIR, { recursive: true });
  const id = randomUUID().replace(/-/g, '');
  const ext = ALLOWED_MEDIA_TYPES.get(mediaType);
  const original = sanitizeFilename(filename);
  const originalExt = extname(original).toLowerCase();
  const safeName = originalExt ? original : `${original}${ext}`;
  const storedName = `${id}${ext}`;
  const filePath = join(IMAGE_UPLOAD_DIR, storedName);
  await writeFile(filePath, buffer);

  const asset = {
    id,
    filename: safeName,
    storedName,
    mediaType,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    createdAt: nowIso(),
    url: imageAssetUrl(id),
  };

  await assetStore.update((data) => {
    data.assets[id] = asset;
  });

  return asset;
}

export async function getImageAsset(id) {
  if (!isSafeId(id)) return null;
  const data = await assetStore.read();
  return data.assets[id] || null;
}

export async function requireImageAsset(id) {
  const asset = await getImageAsset(id);
  if (!asset) fail('image not found', 404);
  return asset;
}

export async function imageAssetFilePath(id) {
  const asset = await requireImageAsset(id);
  const filePath = resolve(IMAGE_UPLOAD_DIR, asset.storedName);
  if (!filePath.startsWith(resolve(IMAGE_UPLOAD_DIR))) fail('invalid image path');
  await stat(filePath);
  return { asset, filePath };
}

export async function readImageAssetBase64(id) {
  const { asset, filePath } = await imageAssetFilePath(id);
  const buffer = await readFile(filePath);
  return { asset, base64: buffer.toString('base64') };
}

export async function updateImageVisionCache(id, vision) {
  const asset = await requireImageAsset(id);
  const nextVision = normalizeVisionCache(vision || {});
  await assetStore.update((data) => {
    const current = data.assets[id] || asset;
    data.assets[id] = { ...current, vision: nextVision, url: imageAssetUrl(id) };
  });
  return { ...asset, vision: nextVision };
}

export async function ensureImageUploadDir() {
  if (!existsSync(IMAGE_UPLOAD_DIR)) {
    await mkdir(IMAGE_UPLOAD_DIR, { recursive: true });
  }
}
