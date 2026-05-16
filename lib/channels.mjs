import { randomUUID } from 'node:crypto';

import { readConfig, updateConfig, writeConfig } from './config-store.mjs';

function maskKey(key) {
  if (!key) return '';
  return '••••' + key.slice(-4);
}

export function maskChannel(channel) {
  return { ...channel, apiKey: maskKey(channel.apiKey) };
}

export function getActiveChannel(cfg) {
  const ch = cfg.channels.find(channel => channel.id === cfg.activeChannelId);
  return ch || cfg.channels[0] || null;
}

export function publicActiveState(cfg) {
  return {
    activeChannelId: cfg.activeChannelId,
    activeModel: cfg.activeModel,
    channels: cfg.channels.map(maskChannel),
  };
}

export async function getActiveState() {
  return publicActiveState(await readConfig());
}

export async function setActiveState({ channelId, model }) {
  return updateConfig((cfg) => {
    if (channelId !== undefined) {
      if (!cfg.channels.find(channel => channel.id === channelId)) {
        return { error: 'Channel not found' };
      }
      cfg.activeChannelId = channelId;
    }
    if (model !== undefined) cfg.activeModel = model;
    return publicActiveState(cfg);
  });
}

export async function listChannels() {
  const cfg = await readConfig();
  return cfg.channels.map(maskChannel);
}

export async function createChannel(payload) {
  const { name, baseUrl, apiKey, models, maxTokens, extraHeaders } = payload || {};
  if (!name || !baseUrl) return { error: 'name and baseUrl required' };

  return updateConfig((cfg) => {
    const channel = {
      id: randomUUID().slice(0, 8),
      name,
      baseUrl,
      apiKey: apiKey || '',
      models: Array.isArray(models) ? models : [],
      maxTokens: maxTokens || 8192,
      extraHeaders: extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {},
    };

    cfg.channels.push(channel);
    if (!cfg.activeChannelId) {
      cfg.activeChannelId = channel.id;
      cfg.activeModel = channel.models[0] || '';
    }

    return maskChannel(channel);
  });
}

export async function updateChannel(id, payload) {
  return updateConfig((cfg) => {
    const idx = cfg.channels.findIndex(channel => channel.id === id);
    if (idx === -1) return { error: 'Channel not found', status: 404 };

    const channel = cfg.channels[idx];
    const { name, baseUrl, apiKey, models, maxTokens, extraHeaders } = payload || {};
    if (name !== undefined) channel.name = name;
    if (baseUrl !== undefined) channel.baseUrl = baseUrl;
    if (apiKey !== undefined && apiKey !== '' && !apiKey.startsWith('••••')) {
      channel.apiKey = apiKey;
    }
    if (models !== undefined) channel.models = Array.isArray(models) ? models : [];
    if (maxTokens !== undefined) channel.maxTokens = maxTokens;
    if (extraHeaders !== undefined) {
      channel.extraHeaders = extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {};
    }

    return maskChannel(channel);
  });
}

export async function deleteChannel(id) {
  return updateConfig((cfg) => {
    const idx = cfg.channels.findIndex(channel => channel.id === id);
    if (idx === -1) return { error: 'Channel not found', status: 404 };

    cfg.channels.splice(idx, 1);
    if (cfg.activeChannelId === id) {
      cfg.activeChannelId = cfg.channels[0]?.id || null;
      cfg.activeModel = cfg.channels[0]?.models?.[0] || null;
    }

    return { ok: true };
  });
}

export async function resolveChatChannel({ channelId, model }) {
  const cfg = await readConfig();
  let channel = channelId ? cfg.channels.find(item => item.id === channelId) : null;
  if (!channel) channel = getActiveChannel(cfg);
  if (!channel) return { error: 'No channel configured' };
  if (!channel.apiKey) return { error: 'API key not configured for this channel' };

  let requestModel = model || cfg.activeModel || channel.models[0];
  if (channel.models?.length && !channel.models.includes(requestModel)) {
    requestModel = channel.models[0];
    cfg.activeModel = requestModel;
    cfg.activeChannelId = channel.id;
    await writeConfig(cfg);
  }

  return { cfg, channel, requestModel };
}
