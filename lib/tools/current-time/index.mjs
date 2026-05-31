function systemPrompt() {
  return [
    'Current time tool policy:',
    '- Use the system prompt date/time for ordinary relative-date interpretation when it is sufficient.',
    '- Use get_current_time only when the user explicitly asks for current clock time, timezone conversion, or exact time-of-day; or when exact current time is required to compute a time-sensitive query boundary.',
    '- If get_current_time is needed for the task, call it before any other tool or substantive work. Do not search, browse, inspect files, or delegate until the current time has been established.',
    '- If a later step newly reveals that exact current time is required, pause other work and call get_current_time before continuing.',
  ].join('\n');
}

export const tool = {
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
  systemPrompt,
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
