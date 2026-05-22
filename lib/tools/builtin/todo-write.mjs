const MAX_TODOS = 50;
const MAX_CONTENT_LENGTH = 500;
const MAX_ID_LENGTH = 80;
const VALID_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

function requiredString(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if (trimmed.length > max) throw new Error(`${name} is too long`);
  return trimmed;
}

function normalizeTodo(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`todos[${index}] must be an object`);
  }
  const id = requiredString(String(raw.id ?? ''), `todos[${index}].id`, MAX_ID_LENGTH);
  const content = requiredString(String(raw.content ?? ''), `todos[${index}].content`, MAX_CONTENT_LENGTH);
  const statusRaw = raw.status === undefined || raw.status === null ? 'pending' : String(raw.status);
  if (!VALID_STATUS.has(statusRaw)) {
    throw new Error(`todos[${index}].status must be one of ${[...VALID_STATUS].join(' | ')}`);
  }
  return { id, content, status: statusRaw };
}

function summarize(todos) {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const todo of todos) counts[todo.status] = (counts[todo.status] || 0) + 1;
  return counts;
}

export const todoWriteTool = {
  id: 'todo_write',
  name: 'todo_write',
  title: 'Todo List',
  description:
    'Maintain a per-response checklist of tasks for the current assistant turn. Send the FULL up-to-date list every time; ' +
    'each call replaces the previous snapshot. Use for complex multi-step requests, refactors, or anything where the user benefits ' +
    'from seeing the plan and progress. Status: pending | in_progress | completed | cancelled. Keep ONE item in_progress at a time.',
  category: 'agent',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 3000,
  systemPrompt() {
    return [
      '# todo_write',
      '- Use proactively for complex, multi-step tasks (3+ distinct steps). Skip for trivial single-step requests.',
      '- Always send the COMPLETE list. The latest call is the source of truth — previous items are discarded.',
      '- Keep at most ONE item in_progress. Mark items completed IMMEDIATELY after finishing them; do not batch completions.',
      '- Use stable string ids (e.g., "1", "step-frontend", "fix-auth-bug") so updates land on the right row.',
      '- Use cancelled (not deletion) when an item is no longer needed.',
      '- Update the list as new follow-up items emerge instead of leaving them implicit.',
    ].join('\n');
  },
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full ordered list of todo items. Replaces the previous snapshot in this response.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable identifier for the item.' },
            content: { type: 'string', description: 'Short imperative description of the task.' },
            status: {
              type: 'string',
              description: 'Lifecycle state for this item.',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            },
          },
          required: ['id', 'content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },

  validate(input) {
    if (!Array.isArray(input?.todos)) throw new Error('todos must be an array');
    if (input.todos.length === 0) throw new Error('todos must not be empty');
    if (input.todos.length > MAX_TODOS) throw new Error(`todos must contain at most ${MAX_TODOS} items`);
  },

  async handler(input) {
    const todos = input.todos.map(normalizeTodo);
    const ids = new Set();
    for (const todo of todos) {
      if (ids.has(todo.id)) throw new Error(`Duplicate todo id: ${todo.id}`);
      ids.add(todo.id);
    }
    const inProgress = todos.filter(todo => todo.status === 'in_progress');
    return {
      todos,
      counts: summarize(todos),
      inProgressCount: inProgress.length,
      total: todos.length,
    };
  },

  parseResult(output) {
    return {
      renderType: 'todo-list',
      data: {
        todos: output.todos,
        counts: output.counts,
        total: output.total,
      },
    };
  },
};
