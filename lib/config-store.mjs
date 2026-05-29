import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from './sqlite-store.mjs';
import { minimaxTokenPlanVisionProvider, normalizeAppConfig } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');
const DEFAULT_DEEPSEEK_CHANNEL_ID = '911c406a';
const DEFAULT_DEEPSEEK_MODEL_ID = 'deepseek-v4-flash';
const DEFAULT_MINIMAX_VISION_PROVIDER_ID = 'minimax-token-plan-vlm';

const DEFAULT_CONFIG = {
  channels: [
    {
      id: DEFAULT_DEEPSEEK_CHANNEL_ID,
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: '',
      models: [
        {
          id: DEFAULT_DEEPSEEK_MODEL_ID,
          capabilities: { imageInput: false },
          unsupportedImagePolicy: {
            action: 'vision_to_text',
            onVisionFailure: 'reject',
          },
        },
      ],
      maxTokens: 8192,
      maxTurns: 100,
      extraHeaders: {},
      pricing: { models: {} },
    },
  ],
  activeChannelId: DEFAULT_DEEPSEEK_CHANNEL_ID,
  activeModel: DEFAULT_DEEPSEEK_MODEL_ID,
  workspace: { root: null, label: 'xwork' },
  visionProviders: [
    minimaxTokenPlanVisionProvider({
      id: DEFAULT_MINIMAX_VISION_PROVIDER_ID,
      apiKey: '',
    }),
  ],
  vision: {
    defaultChannelId: null,
    defaultModelId: null,
    defaultProviderId: DEFAULT_MINIMAX_VISION_PROVIDER_ID,
    defaultProvider: null,
    defaultFailureAction: 'ask_user',
  },
};

export function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

const configStore = createSqliteDocumentStore({
  key: 'config',
  legacyFilePath: CONFIG_PATH,
  defaultValue: defaultConfig(),
  normalize: cfg => ({
    ...defaultConfig(),
    ...normalizeAppConfig(cfg),
  }),
  serialize: cfg => ({ ...defaultConfig(), ...cfg }),
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
