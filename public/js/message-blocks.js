import { STREAM_AGENT_EVENT_TYPES, streamAgentEventType } from './stream-events.js';
import { buildRunningToolBlock } from './tool-block-collapse.js';
import { applyBlockOptions } from './tool-ui-registry.js';

export function stripSearchQueryText(text) {
  return String(text || '').replace(/^Search results for query: .*/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function stripLeadingNewlines(text) {
  return String(text || '').replace(/^\n+/, '');
}

export function mergeSources(existing, incoming) {
  const out = [...existing];
  const seen = new Set(out.map(source => source.url || `${source.title}|${source.pageAge}`));
  for (const source of incoming || []) {
    if (!source || (!source.title && !source.url)) continue;
    const key = source.url || `${source.title}|${source.pageAge}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function codeBlock(label, value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  const escapedFence = content.replace(/```/g, '`\\`\\`');
  return `**${label}**\n\n\`\`\`json\n${escapedFence}\n\`\`\``;
}

function renderBlockFromResult(renderType, data) {
  if (!renderType || !data) return null;
  return applyBlockOptions({ type: renderType, ...data, collapsed: true });
}

function renderBlockFromOutput(output) {
  if (!output || typeof output !== 'object') return null;
  if (Array.isArray(output.sources) && output.sources.length) {
    return { type: 'source-cards', sources: output.sources, searchCount: output.searchCount || 0 };
  }
  if (Array.isArray(output.uuids)) {
    return { type: 'uuid-list', uuids: output.uuids, count: output.count ?? output.uuids.length };
  }
  return null;
}

export function subagentEventToBlocks(event) {
  const type = streamAgentEventType(event);
  if (
    type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_DELTA
    || type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_THINKING
    || type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_START
  ) return [];

  if (type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_TOOL_CALL) {
    return [buildRunningToolBlock({
      id: event.toolCallId,
      name: event.name,
      input: event.input || {},
    })];
  }

  if (type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_TOOL_RESULT) {
    const rendered = renderBlockFromResult(event.renderType, event.data) || renderBlockFromOutput(event.output);
    if (rendered) return [rendered];
    if (!event.isError) return [];
    const output = event.isError ? (event.output || event.error || 'Tool error') : (event.output ?? `${Number(event.durationMs || 0)}ms`);
    return [{ type: 'text', content: codeBlock(`Tool result · ${event.name || 'tool'}`, output) }];
  }

  if (type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_SERVER_TOOL) {
    const serverEvent = event.event || {};
    const name = serverEvent.name || event.name || 'server tool';
    if (serverEvent.phase === 'call') {
      return [buildRunningToolBlock({
        id: serverEvent.id,
        name,
        input: serverEvent.input || {},
      })];
    }
    if (serverEvent.phase === 'result') {
      const rendered = renderBlockFromResult(serverEvent.renderType, serverEvent.data) || renderBlockFromOutput(serverEvent.data);
      if (rendered) return [rendered];
      return [{ type: 'text', content: codeBlock(`Server tool result · ${name}`, serverEvent.data || serverEvent.errorCode || {}) }];
    }
  }

  if (type === STREAM_AGENT_EVENT_TYPES.SUBAGENT_DONE && event.error) {
    return [{ type: 'text', content: `**Expert agent error**\n\n${event.error}` }];
  }

  return [];
}

export function messageText(message) {
  if (Array.isArray(message.blocks)) {
    const text = message.blocks
      .filter(block => block.type === 'text')
      .map(block => block.content || '')
      .join('\n');
    return message.role === 'assistant' ? stripLeadingNewlines(stripSearchQueryText(text)) : text;
  }

  const { content } = message;
  if (typeof content === 'string') {
    return message.role === 'assistant' ? stripLeadingNewlines(stripSearchQueryText(content)) : content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter(part => part?.type === 'text' && !part.text?.startsWith('Search results for query:'))
      .map(part => part.text || '')
      .join('\n');
    return message.role === 'assistant' ? stripLeadingNewlines(text) : text;
  }

  return '';
}

export function messageImages(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(part => part?.type === 'image')
    .map(part => ({
      id: part.imageId || part.source?.image_id || '',
      url: part.url || (part.imageId ? `/api/v1/images/${encodeURIComponent(part.imageId)}` : ''),
      filename: part.filename || 'image',
      mediaType: part.mediaType || '',
      size: part.size || 0,
    }))
    .filter(image => image.id || image.url);
}

export function messageSources(message) {
  if (Array.isArray(message.blocks)) {
    return message.blocks
      .filter(block => block.type === 'source-cards' || block.type === 'sources')
      .flatMap(block => block.sources || []);
  }
  return Array.isArray(message?.sources) ? message.sources : [];
}

export function contentToBlocks(content, sourcesMeta, searchCountMeta, toolResultsMap) {
  if (!Array.isArray(content)) return null;

  const blocks = [];
  let textBuf = '';

  function flushText() {
    const contentText = stripLeadingNewlines(stripSearchQueryText(textBuf));
    if (contentText) blocks.push({ type: 'text', content: contentText });
    textBuf = '';
  }

  for (const part of content) {
    if (part.type === 'text') {
      textBuf += (textBuf ? '\n' : '') + (part.text || '');
    } else if (part.type === 'web_search_tool_result') {
      flushText();
      const items = Array.isArray(part.content) ? part.content : [];
      const sources = items
        .filter(item => item?.type === 'web_search_result')
        .map(item => ({
          title: item.title || '',
          url: item.url || '',
          pageAge: item.page_age || item.pageAge || '',
          snippet: item.snippet || item.description || item.text || '',
        }))
        .filter(source => source.title || source.url);
      if (sources.length) blocks.push({ type: 'source-cards', sources, searchCount: 1, collapsed: true });
    } else if (part.type === 'tool_result' && typeof part.content === 'string') {
      flushText();
      try {
        const data = JSON.parse(part.content);
        if (Array.isArray(data.uuids)) {
          blocks.push({ type: 'uuid-list', uuids: data.uuids, count: data.count ?? data.uuids.length });
        }
      } catch {}
    } else if (part.type === 'tool_use' || part.type === 'server_tool_use') {
      flushText();
      const resultBlock = toolResultsMap?.[part.id || part.tool_use_id];
      if (resultBlock) {
        blocks.push(resultBlock);
        blocks.push({ type: 'text', content: '' });
      }
    }
  }

  flushText();
  if (!blocks.some(block => block.type === 'source-cards' || block.type === 'sources')) {
    const sources = Array.isArray(sourcesMeta) ? sourcesMeta : [];
    if (sources.length && blocks.length) {
      blocks.push({ type: 'source-cards', sources, searchCount: searchCountMeta || 0, collapsed: true });
    }
  }

  return blocks.length ? blocks : null;
}
