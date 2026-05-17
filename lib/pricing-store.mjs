import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASE_PRICING,
  normalizeBasePricingEntries,
  publicPricingEntry,
  validateBasePricingEntry,
} from './model-pricing.mjs';
import { validateSafeId } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(__dirname, '..', 'data', 'model-pricing.json');
let writeQueue = Promise.resolve();

async function ensurePricingFile() {
  const dir = dirname(PRICING_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  if (!existsSync(PRICING_PATH)) {
    await writeFile(PRICING_PATH, JSON.stringify({ basePricing: DEFAULT_BASE_PRICING }, null, 2));
  }
}

async function readPricingData() {
  await ensurePricingFile();
  try {
    const data = JSON.parse(await readFile(PRICING_PATH, 'utf-8'));
    const basePricing = normalizeBasePricingEntries(data.basePricing);
    return { basePricing };
  } catch {
    return { basePricing: [...DEFAULT_BASE_PRICING] };
  }
}

async function writePricingData(data) {
  await ensurePricingFile();
  await writeFile(PRICING_PATH, JSON.stringify({
    basePricing: normalizeBasePricingEntries(data.basePricing),
  }, null, 2));
}

function updatePricingData(mutator) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const data = await readPricingData();
    const result = await mutator(data);
    await writePricingData(data);
    return result;
  });
  return writeQueue;
}

export async function listBasePricing() {
  const data = await readPricingData();
  return data.basePricing.map(publicPricingEntry);
}

export async function getBasePricingEntries() {
  const data = await readPricingData();
  return data.basePricing;
}

export async function createBasePricingEntry(payload) {
  const entry = validateBasePricingEntry(payload);
  return updatePricingData((data) => {
    if (data.basePricing.some(item => item.id === entry.id)) {
      return { error: 'Pricing entry already exists', status: 409 };
    }
    data.basePricing.push(entry);
    return publicPricingEntry(entry);
  });
}

export async function updateBasePricingEntry(id, payload) {
  const safeId = validateSafeId(id, 'pricingId');
  const patch = validateBasePricingEntry(payload, { partial: true });
  return updatePricingData((data) => {
    const idx = data.basePricing.findIndex(item => item.id === safeId);
    if (idx === -1) return { error: 'Pricing entry not found', status: 404 };
    const next = { ...data.basePricing[idx], ...patch, id: safeId };
    data.basePricing[idx] = validateBasePricingEntry(next);
    return publicPricingEntry(data.basePricing[idx]);
  });
}

export async function deleteBasePricingEntry(id) {
  const safeId = validateSafeId(id, 'pricingId');
  return updatePricingData((data) => {
    const idx = data.basePricing.findIndex(item => item.id === safeId);
    if (idx === -1) return { error: 'Pricing entry not found', status: 404 };
    data.basePricing.splice(idx, 1);
    return { ok: true };
  });
}
