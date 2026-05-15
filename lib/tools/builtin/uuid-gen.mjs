import { randomUUID } from 'node:crypto';

export const uuidGenTool = {
  id: 'uuid_gen',
  name: 'uuid_gen',
  title: 'Generate UUID',
  description: 'Generate one or more UUID v4 identifiers.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of UUIDs to generate (default 1, max 100).',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler({ count }) {
    const n = Math.min(Math.max(1, Math.floor(count) || 1), 100);
    const uuids = [];
    for (let i = 0; i < n; i++) {
      uuids.push(randomUUID());
    }
    return {
      count: n,
      uuids,
      ...(n === 1 ? { uuid: uuids[0] } : {}),
    };
  },

  parseResult(output) {
    return {
      renderType: 'uuid-list',
      data: { uuids: output.uuids, count: output.count },
    };
  },
};
