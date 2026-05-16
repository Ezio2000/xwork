function systemPrompt() {
  return [
    'Web search policy:',
    '- For latest, today, recent, current, breaking, or time-sensitive questions, use web_search and put a date range directly in the query. Prefer broad ranges: "past 24 hours", "since yesterday", "last 7 days".',
    '- Use one targeted web_search query first. Use a second query only when the first result set is off-domain, stale, or ambiguous. Avoid repeated searches with the same meaning.',
    '- For official information, include the official site or domain token in the query itself, because provider-side domain filters may not be strict.',
    '- If search results do not show enough date evidence to confirm freshness, explicitly say that the newest/latest status cannot be confirmed from the returned sources.',
    `- CRITICAL: web_search has a HARD LIMIT of ${maxUses} uses per assistant turn (i.e. per API request). The counter resets on each new turn. You MUST NOT exceed ${maxUses} calls in a single turn under any circumstances. Use at most 1-2 searches for straightforward questions. If you ever receive a "max_uses_exceeded" error, you have hit the per-turn hard limit: you MUST stop immediately, you MUST NOT retry web_search in this turn, and you MUST answer using only the results already collected. Calling web_search again after max_uses_exceeded will fail and waste a turn.`,
    '- Do not use web fetch unless the user asks for it; rely on web_search result titles, URLs, snippets, and dates.',
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

const maxUses = 8;

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
  maxUses,
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
