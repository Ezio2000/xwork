import { randomUUID } from 'node:crypto';

import { readConfig } from '../config-store.mjs';
import { readImageAssetBase64, requireImageAsset, updateImageVisionCache } from '../image-assets.mjs';
import { RUN_EVENT_TYPES } from '../run-events.mjs';
import { summarizeImageWithVisionProvider } from '../vision/providers.mjs';

function contentHasImages(content) {
  if (!Array.isArray(content)) return false;
  return content.some(part => part?.type === 'image' && (part.imageId || part.source?.image_id));
}

export function historyHasImages(history = []) {
  return history.some(message => message?.role === 'user' && contentHasImages(message.content));
}

function modelSupportsImages(modelConfig) {
  return modelConfig?.capabilities?.imageInput === true;
}

function imageIdFromPart(part) {
  return part?.imageId || part?.source?.image_id || '';
}

function defaultUnsupportedImagePolicy(modelConfig) {
  return modelConfig?.unsupportedImagePolicy || { action: 'vision_to_text' };
}

function providerFromLegacyVisionRef(ref) {
  if (!ref?.channelId || !ref?.modelId) return null;
  return {
    type: 'anthropic_model',
    channelId: ref.channelId,
    modelId: ref.modelId,
  };
}

function resolveVisionProvider(appConfig, policy) {
  if (policy?.visionProviderId) {
    return (appConfig?.visionProviders || []).find(provider => provider.id === policy.visionProviderId && provider.enabled !== false) || null;
  }
  if (policy?.visionProvider?.type) return policy.visionProvider;
  const legacyOverride = providerFromLegacyVisionRef(policy?.visionModel);
  if (legacyOverride) return legacyOverride;
  const vision = appConfig?.vision || {};
  if (vision.defaultProviderId) {
    return (appConfig?.visionProviders || []).find(provider => provider.id === vision.defaultProviderId && provider.enabled !== false) || null;
  }
  if (vision.defaultChannelId && vision.defaultModelId) {
    return providerFromLegacyVisionRef({
      channelId: vision.defaultChannelId,
      modelId: vision.defaultModelId,
    });
  }
  if (vision.defaultProvider?.type) return vision.defaultProvider;
  return null;
}

function resolveVisionFailureAction(appConfig, policy) {
  return policy?.onVisionFailure || appConfig?.vision?.defaultFailureAction || 'reject';
}

function imageSummaryText(asset, vision) {
  const caption = String(vision?.caption || '').trim();
  const ocrText = String(vision?.ocrText || '').trim();
  const sections = [
    `用户上传图片：${asset.filename || asset.id} (${asset.mediaType || 'image'}, ${asset.size || 0} bytes)。`,
  ];
  if (caption) sections.push(`图片内容摘要：\n${caption}`);
  if (ocrText) sections.push(`图片 OCR 文本：\n${ocrText}`);
  if (!caption && !ocrText) sections.push('图片识别结果为空。');
  return sections.join('\n\n');
}

async function summarizeImageWithVisionModel(asset, { appConfig, policy, signal }) {
  if (asset.vision?.caption || asset.vision?.ocrText) return asset.vision;

  const provider = resolveVisionProvider(appConfig, policy);
  if (!provider) throw new Error('Vision provider is not configured');
  const { base64 } = await readImageAssetBase64(asset.id);
  const result = await summarizeImageWithVisionProvider({
    provider,
    appConfig,
    asset,
    base64,
    signal,
  });
  const vision = {
    caption: result.caption || '',
    ocrText: result.ocrText || '',
    visionModel: result.providerRef || provider.type,
    traceId: result.traceId || '',
    generatedAt: new Date().toISOString(),
  };
  await updateImageVisionCache(asset.id, vision);
  return vision;
}

function askUserEvent({ runId, policy, imageCount }) {
  return {
    type: RUN_EVENT_TYPES.ASK_USER_PENDING,
    id: `image_policy_${randomUUID().replace(/-/g, '')}`,
    name: 'image_policy',
    kind: 'single',
    question: '当前模型不支持图片输入，要如何继续？',
    context: `本次上下文包含 ${imageCount} 张图片。当前策略要求由用户选择处理方式。`,
    options: [
      { value: 'vision_to_text', label: '视觉转文本', description: '先用专用视觉模型识别图片，再继续发送给当前模型。' },
      { value: 'remove_images', label: '移除图片', description: '只发送文字内容，图片不会进入模型上下文。' },
      { value: 'cancel', label: '取消发送', description: '停止本次请求。' },
    ],
    recommended: 'vision_to_text',
    allowSkip: false,
  };
}

async function waitForImagePolicyChoice({ emit, userInputRegistry, runId, imageCount, signal }) {
  const evt = askUserEvent({ runId, imageCount });
  const pending = userInputRegistry.waitForAnswer({
    runId,
    toolCallId: evt.id,
    meta: evt,
    signal,
  });
  emit(evt);
  const response = await pending;
  emit({
    type: RUN_EVENT_TYPES.TOOL_RESULT,
    tools: [{
      id: evt.id,
      name: 'image_policy',
      isError: false,
      durationMs: 0,
      renderType: 'ask-user',
      data: {
        status: 'answered',
        answer: response?.answer || 'cancel',
      },
    }],
  });
  return response?.answer || 'cancel';
}

async function projectPart(part, context) {
  if (part?.type !== 'image') return part;
  const id = imageIdFromPart(part);
  const asset = await requireImageAsset(id);

  if (context.mode === 'native') {
    const { base64 } = await readImageAssetBase64(id);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: asset.mediaType,
        data: base64,
      },
    };
  }

  if (context.mode === 'remove') return null;

  const vision = await summarizeImageWithVisionModel(asset, context);
  return {
    type: 'text',
    text: imageSummaryText(asset, vision),
  };
}

async function projectMessage(message, context) {
  if (!Array.isArray(message?.content) || !contentHasImages(message.content)) return message;
  const content = [];
  for (const part of message.content) {
    const projected = await projectPart(part, context);
    if (projected) content.push(projected);
  }
  return { ...message, content };
}

export async function projectImagesForModel(history, {
  modelConfig,
  appConfig,
  emit,
  userInputRegistry,
  runId,
  signal,
} = {}) {
  if (!historyHasImages(history)) return history;

  if (modelSupportsImages(modelConfig)) {
    const projected = [];
    for (const message of history) {
      projected.push(await projectMessage(message, { mode: 'native' }));
    }
    return projected;
  }

  const policy = defaultUnsupportedImagePolicy(modelConfig);
  const imageCount = history.reduce((count, message) => {
    if (!Array.isArray(message?.content)) return count;
    return count + message.content.filter(part => part?.type === 'image').length;
  }, 0);

  let action = policy.action || 'vision_to_text';
  if (action === 'ask_user') {
    action = await waitForImagePolicyChoice({
      emit,
      userInputRegistry,
      runId,
      imageCount,
      signal,
    });
  }

  if (action === 'remove_images') {
    const projected = [];
    for (const message of history) projected.push(await projectMessage(message, { mode: 'remove' }));
    return projected;
  }
  if (action === 'cancel') throw new Error('Image request cancelled by user');
  if (action === 'reject') {
    throw new Error('Current model does not support image input');
  }

  const latestConfig = appConfig || await readConfig();
  const projected = [];
  try {
    for (const message of history) {
      projected.push(await projectMessage(message, {
        mode: 'vision_to_text',
        appConfig: latestConfig,
        policy,
        signal,
      }));
    }
    return projected;
  } catch (err) {
    const failureAction = resolveVisionFailureAction(latestConfig, policy);
    if (failureAction === 'remove_images') {
      const removed = [];
      for (const message of history) removed.push(await projectMessage(message, { mode: 'remove' }));
      return removed;
    }
    if (failureAction === 'ask_user') {
      const choice = await waitForImagePolicyChoice({
        emit,
        userInputRegistry,
        runId,
        imageCount,
        signal,
      });
      if (choice === 'remove_images') {
        const removed = [];
        for (const message of history) removed.push(await projectMessage(message, { mode: 'remove' }));
        return removed;
      }
      if (choice === 'cancel') throw new Error('Image request cancelled by user');
    }
    throw new Error(`Image recognition failed: ${err.message || String(err)}`);
  }
}
