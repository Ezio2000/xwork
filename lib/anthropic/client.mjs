import { parseSseChunk } from './sse-parser.mjs';
import { anthropicTools, buildSystemPrompt, normalizeMessages } from './message-normalizer.mjs';

const DSML_TOOL_CALL_MARKERS = [
  {
    start: '<||DSML||tool_calls>',
    end: '</||DSML||tool_calls>',
  },
  {
    start: '<｜｜DSML｜｜tool_calls>',
    end: '</｜｜DSML｜｜tool_calls>',
  },
];
const DSML_MARKER_TAIL_LENGTH = Math.max(
  ...DSML_TOOL_CALL_MARKERS.flatMap(marker => [marker.start.length, marker.end.length]),
) - 1;

function createDsmlTextFilter() {
  return {
    buffer: '',
    inside: false,
    hiddenText: '',
    hiddenBlocks: 0,
    toolNames: new Set(),
  };
}

function findDsmlMarker(buffer, key) {
  let best = null;
  for (const marker of DSML_TOOL_CALL_MARKERS) {
    const idx = buffer.indexOf(marker[key]);
    if (idx === -1) continue;
    if (!best || idx < best.idx) best = { idx, marker };
  }
  return best;
}

function recordHiddenDsml(filter, text = '') {
  const value = String(text || '');
  if (!value) return;
  filter.hiddenText += value;
  const normalized = value.replace(/\uFF5C/g, '|');
  const invokeRe = /<\|\|DSML\|\|invoke\b[^>]*\bname=(["'])(.*?)\1/gi;
  let match;
  while ((match = invokeRe.exec(normalized))) {
    if (match[2]) filter.toolNames.add(match[2]);
  }
}

function processVisibleText(filter, text, { final = false } = {}) {
  filter.buffer += String(text || '');
  let visible = '';

  while (filter.buffer) {
    if (filter.inside) {
      const endMatch = findDsmlMarker(filter.buffer, 'end');
      if (!endMatch) {
        if (final) {
          recordHiddenDsml(filter, filter.buffer);
          filter.buffer = '';
          filter.inside = false;
        } else if (filter.buffer.length > DSML_MARKER_TAIL_LENGTH) {
          const hiddenLength = filter.buffer.length - DSML_MARKER_TAIL_LENGTH;
          recordHiddenDsml(filter, filter.buffer.slice(0, hiddenLength));
          filter.buffer = filter.buffer.slice(hiddenLength);
        }
        return visible;
      }
      recordHiddenDsml(filter, filter.buffer.slice(0, endMatch.idx));
      filter.buffer = filter.buffer.slice(endMatch.idx + endMatch.marker.end.length);
      filter.inside = false;
      continue;
    }

    const startMatch = findDsmlMarker(filter.buffer, 'start');
    if (startMatch) {
      visible += filter.buffer.slice(0, startMatch.idx);
      filter.buffer = filter.buffer.slice(startMatch.idx + startMatch.marker.start.length);
      filter.inside = true;
      filter.hiddenBlocks += 1;
      continue;
    }

    if (final || filter.buffer.length <= DSML_MARKER_TAIL_LENGTH) {
      if (final) {
        visible += filter.buffer;
        filter.buffer = '';
      }
      return visible;
    }

    const flushLength = filter.buffer.length - DSML_MARKER_TAIL_LENGTH;
    visible += filter.buffer.slice(0, flushLength);
    filter.buffer = filter.buffer.slice(flushLength);
  }

  return visible;
}

function dsmlLeakError(filter, state) {
  if (!filter.hiddenBlocks) return null;

  const names = [...filter.toolNames].filter(Boolean).join(', ') || 'unknown tool';
  return new Error(
    `The model emitted DSML tool-call markup as visible text (${names}), but the provider did not return a structured tool call or server-tool result. The response was stopped to avoid silently completing an empty answer.`,
  );
}

function serverToolEvent(block, tools = []) {
  if (block.type === 'server_tool_use') {
    return {
      phase: 'call',
      id: block.id,
      name: block.name,
      input: block.input || {},
    };
  }

  for (const tool of tools) {
    if (typeof tool.parseStreamResult === 'function') {
      const parsed = tool.parseStreamResult(block);
      if (parsed) {
        return {
          phase: 'result',
          id: block.tool_use_id,
          name: tool.name,
          isError: (parsed.data?.errors?.length > 0),
          errorCode: parsed.data?.errors?.[0],
          ...parsed,
        };
      }
    }
  }

  return null;
}

function collectDoneBlock(state, block) {
  if (!block) return;
  const normalized = block;

  if (normalized.type === 'text') {
    state.text += normalized.text || '';
  } else if (normalized.type === 'thinking') {
    state.reasoningContent += normalized.thinking || '';
  } else if (normalized.type === 'tool_use') {
    state.toolCalls.push({
      id: normalized.id,
      name: normalized.name,
      input: normalized.input || {},
      arguments: JSON.stringify(normalized.input || {}),
    });
  }

  const serverEvent = serverToolEvent(normalized, state.tools);
  if (serverEvent) {
    state.serverToolEvents.push(serverEvent);
    state.onServerToolEvent?.(serverEvent);
  }

  state.content.push(normalized);
}

function parseAnthropicEvent(event, state) {
  const data = event.data;
  if (!data?.type) return;

  if (data.type === 'message_start') {
    state.message = data.message || null;
    state.usage = data.message?.usage || state.usage;
    return;
  }

  if (data.type === 'content_block_start') {
    state.blocks.set(data.index, data.content_block || {});
    return;
  }

  if (data.type === 'content_block_delta') {
    const block = state.blocks.get(data.index) || {};
    const delta = data.delta || {};

    if (delta.type === 'text_delta') {
      const text = processVisibleText(state.dsmlTextFilter, delta.text || '');
      block.type = block.type || 'text';
      block.text = (block.text || '') + text;
      if (text) {
        state.onDelta(text, state.text + text);
      }
    } else if (delta.type === 'thinking_delta') {
      block.type = block.type || 'thinking';
      block.thinking = (block.thinking || '') + (delta.thinking || '');
      state.onThinkingDelta?.(block.thinking);
    } else if (delta.type === 'signature_delta') {
      block.signature = (block.signature || '') + (delta.signature || '');
    } else if (delta.type === 'input_json_delta') {
      block.partial_json = (block.partial_json || '') + (delta.partial_json || '');
    }

    state.blocks.set(data.index, block);
    return;
  }

  if (data.type === 'content_block_stop') {
    const block = state.blocks.get(data.index);
    if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && block.partial_json) {
      try {
        block.input = JSON.parse(block.partial_json);
      } catch {
        block.input = block.input || {};
      }
    }
    if (block?.type === 'text') {
      const text = processVisibleText(state.dsmlTextFilter, '', { final: true });
      if (text) {
        block.text = (block.text || '') + text;
        state.onDelta(text, state.text + text);
      }
    }
    collectDoneBlock(state, block);
    state.blocks.delete(data.index);
    return;
  }

  if (data.type === 'message_delta') {
    state.stopReason = data.delta?.stop_reason || state.stopReason;
    state.usage = data.usage || state.usage;
  }
}

export async function streamChat(
  config,
  messages,
  onDelta,
  onThinkingDelta,
  onDone,
  onError,
  onServerToolEvent,
  options = {},
) {
  const {
    baseUrl = 'https://api.deepseek.com/anthropic',
    apiKey,
    model = 'deepseek-v4-flash',
    maxTokens = 8192,
    extraHeaders = {},
    tools = [],
  } = config;

  const base = baseUrl.replace(/\/+$/, '');
  const toolsForRequest = anthropicTools(tools);
  const system = buildSystemPrompt(messages, config);
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    ...(system ? { system } : {}),
    messages: normalizeMessages(messages),
    ...(toolsForRequest ? { tools: toolsForRequest } : {}),
  };

  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `API error ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errMsg;
      } catch {}
      throw new Error(errMsg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let rawBuffer = '';
    let finished = false;
    const guardedDone = (...args) => {
      if (finished) return;
      finished = true;
      onDone(...args);
    };
    const state = {
      message: null,
      text: '',
      reasoningContent: '',
      content: [],
      toolCalls: [],
      serverToolEvents: [],
      blocks: new Map(),
      stopReason: null,
      usage: null,
      onDelta,
      onThinkingDelta,
      onServerToolEvent,
      tools,
      dsmlTextFilter: createDsmlTextFilter(),
    };

    while (true) {
      if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(rawBuffer);
      rawBuffer = parsed.rest;
      for (const event of parsed.events) {
        parseAnthropicEvent(event, state);
      }
    }

    const dsmlError = dsmlLeakError(state.dsmlTextFilter, state);
    if (dsmlError) throw dsmlError;

    guardedDone(state.text, state.stopReason || 'end_turn', state.usage);
    return {
      text: state.text,
      reasoningContent: state.reasoningContent,
      content: state.content,
      stopReason: state.stopReason || 'end_turn',
      usage: state.usage,
      toolCalls: state.toolCalls,
      serverToolEvents: state.serverToolEvents,
    };
  } catch (err) {
    onError(err);
  }

  return {
    text: '',
    reasoningContent: '',
    content: [],
    stopReason: 'error',
    usage: null,
    toolCalls: [],
    serverToolEvents: [],
  };
}
