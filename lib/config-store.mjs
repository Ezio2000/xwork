import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from './sqlite-store.mjs';
import { normalizeAppConfig } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');
const DEFAULT_CONFIG = { channels: [], activeChannelId: null, activeModel: null };

const configStore = createSqliteDocumentStore({
  key: 'config',
  legacyFilePath: CONFIG_PATH,
  defaultValue: DEFAULT_CONFIG,
  normalize: cfg => ({
    ...DEFAULT_CONFIG,
    ...normalizeAppConfig(cfg),
  }),
  serialize: cfg => ({ ...DEFAULT_CONFIG, ...cfg }),
});

export async function readConfig() {
  return configStore.read();
}

export async function writeConfig(cfg) {
  await configStore.write(cfg);
}

export async function updateConfig(mutator) {
  return configStore.update(mutator);
}
