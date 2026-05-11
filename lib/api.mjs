// OpenAI Chat Completions streaming API client.

function toolDefinitions(tools = []) {
  if (!tools?.length) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || tool.parameters,
    },
  }));
}

function parseJsonObject(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('\n');
}

function normalizeMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: String(message.content || ''),
      });
      continue;
    }

    if (message.tool_calls) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        tool_calls: message.tool_calls,
      });
      continue;
    }

    const normalized = {
      role: message.role,
      content: contentText(message.content),
    };
    if (message.role === 'assistant' && message.reasoning_content) {
      normalized.reasoning_content = message.reasoning_content;
    }
    if (normalized.content || normalized.role === 'system') out.push(normalized);
  }
  return out;
}

export function assistantMessage(result, model) {
  return {
    role: 'assistant',
    content: result.text || '',
    ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
    ...(model ? { model } : {}),
  };
}

function parseOpenAIEvent(event, state) {
  if (!event.choices) return;
  const choice = event.choices[0];
  if (!choice) return;

  if (choice.delta?.content) {
    const delta = choice.delta.content;
    state.buffer += delta;
    state.onDelta(delta, state.buffer);
  }

  const reasoningDelta = choice.delta?.reasoning_content
    || choice.message?.reasoning_content
    || choice.reasoning_content;
  if (reasoningDelta) {
    state.reasoningContent += reasoningDelta;
  }

  if (choice.delta?.tool_calls) {
    for (const deltaCall of choice.delta.tool_calls) {
      const index = deltaCall.index ?? state.toolCalls.length;
      const call = state.toolCalls[index] || {
        id: deltaCall.id,
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (deltaCall.id) call.id = deltaCall.id;
      if (deltaCall.type) call.type = deltaCall.type;
      if (deltaCall.function?.name) call.function.name += deltaCall.function.name;
      if (deltaCall.function?.arguments) call.function.arguments += deltaCall.function.arguments;
      state.toolCalls[index] = call;
    }
  }

  if (choice.finish_reason) {
    state.stopReason = choice.finish_reason;
    state.usage = event.usage || state.usage;
    state.onDone(state.buffer, choice.finish_reason, event.usage);
  }
}

export async function streamChat(config, messages, onDelta, onDone, onError) {
  const {
    baseUrl = 'https://api.openai.com',
    apiKey,
    model = 'gpt-4o-mini',
    maxTokens = 8192,
    extraHeaders = {},
    tools = [],
    toolChoice,
  } = config;

  const base = baseUrl.replace(/\/+$/, '');
  const toolsForRequest = toolDefinitions(tools);
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: normalizeMessages(messages),
    ...(toolsForRequest ? { tools: toolsForRequest } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
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
      buffer: '',
      reasoningContent: '',
      toolCalls: [],
      stopReason: null,
      usage: null,
      onDelta,
      onDone: guardedDone,
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const lines = rawBuffer.split('\n');
      rawBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;

        try {
          parseOpenAIEvent(JSON.parse(jsonStr), state);
        } catch {
          // Ignore malformed provider chunks.
        }
      }
    }

    guardedDone(state.buffer, 'end_turn', null);
    return {
      text: state.buffer,
      reasoningContent: state.reasoningContent,
      stopReason: state.stopReason || 'end_turn',
      usage: state.usage,
      toolCalls: state.toolCalls
        .filter(call => call?.function?.name)
        .map(call => ({
          id: call.id,
          name: call.function.name,
          input: parseJsonObject(call.function.arguments),
          arguments: call.function.arguments,
        })),
    };
  } catch (err) {
    onError(err);
  }
  return { text: '', stopReason: 'error', usage: null, toolCalls: [] };
}
