export const state = {
  conversations: [],
  activeId: null,
  messages: [],
  streamingByConversationId: new Map(),
  channels: [],
  activeChannelId: null,
  activeModel: null,
  tools: [],
  toolRuns: [],
  usage: null,
  basePricing: [],
  pricingCurrency: 'USD',
};
