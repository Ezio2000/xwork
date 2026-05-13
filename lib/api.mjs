// Anthropic Messages streaming API client.

function parseSseChunk(rawBuffer) {
  const events = [];
  const parts = rawBuffer.split('\n\n');
  const rest = parts.pop() || '';

  for (const part of parts) {
    let eventName = '';
    const dataLines = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const data = dataLines.join('\n');
    if (data === '[DONE]') continue;
    try {
      events.push({ eventName, data: JSON.parse(data) });
    } catch {
      // Ignore malformed provider chunks.
    }
  }

  return { events, rest };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('\n');
}

function systemTextFromMessages(messages) {
  return messages
    .filter(message => message?.role === 'system')
    .map(message => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}

function buildSystemPrompt(messages, tools) {
  const parts = [
    [
      'You are a helpful, thoughtful assistant. You have access to tools that can search the web, check the current time, and more.',
      'When answering questions, you can write text and call tools in the same response. You do NOT need to finish all tool calls before writing any text. Instead:',
      '- Briefly explain what you are about to do, then call the tool.',
      '- While waiting for results, you may continue thinking or writing.',
      '- When results arrive, integrate them naturally into your answer.',
      '- You can interleave multiple rounds of text ↔ tool calls within a single conversation turn.',
      'Avoid the pattern of silently calling tools with no explanation. Always keep the user informed of what you are doing.',
    ].join('\n'),
    `Current date: ${new Date().toISOString().slice(0, 10)}.`,
  ];
  const existingSystem = systemTextFromMessages(messages);
  if (existingSystem) parts.push(existingSystem);
  for (const tool of tools) {
    if (typeof tool.systemPrompt === 'function') {
      const prompt = tool.systemPrompt();
      if (prompt) parts.push(prompt);
    }
  }
  return parts.join('\n\n');
}

function normalizeContentBlocks(content, role) {
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part?.type === 'text') return { type: 'text', text: part.text || '' };
        if (role === 'assistant' && part?.type === 'thinking') {
          return {
            type: 'thinking',
            thinking: part.thinking || '',
            ...(part.signature ? { signature: part.signature } : {}),
          };
        }
        if (role === 'assistant' && part?.type === 'redacted_thinking') {
          return {
            type: 'redacted_thinking',
            data: part.data || '',
          };
        }
        if (role === 'assistant' && part?.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.input || {},
          };
        }
        if (role === 'user' && part?.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: part.tool_use_id,
            content: part.content || '',
            ...(part.is_error ? { is_error: true } : {}),
          };
        }
        return null;
      })
      .filter(Boolean);
  }
  const text = textFromContent(content);
  return text ? [{ type: 'text', text }] : [];
}

function normalizeMessages(messages) {
  const out = [];

  for (const message of messages) {
    if (!message || !message.role) continue;

    if (message.role === 'system') continue;

    if (message.role === 'assistant') {
      const content = normalizeContentBlocks(message.content, 'assistant');
      if (content.length) {
        out.push({ role: 'assistant', content });
      }
      continue;
    }

    if (message.role === 'user') {
      const content = normalizeContentBlocks(message.content, 'user');
      if (content.length) {
        out.push({ role: 'user', content });
      }
    }
  }

  return out;
}

function anthropicTools(tools = []) {
  if (!tools?.length) return undefined;

  return tools.map(tool => {
    if (tool.adapter === 'anthropic_server') {
      return {
        type: tool.apiToolType || tool.type,
        name: tool.name,
        ...(tool.maxUses ? { max_uses: tool.maxUses } : {}),
        ...(tool.allowedDomains?.length ? { allowed_domains: tool.allowedDomains } : {}),
        ...(tool.blockedDomains?.length ? { blocked_domains: tool.blockedDomains } : {}),
      };
    }

    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema || tool.parameters || {
        type: 'object',
        properties: {},
      },
    };
  });
}

function uniqueSources(sources = []) {
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source) continue;
    const key = source.url || `${source.title}|${source.pageAge}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
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

  // Generic dispatch: try each tool's parseStreamResult
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

function buildBlocksFromResult(result) {
  const blocks = [];
  let textBuf = '';

  function flushText() {
    const t = textBuf.trim();
    if (t) blocks.push({ type: 'text', content: t });
    textBuf = '';
  }

  const resultByCallId = {};
  for (const event of (result.serverToolEvents || [])) {
    if (event.phase === 'result') {
      resultByCallId[event.id] = event;
    }
  }

  for (const part of (result.content || [])) {
    if (part.type === 'text') {
      textBuf += (textBuf ? '\n' : '') + (part.text || '');
    } else if (part.type === 'server_tool_use' || part.type === 'tool_use') {
      flushText();
      const resEvent = resultByCallId[part.id || part.tool_use_id];
      if (resEvent?.renderType === 'source-cards' && resEvent.data?.sources?.length) {
        blocks.push({ type: 'sources', sources: resEvent.data.sources, searchCount: 1 });
        blocks.push({ type: 'text', content: '' });
      }
    }
  }
  flushText();

  // Drop trailing empty text block
  while (blocks.length && blocks[blocks.length - 1].type === 'text' && !blocks[blocks.length - 1].content) {
    blocks.pop();
  }

  return blocks.length ? blocks : undefined;
}

export function assistantMessage(result, model) {
  const sources = uniqueSources([
    ...(result.sources || []),
    ...((result.serverToolEvents || []).flatMap(event => event.data?.sources || [])),
  ]);
  const searchCount = (result.serverToolEvents || []).filter(e => e.phase === 'result' && e.renderType === 'source-cards').length;
  const content = normalizeContentBlocks(result.content?.length
    ? result.content
    : [{ type: 'text', text: result.text || '' }], 'assistant')
    .filter(part => part.type === 'text' || part.type === 'thinking' || part.type === 'redacted_thinking');
  const blocks = buildBlocksFromResult(result);
  return {
    role: 'assistant',
    content: content.length ? content : [{ type: 'text', text: result.text || '' }],
    ...(model ? { model } : {}),
    ...(sources.length ? { sources } : {}),
    ...(searchCount ? { searchCount } : {}),
    ...(blocks ? { blocks } : {}),
  };
}

export async function streamChat(config, messages, onDelta, onThinkingDelta, onDone, onError, onServerToolEvent) {
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
  const system = buildSystemPrompt(messages, tools);
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
