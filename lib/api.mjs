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

function zonedDateParts(date, timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = type => parts.find(part => part.type === type)?.value || '';
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
  };
}

function shiftedDateParts(days, timeZone = 'Asia/Shanghai') {
  return zonedDateParts(new Date(Date.now() + days * 24 * 60 * 60 * 1000), timeZone);
}

function formatZhDate(parts) {
  return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日`;
}

function formatEnDate(parts) {
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long' })
    .format(new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))));
  return `${monthName} ${Number(parts.day)}, ${parts.year}`;
}

function webSearchPolicyPrompt() {
  const timeZone = 'Asia/Shanghai';
  const now = new Date();
  const today = zonedDateParts(now, timeZone);
  const yesterday = shiftedDateParts(-1, timeZone);
  const weekAgo = shiftedDateParts(-7, timeZone);
  const nowText = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
    hour12: false,
  }).format(now);

  return [
    'Web search policy:',
    `- Current time is ${nowText} (${timeZone}).`,
    `- For latest, today, recent, current, breaking, or time-sensitive questions, use web_search and put a date range directly in the query. Prefer broad ranges, not exact timestamps: "past 24 hours", "since ${formatEnDate(yesterday)}", "from ${formatEnDate(weekAgo)} to ${formatEnDate(today)}"; for Chinese results also use "过去24小时", "今日", "自${formatZhDate(yesterday)}以来".`,
    '- Use one targeted web_search query first. Use a second query only when the first result set is off-domain, stale, or ambiguous. Avoid repeated searches with the same meaning.',
    '- For official information, include the official site or domain token in the query itself, because provider-side domain filters may not be strict.',
    '- If search results do not show enough date evidence to confirm freshness, explicitly say that the newest/latest status cannot be confirmed from the returned sources.',
    '- web_search is limited to 5 uses per conversation. Plan your queries carefully — use at most 1-2 searches for straightforward questions. If you receive a "max_uses_exceeded" error, you have exhausted the limit: STOP calling web_search immediately and answer using the results you already have. Never retry web_search after a max_uses_exceeded error.',
    '- Do not use web fetch unless the user asks for it; rely on web_search result titles, URLs, snippets, and dates.',
  ].join('\n');
}

function hasWebSearchTool(tools = []) {
  return tools.some(tool => tool?.name === 'web_search' || tool?.type === 'web_search_20250305');
}

function buildSystemPrompt(messages, tools) {
  const parts = [];
  const existingSystem = systemTextFromMessages(messages);
  if (existingSystem) parts.push(existingSystem);
  if (hasWebSearchTool(tools)) parts.push(webSearchPolicyPrompt());
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
        type: tool.type,
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

function sourceFromSearchResult(item) {
  if (!item || item.type !== 'web_search_result') return null;
  return {
    title: item.title || '',
    url: item.url || '',
    pageAge: item.page_age || item.pageAge || '',
    snippet: item.snippet || item.description || item.text || '',
  };
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

function serverToolEvent(block) {
  if (block.type === 'server_tool_use') {
    return {
      phase: 'call',
      id: block.id,
      name: block.name,
      input: block.input || {},
    };
  }

  if (block.type === 'web_search_tool_result') {
    const content = Array.isArray(block.content) ? block.content : [];
    const errors = Array.isArray(block.content)
      ? block.content.filter(item => item?.type === 'web_search_tool_result_error')
      : [];
    const sources = uniqueSources(content.map(sourceFromSearchResult));
    return {
      phase: 'result',
      id: block.tool_use_id,
      name: 'web_search',
      isError: errors.length > 0,
      errorCode: errors[0]?.error_code,
      resultCount: sources.length,
      sources,
    };
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

  const serverEvent = serverToolEvent(normalized);
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

export function assistantMessage(result, model) {
  const sources = uniqueSources([
    ...(result.sources || []),
    ...((result.serverToolEvents || []).flatMap(event => event.sources || [])),
  ]);
  const content = normalizeContentBlocks(result.content?.length
    ? result.content
    : [{ type: 'text', text: result.text || '' }], 'assistant')
    .filter(part => part.type === 'text' || part.type === 'thinking' || part.type === 'redacted_thinking');
  return {
    role: 'assistant',
    content: content.length ? content : [{ type: 'text', text: result.text || '' }],
    ...(model ? { model } : {}),
    ...(sources.length ? { sources } : {}),
  };
}

export async function streamChat(config, messages, onDelta, onDone, onError, onServerToolEvent) {
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
      onServerToolEvent,
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
