export const currentTimeTool = {
  id: 'get_current_time',
  name: 'get_current_time',
  title: 'Current Time',
  description: 'Get the current date and time for a timezone.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name, for example Asia/Shanghai or America/New_York.',
      },
    },
    required: ['timezone'],
    additionalProperties: false,
  },
  async handler({ timezone }) {
    return {
      timezone,
      currentTime: new Date().toLocaleString('zh-CN', {
        timeZone: timezone || 'Asia/Shanghai',
        hour12: false,
      }),
    };
  },
};
