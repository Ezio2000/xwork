import {
  MAX_MESSAGE_LEN,
  MAX_MODEL_LEN,
  fail,
  isPlainObject,
  optionalString,
  validateOptionalSafeId,
  validateSafeId,
} from './common.mjs';
import { validateImageRefs } from '../image-assets.mjs';

export function validateChatRequest(payload) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  const message = payload.message === undefined || payload.message === null
    ? ''
    : optionalString(payload.message, 'message', MAX_MESSAGE_LEN).trim();
  const images = validateImageRefs(payload.images);
  if (!message && !images.length) {
    fail('message must be a non-empty string when no images are provided');
  }
  return {
    runId: validateOptionalSafeId(payload.runId, 'runId'),
    conversationId: validateOptionalSafeId(payload.conversationId, 'conversationId'),
    message,
    images,
    channelId: validateOptionalSafeId(payload.channelId, 'channelId'),
    model: optionalString(payload.model, 'model', MAX_MODEL_LEN),
  };
}

export function validateAskUserResponse(payload) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  const toolCallId = validateSafeId(payload.toolCallId, 'toolCallId');
  if (!isPlainObject(payload.response)) fail('response must be an object');
  return { toolCallId, response: payload.response };
}
