const DEFAULT_MAX_USES = 4;

function systemPrompt(tool = {}) {
  const effectiveMaxUses = tool.maxUses || DEFAULT_MAX_USES;
  return [
    'Web Search policy:',
    '- For latest, recent, current, breaking, or time-sensitive questions, use web_search with a broad date range directly in the query (past 24 hours, since yesterday, last 7 days).',
    '- Use one targeted web_search query first. Use a second only when the first results are off-domain, stale, or ambiguous. Avoid repeated searches with the same meaning.',
    '- For multi-topic, multi-vendor, or comparison research, consider delegate_task to split work and then synthesize results.',
    '- For official information, include the official site or domain in the query itself.',
    `- You may call web_search at most ${effectiveMaxUses} times in a single response. Once you reach the limit, stop and answer from collected results.`,
    '- After answering, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL).',
    '- When calling web_search, use the standard tool call mechanism. Do not emit internal tool-call markup or DSML tags.',
  ].join('\n');
}

function parseSourceItem(item) {
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

function parseStreamResult(block) {
  if (block.type !== 'web_search_tool_result') return null;

  const content = Array.isArray(block.content) ? block.content : [];
  const errors = content.filter(item => item?.type === 'web_search_tool_result_error');
  const sources = uniqueSources(content.map(parseSourceItem));

  return {
    renderType: 'source-cards',
    data: {
      sources,
      resultCount: sources.length,
      searchCount: 1,
      errors: errors.map(e => e.error_code || 'unknown').filter(Boolean),
    },
  };
}

export const webSearchTool = {
  id: 'web_search',
  name: 'web_search',
  title: 'Web Search',
  description: 'Search the web using a built-in search engine. For latest or recent topics, queries should include broad date ranges such as past 24 hours, since yesterday, or the last 7 days. Returns search result information including titles, URLs, page ages, and snippets.\n\nUsage notes:\n- Domain filtering is supported to include or block specific websites\n- Searches are performed automatically within a single API call',
  category: 'web',
  adapter: 'builtin',
  version: '1.1.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  maxUses: DEFAULT_MAX_USES,
  defaultConfig: {
    maxUses: DEFAULT_MAX_USES,
    allowedDomains: [],
    blockedDomains: [],
  },
  configSchema: {
    type: 'object',
    properties: {
      maxUses: {
        type: 'number',
        description: 'Maximum web_search calls Claude may make in one assistant response.',
      },
      allowedDomains: {
        type: 'array',
        description: 'Optional domain allowlist. Leave empty to allow all domains.',
        items: { type: 'string' },
      },
      blockedDomains: {
        type: 'array',
        description: 'Optional domain blocklist.',
        items: { type: 'string' },
      },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Limit searches and prefer official docs',
      config: {
        maxUses: 2,
        allowedDomains: ['docs.anthropic.com', 'openai.com'],
        blockedDomains: [],
      },
    },
  ],
  timeoutMs: 60000,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query. Include date ranges for recent information.' },
      allowed_domains: {
        type: 'array',
        description: 'Optional domain allowlist.',
        items: { type: 'string' },
      },
      blocked_domains: {
        type: 'array',
        description: 'Optional domain blocklist.',
        items: { type: 'string' },
      },
    },
    required: ['query'],
    additionalProperties: false,
  },

  systemPrompt,
  parseStreamResult,

  validate({ query }) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('query is required and must be a non-empty string');
    }
  },

  async handler(input, { config, context, signal }) {
    const { query, allowed_domains, blocked_domains } = input;
    const channelConfig = context?.subagentConfig || {};
    const baseUrl = channelConfig.baseUrl;
    const apiKey = channelConfig.apiKey;
    const model = channelConfig.model || 'claude-sonnet-4-6';
    const extraHeaders = channelConfig.extraHeaders || {};

    if (!baseUrl || !apiKey) {
      throw new Error('web_search requires a configured API channel (baseUrl and apiKey)');
    }

    const maxUses = config?.maxUses || 1;
    const allowed = config?.allowedDomains || allowed_domains || [];
    const blocked = config?.blockedDomains || blocked_domains || [];

    const body = {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: `Search the web for: ${query}` }],
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxUses,
        ...(allowed.length ? { allowed_domains: allowed } : {}),
        ...(blocked.length ? { blocked_domains: blocked } : {}),
      }],
      tool_choice: { type: 'tool', name: 'web_search' },
      stream: true,
    };

    const base = baseUrl.replace(/\/+$/, '');

    let res;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new Error(`Web search request failed: ${err.cause?.message || err.message}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Web search API error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const sources = [];
    const errors = [];
    let searchCount = 0;

    try {
      await parseSseStream(res, (event) => {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'web_search_tool_result') {
            searchCount++;
            const items = Array.isArray(block.content) ? block.content : [];
            for (const item of items) {
              if (item?.type === 'web_search_tool_result_error') {
                errors.push({ error_code: item.error_code || 'unknown' });
              } else if (item?.type === 'web_search_result') {
                const source = parseSourceItem(item);
                if (source) sources.push(source);
              }
            }
          }
        }
      });
    } catch (err) {
      throw new Error(`Web search stream error: ${err.message}`);
    }

    if (!sources.length && !errors.length) {
      throw new Error('Web search completed but returned no results.');
    }

    return { sources, errors, searchCount };
  },

  parseResult(output, _input) {
    const sources = output.sources || [];
    const errors = output.errors || [];
    return {
      renderType: 'source-cards',
      data: {
        sources,
        resultCount: sources.length,
        searchCount: output.searchCount || 1,
        errors: errors.map(e => typeof e === 'string' ? e : e.error_code || 'unknown').filter(Boolean),
      },
    };
  },
};

async function parseSseStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    rawBuffer += decoder.decode(value, { stream: true });
    const parts = rawBuffer.split('\n\n');
    rawBuffer = parts.pop() || '';

    for (const part of parts) {
      let dataLines = [];
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') continue;

      let event;
      try { event = JSON.parse(dataStr); } catch { continue; }

      if (onEvent(event) === false) return;
    }
  }
}
