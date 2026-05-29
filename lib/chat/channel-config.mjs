import { resolveChatChannel } from '../channels.mjs';
import { getEnabledToolDefinitions } from '../tools/registry.mjs';

export async function resolveRuntimeChannelConfig({ channelId, model }) {
  const resolved = await resolveChatChannel({ channelId, model });
  if (resolved.error) return resolved;

  const { channel, requestModel, modelConfig, cfg } = resolved;
  const enabledTools = await getEnabledToolDefinitions();
  return {
    ...resolved,
    requestModel,
    modelConfig,
    channelConfig: {
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: requestModel,
      modelConfig,
      appConfig: cfg,
      channelId: channel.id,
      maxTokens: channel.maxTokens,
      maxTurns: channel.maxTurns || 5,
      extraHeaders: channel.extraHeaders,
      tools: enabledTools,
    },
  };
}
