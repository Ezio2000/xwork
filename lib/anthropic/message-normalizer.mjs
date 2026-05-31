import { getWorkspaceInfo } from '../workspace-root.mjs';

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('\n');
}

const LARGE_TOOL_RESULT_LIMIT = 50_000;

function trimString(value, limit = 4000) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n... [content truncated]`;
}

function compactAssets(assets, limit = 50) {
  if (!Array.isArray(assets)) return undefined;
  return assets.slice(0, limit).map(asset => {
    if (!asset || typeof asset !== 'object') return null;
    return Object.fromEntries(Object.entries({
      token: asset.token || asset.fileToken || asset.file_token,
      name: asset.name || asset.filename || asset.title,
      mimeType: asset.mimeType || asset.mime_type || asset.contentType,
      size: asset.size,
      width: asset.width,
      height: asset.height,
      blockId: asset.blockId || asset.block_id,
      blockType: asset.blockType || asset.block_type,
    }).filter(([, item]) => item !== undefined && item !== null && item !== ''));
  }).filter(Boolean);
}

function sanitizeToolResultContent(content) {
  const text = String(content || '');
  if (!text) return '';
  if (!/contentBase64|data:image\/|iVBORw0KGgo|\/9j\/|R0lGODlh/.test(text) && text.length <= LARGE_TOOL_RESULT_LIMIT) {
    return text;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const summary = {
        action: parsed.action,
        resourceType: parsed.resourceType,
        fileToken: parsed.fileToken || parsed.mediaToken,
        contentType: parsed.contentType,
        contentDisposition: parsed.contentDisposition,
        size: parsed.size,
        filename: parsed.filename,
        filePath: parsed.filePath,
        previewUrl: parsed.previewUrl || parsed.url,
        blockCount: parsed.blockCount,
        contentLength: parsed.contentLength,
        assetCount: parsed.assetCount || (Array.isArray(parsed.assets) ? parsed.assets.length : undefined),
        assets: compactAssets(parsed.assets),
        contentPreview: parsed.content || parsed.contentPreview ? trimString(parsed.content || parsed.contentPreview) : undefined,
        omitted: 'large binary/base64 content was removed from replay context',
      };
      return JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined && value !== '')));
    }
  } catch {}

  return `[large tool result omitted from replay context: ${text.length} chars]`;
}

function systemTextFromMessages(messages) {
  return messages
    .filter(message => message?.role === 'system')
    .map(message => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}

function workspaceSystemText() {
  const info = getWorkspaceInfo();
  const parts = [
    '# Workspace',
    `Current workspace root: ${info.root}.`,
    info.label ? `Workspace label: ${info.label}.` : '',
    `Workspace mode: ${info.isDefault ? 'xwork install directory' : 'mounted external directory'}.`,
    `xwork install directory: ${info.projectRoot}.`,
    'Workspace file tools resolve relative paths from the current workspace root.',
  ].filter(Boolean);
  return parts.join('\n');
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
      '- For non-trivial work, do not default to doing everything yourself. Decide whether independent expert agents would improve speed, coverage, or confidence before you start collecting all evidence locally.',
      '- You are responsible for synthesis. Expert agents gather evidence, inspect scoped areas, verify assumptions, or perform bounded work; you integrate their results and produce the final user-facing answer.',
      '',
      '# Tool Use',
      '- You can write text and call tools in the same response. You do NOT need to finish all tool calls before writing any text.',
      '- Unless the user explicitly asks you to run silently or avoid commentary, you MUST write one brief progress sentence before any tool call. Put that sentence before the tool call in the same assistant response.',
      '- You can call multiple tools in one response. When tool calls are independent, call them in parallel in the same assistant turn.',
      '- If some tool calls depend on previous results, run them sequentially.',
      '- Never claim that you opened, clicked, typed, searched, read, wrote, ran, fetched, uploaded, downloaded, screenshotted, waited for, inspected, or otherwise operated on external state unless the corresponding structured tool call appears in the same assistant turn or an earlier tool result proves it happened.',
      '- If you need a tool but cannot call it, say that you cannot perform the action; do not narrate or simulate the action as completed.',
      '- **ask_user**: Prefer asking the human over guessing. When scope, environment, tradeoffs, risk, or missing facts are unclear, call ask_user before irreversible tools. After ask_user, do not call other tools in the same turn until you receive the answer.',
      '- Do not duplicate work already delegated to an expert agent. If an expert agent is researching a topic, do not perform the same search or inspection yourself unless you are intentionally spot-checking its result.',
      '',
      '# Expert Agent Delegation',
      '- Treat delegate_task as the standard execution path for complex, multi-step, multi-topic, parallelizable, uncertain, or verification-heavy work.',
      '- Strong delegation triggers: 3 or more independent topics, vendors, files, modules, services, logs, options, or evaluation dimensions; comparisons across alternatives; broad codebase exploration; latest-information research across multiple subjects; independent verification after implementation; or any task likely to require several separate searches or inspections.',
      '- When a task has independent workstreams, prefer launching multiple delegate_task calls in one assistant response, each with one concrete objective and a concise expected output.',
      '- Use the main thread for planning, coordination, synthesis, and small blocking checks. Use expert agents for scoped investigation, evidence gathering, verification, and separable implementation slices.',
      '- Do not delegate simple single-step answers, work that requires one continuous context, or work the user explicitly asks you to handle without delegation.',
      '',
      '# Communication',
      '- Avoid silently calling tools with no explanation. Keep the user informed of material progress, findings, changes in direction, and blockers.',
      '- Keep final answers concise unless the task requires detail. If evidence is incomplete, say what cannot be confirmed.',
      '- When explaining processes, workflows, state machines, dependencies, architectures, timelines, or interactions, prefer Mermaid diagrams when a diagram would be clearer than prose. Use fenced ```mermaid code blocks for flowcharts, sequence diagrams, state diagrams, class diagrams, ER diagrams, timelines, and Gantt charts.',
      '- Keep Mermaid diagrams syntactically valid and concise. Use simple ASCII node IDs, separate node IDs from labels, avoid unsupported Markdown inside labels, and include a short prose explanation before or after the diagram when useful.',
      '- For Mermaid labels, use short plain text only. Avoid emoji, checkmarks, bullet lists, long multi-line labels, dense comparison content, raw HTML, Markdown tables/lists, and checklist-style content inside nodes or edge labels; put those details in prose or a table outside the diagram.',
      '- For Mermaid flowcharts, quote labels that contain brackets, pipes, braces, angle brackets, comparisons, equals signs, array indexes, or non-trivial punctuation. Prefer A["arr[j] > arr[j+1]?"] over A[arr[j] > arr[j+1]?]. Do not HTML-escape operators inside Mermaid code fences.',
      '- When presenting data that would benefit from interactive charts (time series, comparisons, distributions, proportions, multi-dimensional data), generate ECharts option JSON in a fenced ```echarts code block. The JSON should be a valid ECharts option object with title, xAxis/yAxis (or other coordinate systems), series, and other relevant configuration. Include a brief prose explanation before or after the chart.',
      '- When writing mathematical expressions, wrap LaTeX in $...$ for inline math and $$...$$ for display math. For example: $E = mc^2$ or $$\\sin\\left(\\frac{\\pi}{2}\\right) = 1$$.',
    ].join('\n'),
  ];

  // Keep stable, globally shared text before per-request or per-subagent text.
  // DeepSeek-style prefix caching only hits identical prefixes from token 0.
  const tools = config?.tools || [];
  for (const tool of tools) {
    if (typeof tool.systemPrompt === 'function') {
      const prompt = tool.systemPrompt(tool);
      if (prompt) parts.push(prompt);
    }
  }

  const existingSystem = systemTextFromMessages(messages);
  if (existingSystem) parts.push(existingSystem);

  if (config?.model) parts.push(`You are currently running as: ${config.model}.`);
  parts.push(workspaceSystemText());
  parts.push(`Current date: ${new Date().toISOString().slice(0, 10)}.`);

  return parts.join('\n\n');
}

export function normalizeContentBlocks(content, role) {
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part?.type === 'text') return { type: 'text', text: part.text || '' };
        if (role === 'user' && part?.type === 'image') {
          if (part.source?.type === 'base64') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.source.media_type || part.mediaType || 'image/png',
                data: part.source.data || '',
              },
            };
          }
          if (part.source?.type === 'url') {
            return {
              type: 'image',
              source: {
                type: 'url',
                url: part.source.url || part.url || '',
              },
            };
          }
          return null;
        }
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
        if (role === 'assistant' && part?.type === 'server_tool_use') {
          return {
            type: 'server_tool_use',
            id: part.id,
            name: part.name,
            input: part.input || {},
          };
        }
        if (role === 'assistant' && part?.type === 'web_search_tool_result') {
          return {
            type: 'web_search_tool_result',
            tool_use_id: part.tool_use_id,
            content: Array.isArray(part.content) ? part.content : [],
          };
        }
        if (role === 'user' && part?.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: part.tool_use_id,
            content: sanitizeToolResultContent(part.content),
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
