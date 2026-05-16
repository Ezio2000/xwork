import { parseSseChunk } from './sse-parser.mjs';
import { anthropicTools, buildSystemPrompt, normalizeMessages } from './message-normalizer.mjs';

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
      block.type = block.type || 'text';
      block.text = (block.text || '') + (delta.text || '');
      state.onDelta(delta.text || '', state.text + (delta.text || ''));
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
