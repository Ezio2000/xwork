import { resolveChatChannel } from '../channels.mjs';
import { getEnabledToolDefinitions } from '../tools/registry.mjs';

export async function resolveRuntimeChannelConfig({ channelId, model }) {
  const resolved = await resolveChatChannel({ channelId, model });
  if (resolved.error) return resolved;

  const { channel, requestModel } = resolved;
  const enabledTools = await getEnabledToolDefinitions();
  return {
    ...resolved,
    requestModel,
    channelConfig: {
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: requestModel,
      maxTokens: channel.maxTokens,
      maxTurns: channel.maxTurns || 5,
      extraHeaders: channel.extraHeaders,
      tools: enabledTools,
    },
  };
}
