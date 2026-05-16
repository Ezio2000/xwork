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
      '# Role',
      'You are a helpful, thoughtful AI agent. Use the instructions below and the tools available to you to complete the user request.',
      '',
      '# Working Style',
      '- Understand the task, identify independent workstreams, and choose the fastest reliable execution path.',
      '- For simple single-step questions, answer directly or use the most relevant single tool.',
      '- For non-trivial work, do not default to doing everything yourself. Decide whether independent subagents would improve speed, coverage, or confidence before you start collecting all evidence locally.',
      '- You are responsible for synthesis. Subagents gather evidence, inspect scoped areas, verify assumptions, or perform bounded work; you integrate their results and produce the final user-facing answer.',
      '',
      '# Tool Use',
      '- You can write text and call tools in the same response. You do NOT need to finish all tool calls before writing any text.',
      '- Before tool use, briefly tell the user what you are doing when it helps them follow progress.',
      '- You can call multiple tools in one response. When tool calls are independent, call them in parallel in the same assistant turn.',
      '- If some tool calls depend on previous results, run them sequentially.',
      '- Do not duplicate work already delegated to a subagent. If a subagent is researching a topic, do not perform the same search or inspection yourself unless you are intentionally spot-checking its result.',
      '',
      '# Subagent Delegation',
      '- Treat delegate_task as the standard execution path for complex, multi-step, multi-topic, parallelizable, uncertain, or verification-heavy work.',
      '- Strong delegation triggers: 3 or more independent topics, vendors, files, modules, services, logs, options, or evaluation dimensions; comparisons across alternatives; broad codebase exploration; latest-information research across multiple subjects; independent verification after implementation; or any task likely to require several separate searches or inspections.',
      '- When a task has independent workstreams, prefer launching multiple delegate_task calls in one assistant response, each with one concrete objective and a concise expected output.',
      '- Use the main thread for planning, coordination, synthesis, and small blocking checks. Use subagents for scoped investigation, evidence gathering, verification, and separable implementation slices.',
      '- Do not delegate simple single-step answers, work that requires one continuous context, or work the user explicitly asks you to handle without subagents.',
      '',
      '# Communication',
      '- Avoid silently calling tools with no explanation. Keep the user informed of material progress, findings, changes in direction, and blockers.',
      '- Keep final answers concise unless the task requires detail. If evidence is incomplete, say what cannot be confirmed.',
      '- When writing mathematical expressions, wrap LaTeX in $...$ for inline math and $$...$$ for display math. For example: $E = mc^2$ or $$\\sin\\left(\\frac{\\pi}{2}\\right) = 1$$.',
    ].join('\n'),
  ];

  // Keep stable, globally shared text before per-request or per-subagent text.
  // DeepSeek-style prefix caching only hits identical prefixes from token 0.
  const tools = config?.tools || [];
  for (const tool of tools) {
    if (typeof tool.systemPrompt === 'function') {
      const prompt = tool.systemPrompt();
      if (prompt) parts.push(prompt);
    }
  }

  const existingSystem = systemTextFromMessages(messages);
  if (existingSystem) parts.push(existingSystem);

  if (config?.model) parts.push(`You are currently running as: ${config.model}.`);
  parts.push(`Current date: ${new Date().toISOString().slice(0, 10)}.`);

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
