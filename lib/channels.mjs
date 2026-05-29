import { randomUUID } from 'node:crypto';

import { readConfig, updateConfig, writeConfig } from './config-store.mjs';
import {
  validateChannelPayload,
  validateOptionalSafeId,
  validateVisionConfig,
  validateVisionProviderPayload,
} from './schema.mjs';

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function publicVisionConfig(vision) {
  const normalized = vision || {};
  return {
    defaultChannelId: normalized.defaultChannelId || null,
    defaultModelId: normalized.defaultModelId || null,
    defaultProviderId: normalized.defaultProviderId || null,
    defaultProvider: cloneJson(normalized.defaultProvider) || null,
    defaultFailureAction: normalized.defaultFailureAction || 'reject',
  };
}

export function publicChannel(channel) {
  return {
    ...channel,
    pricing: channel.pricing || { models: {} },
  };
}

export function modelId(model) {
  return typeof model === 'string' ? model : model?.id || '';
}

export function findChannelModel(channel, model) {
  const id = modelId(model);
  return (channel?.models || []).find(item => modelId(item) === id) || null;
}

export function firstModelId(channel) {
  return modelId(channel?.models?.[0]) || '';
}

export function getActiveChannel(cfg) {
  const ch = cfg.channels.find(channel => channel.id === cfg.activeChannelId);
  return ch || cfg.channels[0] || null;
}

export function publicActiveState(cfg) {
  return {
    activeChannelId: cfg.activeChannelId,
    activeModel: cfg.activeModel,
    channels: cfg.channels.map(publicChannel),
    vision: publicVisionConfig(cfg.vision),
    visionProviders: cloneJson(cfg.visionProviders || []),
  };
}

export async function getActiveState() {
  return publicActiveState(await readConfig());
}

export async function setActiveState({ channelId, model }) {
  const safeChannelId = validateOptionalSafeId(channelId, 'channelId');
  return updateConfig((cfg) => {
    if (safeChannelId !== undefined) {
      if (!cfg.channels.find(channel => channel.id === safeChannelId)) {
        return { error: 'Channel not found' };
      }
      cfg.activeChannelId = safeChannelId;
    }
    if (model !== undefined) cfg.activeModel = model;
    return publicActiveState(cfg);
  });
}

export async function setVisionState(payload) {
  const vision = validateVisionConfig(payload?.vision ?? payload ?? {});
  return updateConfig((cfg) => {
    if (vision.defaultChannelId) {
      const channel = cfg.channels.find(item => item.id === vision.defaultChannelId);
      if (!channel) return { error: 'Vision channel not found', status: 404 };
      if (!findChannelModel(channel, vision.defaultModelId)) {
        return { error: 'Vision model not found in selected channel', status: 404 };
      }
    }
    if (vision.defaultProviderId && !(cfg.visionProviders || []).some(provider => provider.id === vision.defaultProviderId)) {
      return { error: 'Vision provider not found', status: 404 };
    }
    cfg.vision = vision;
    return { vision: publicVisionConfig(cfg.vision) };
  });
}

export async function listVisionProviders() {
  const cfg = await readConfig();
  return cloneJson(cfg.visionProviders || []);
}

export async function createVisionProvider(payload) {
  const provider = validateVisionProviderPayload(payload || {});
  return updateConfig((cfg) => {
    const id = provider.id || randomUUID().slice(0, 8);
    if ((cfg.visionProviders || []).some(item => item.id === id)) {
      return { error: 'Vision provider id already exists', status: 409 };
    }
    const next = { ...provider, id };
    cfg.visionProviders = [...(cfg.visionProviders || []), next];
    if (!cfg.vision?.defaultProviderId) {
      cfg.vision = { ...(cfg.vision || {}), defaultProviderId: next.id };
    }
    return cloneJson(next);
  });
}

export async function updateVisionProvider(id, payload) {
  const safeId = validateOptionalSafeId(id, 'visionProviderId');
  return updateConfig((cfg) => {
    const idx = (cfg.visionProviders || []).findIndex(provider => provider.id === safeId);
    if (idx === -1) return { error: 'Vision provider not found', status: 404 };
    const current = cfg.visionProviders[idx];
    const mergedPayload = {
      ...current,
      ...(payload || {}),
      config: payload?.config !== undefined ? payload.config : current.config,
    };
    const patch = validateVisionProviderPayload(mergedPayload);
    const next = { ...patch, id: current.id };
    cfg.visionProviders[idx] = next;
    return cloneJson(next);
  });
}

export async function deleteVisionProvider(id) {
  const safeId = validateOptionalSafeId(id, 'visionProviderId');
  return updateConfig((cfg) => {
    const idx = (cfg.visionProviders || []).findIndex(provider => provider.id === safeId);
    if (idx === -1) return { error: 'Vision provider not found', status: 404 };
    cfg.visionProviders.splice(idx, 1);
    if (cfg.vision?.defaultProviderId === safeId) {
      cfg.vision = { ...cfg.vision, defaultProviderId: null };
    }
    for (const channel of cfg.channels || []) {
      for (const model of channel.models || []) {
        if (model?.unsupportedImagePolicy?.visionProviderId === safeId) {
          delete model.unsupportedImagePolicy.visionProviderId;
        }
      }
    }
    return { ok: true };
  });
}

export async function listChannels() {
  const cfg = await readConfig();
  return cfg.channels.map(publicChannel);
}

export async function createChannel(payload) {
  const { name, baseUrl, apiKey, models, maxTokens, maxTurns, extraHeaders, pricing } = validateChannelPayload(payload || {});

  return updateConfig((cfg) => {
    const channel = {
      id: randomUUID().slice(0, 8),
      name,
      baseUrl,
      apiKey: apiKey || '',
      models: Array.isArray(models) ? models : [],
      maxTokens: maxTokens || 8192,
      maxTurns: maxTurns || 5,
      extraHeaders: extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {},
      pricing: pricing || { models: {} },
    };

    cfg.channels.push(channel);
    if (!cfg.activeChannelId) {
      cfg.activeChannelId = channel.id;
      cfg.activeModel = firstModelId(channel);
    }

    return publicChannel(channel);
  });
}

export async function updateChannel(id, payload) {
  const safeId = validateOptionalSafeId(id, 'channelId');
  const patch = validateChannelPayload(payload || {}, { partial: true });
  return updateConfig((cfg) => {
    const idx = cfg.channels.findIndex(channel => channel.id === safeId);
    if (idx === -1) return { error: 'Channel not found', status: 404 };

    const channel = cfg.channels[idx];
    const { name, baseUrl, apiKey, models, maxTokens, maxTurns, extraHeaders, pricing } = patch;
    if (name !== undefined) channel.name = name;
    if (baseUrl !== undefined) channel.baseUrl = baseUrl;
    if (apiKey !== undefined) channel.apiKey = apiKey;
    if (models !== undefined) channel.models = Array.isArray(models) ? models : [];
    if (maxTokens !== undefined) channel.maxTokens = maxTokens;
    if (maxTurns !== undefined) channel.maxTurns = maxTurns;
    if (extraHeaders !== undefined) {
      channel.extraHeaders = extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {};
    }
    if (pricing !== undefined) channel.pricing = pricing || { models: {} };

    if (cfg.activeChannelId === channel.id && channel.models?.length && !findChannelModel(channel, cfg.activeModel)) {
      cfg.activeModel = firstModelId(channel);
    }
    if (cfg.vision?.defaultChannelId === channel.id && !findChannelModel(channel, cfg.vision.defaultModelId)) {
      cfg.vision = { ...cfg.vision, defaultChannelId: null, defaultModelId: null };
    }

    return publicChannel(channel);
  });
}

export async function deleteChannel(id) {
  const safeId = validateOptionalSafeId(id, 'channelId');
  return updateConfig((cfg) => {
    const idx = cfg.channels.findIndex(channel => channel.id === safeId);
    if (idx === -1) return { error: 'Channel not found', status: 404 };

    cfg.channels.splice(idx, 1);
    if (cfg.activeChannelId === safeId) {
      cfg.activeChannelId = cfg.channels[0]?.id || null;
      cfg.activeModel = firstModelId(cfg.channels[0]) || null;
    }
    if (cfg.vision?.defaultChannelId === safeId) {
      cfg.vision = { ...cfg.vision, defaultChannelId: null, defaultModelId: null };
    }

    return { ok: true };
  });
}

export async function resolveChatChannel({ channelId, model }) {
  const cfg = await readConfig();
  const safeChannelId = validateOptionalSafeId(channelId, 'channelId');
  let channel = safeChannelId ? cfg.channels.find(item => item.id === safeChannelId) : null;
  if (!channel) channel = getActiveChannel(cfg);
  if (!channel) return { error: 'No channel configured' };
  if (!channel.apiKey) return { error: 'API key not configured for this channel' };

  let requestModel = model || cfg.activeModel || firstModelId(channel);
  if (channel.models?.length && !findChannelModel(channel, requestModel)) {
    requestModel = firstModelId(channel);
    cfg.activeModel = requestModel;
    cfg.activeChannelId = channel.id;
    await writeConfig(cfg);
  }

  const modelConfig = findChannelModel(channel, requestModel);
  return { cfg, channel, requestModel, modelConfig };
}
