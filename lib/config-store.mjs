import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAppConfig } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');
const DEFAULT_CONFIG = { channels: [], activeChannelId: null, activeModel: null };

let writeQueue = Promise.resolve();

async function ensureConfigFile() {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

export async function readConfig() {
  await ensureConfigFile();
  try {
    return {
      ...DEFAULT_CONFIG,
      ...normalizeAppConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(cfg) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await ensureConfigFile();
    await writeFile(CONFIG_PATH, JSON.stringify({ ...DEFAULT_CONFIG, ...cfg }, null, 2));
  });
  await writeQueue;
}

export async function updateConfig(mutator) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const cfg = await readConfig();
    const result = await mutator(cfg);
    await writeFile(CONFIG_PATH, JSON.stringify({ ...DEFAULT_CONFIG, ...cfg }, null, 2));
    return { cfg, result };
  });
  const { cfg, result } = await writeQueue;
  return result === undefined ? cfg : result;
}
