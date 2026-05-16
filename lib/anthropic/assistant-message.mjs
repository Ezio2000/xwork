import { appendAgentRunBlocks, buildRenderBlocks, searchCountFromEvents, uniqueSources } from '../message-rendering.mjs';
import { normalizeContentBlocks } from './message-normalizer.mjs';

export function assistantMessage(result, model) {
  const sources = uniqueSources([
    ...(result.sources || []),
    ...((result.serverToolEvents || []).flatMap(event => event.data?.sources || [])),
  ]);
  const searchCount = searchCountFromEvents(result.serverToolEvents || []);
  const content = normalizeContentBlocks(result.content?.length
    ? result.content
    : [{ type: 'text', text: result.text || '' }], 'assistant')
    .filter(part => part.type === 'text' || part.type === 'thinking' || part.type === 'redacted_thinking');
  const blocks = appendAgentRunBlocks(buildRenderBlocks(result), result.agentRuns);
  return {
    role: 'assistant',
    content: content.length ? content : [{ type: 'text', text: result.text || '' }],
    ...(model ? { model } : {}),
    ...(sources.length ? { sources } : {}),
    ...(searchCount ? { searchCount } : {}),
    ...(blocks ? { blocks } : {}),
  };
}
