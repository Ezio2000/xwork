export function textFromContent(content) {
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

export function buildSystemPrompt(messages, config) {
  const parts = [
    [
      'You are a helpful, thoughtful assistant. You have access to tools that can search the web, check the current time, and more.',
      'When answering questions, you can write text and call tools in the same response. You do NOT need to finish all tool calls before writing any text. Instead:',
      '- Briefly explain what you are about to do, then call the tool.',
      '- While waiting for results, you may continue thinking or writing.',
      '- When results arrive, integrate them naturally into your answer.',
      '- You can interleave multiple rounds of text ↔ tool calls within a single conversation turn.',
      'Avoid the pattern of silently calling tools with no explanation. Always keep the user informed of what you are doing.',
      'When writing mathematical expressions, wrap LaTeX in $...$ for inline math and $$...$$ for display math. For example: $E = mc^2$ or $$\\sin\\left(\\frac{\\pi}{2}\\right) = 1$$.',
    ].join('\n'),
    `Current date: ${new Date().toISOString().slice(0, 10)}.`,
    config?.model ? `You are currently running as: ${config.model}.` : '',
  ];
  const existingSystem = systemTextFromMessages(messages);
  if (existingSystem) parts.push(existingSystem);
  const tools = config?.tools || [];
  for (const tool of tools) {
    if (typeof tool.systemPrompt === 'function') {
      const prompt = tool.systemPrompt();
      if (prompt) parts.push(prompt);
    }
  }
  return parts.join('\n\n');
}

export function normalizeContentBlocks(content, role) {
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

export function normalizeMessages(messages) {
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

export function anthropicTools(tools = []) {
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
