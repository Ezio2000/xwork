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
  type: 'web_search_20250305',
  maxUses: 4,
  timeoutMs: 0,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};
