const DEFAULT_MAX_USES = 4;

function systemPrompt(tool = {}) {
  const effectiveMaxUses = tool.maxUses || DEFAULT_MAX_USES;
  return [
    'Web search policy:',
    '- Before doing several independent searches yourself, check whether the research should be split with delegate_task. For multi-topic, multi-vendor, multi-source, or comparison research, prefer delegating independent subjects and then synthesize their results.',
    '- For latest, today, recent, current, breaking, or time-sensitive questions, use web_search and put a date range directly in the query. Prefer broad ranges: "past 24 hours", "since yesterday", "last 7 days".',
    '- Use one targeted web_search query first. Use a second query only when the first result set is off-domain, stale, or ambiguous. Avoid repeated searches with the same meaning.',
    '- Do not let web_search replace task decomposition. If you need separate searches for 3 or more independent subjects, launch subagents for at least some subjects unless the user needs a very quick lightweight answer.',
    '- For official information, include the official site or domain token in the query itself, because provider-side domain filters may not be strict.',
    '- If search results do not show enough date evidence to confirm freshness, explicitly say that the newest/latest status cannot be confirmed from the returned sources.',
    `- CRITICAL: while generating this single assistant response right now, you may call web_search at most ${effectiveMaxUses} times. Count every web_search call you make in this response yourself.`,
    `- The ${effectiveMaxUses}-call limit applies only to the current response you are generating. Do not interpret it as a total limit for the whole conversation, and do not assume a hidden counter will protect you.`,
    `- Once you have made ${effectiveMaxUses} web_search calls in this response, stop using web_search immediately and answer with the results already collected. For straightforward questions, use at most 1-2 searches.`,
    '- If you receive a max_uses_exceeded error, do not retry web_search in the same response. Answer from the results already available and state any freshness uncertainty.',
    '- Do not use web fetch unless the user asks for it; rely on web_search result titles, URLs, snippets, and dates.',
    '- When using web_search, call it only through the structured tool channel. Never print, quote, or simulate internal tool-call markup in visible assistant text.',
    '- Forbidden visible text includes `<||DSML||tool_calls>`, `<||DSML||invoke`, `<||DSML||parameter`, and related closing tags.',
    '- If web_search cannot be invoked through the structured tool channel, say the search tool is unavailable instead of emitting internal markup.',
    '- 面向用户的回复中禁止出现任何内部工具调用标记、协议标记或 DSML 片段；这些内容不是答案的一部分。',
  ].join('\n');
}

// Parse a single search result item from the API response
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
  description: 'Search the web using the provider-native Anthropic web_search tool. For latest or recent topics, queries should include broad date ranges such as past 24 hours, since yesterday, or the last 7 days.',
  category: 'web',
  adapter: 'anthropic_server',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  apiToolType: 'web_search_20250305',
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
        description: 'Maximum web_search calls Anthropic may make in one assistant response.',
      },
      allowedDomains: {
        type: 'array',
        description: 'Optional provider-side domain allowlist. Leave empty to allow all domains.',
        items: { type: 'string' },
      },
      blockedDomains: {
        type: 'array',
        description: 'Optional provider-side domain blocklist.',
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
  timeoutMs: 0,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
    },
    required: ['query'],
    additionalProperties: false,
  },

  systemPrompt,
  parseStreamResult,
};
