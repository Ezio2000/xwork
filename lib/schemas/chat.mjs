import {
  MAX_MESSAGE_LEN,
  MAX_MODEL_LEN,
  fail,
  isPlainObject,
  nonEmptyString,
  optionalString,
  validateOptionalSafeId,
} from './common.mjs';

export function validateChatRequest(payload) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  return {
    runId: validateOptionalSafeId(payload.runId, 'runId'),
    conversationId: validateOptionalSafeId(payload.conversationId, 'conversationId'),
    message: nonEmptyString(payload.message, 'message', MAX_MESSAGE_LEN),
    channelId: validateOptionalSafeId(payload.channelId, 'channelId'),
    model: optionalString(payload.model, 'model', MAX_MODEL_LEN),
  };
}
