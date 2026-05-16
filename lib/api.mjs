// Backward-compatible API facade.

export { streamChat } from './anthropic/client.mjs';
export { assistantMessage } from './anthropic/assistant-message.mjs';
export {
  anthropicTools,
  buildSystemPrompt,
  normalizeContentBlocks,
  normalizeMessages,
  textFromContent,
} from './anthropic/message-normalizer.mjs';
export { parseSseChunk } from './anthropic/sse-parser.mjs';
