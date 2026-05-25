const MAX_QUESTION_LEN = 4000;
const MAX_CONTEXT_LEN = 8000;
const MAX_OPTIONS = 20;
const MAX_OPTION_LEN = 500;
const MAX_FIELDS = 12;
const MAX_TEXT_ANSWER = 16000;
const MAX_NUMBER = 1e12;

const VALID_KINDS = new Set(['confirm', 'single', 'multi', 'text', 'number', 'form']);

function requiredString(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if (trimmed.length > max) throw new Error(`${name} is too long`);
  return trimmed;
}

function optionalString(value, name, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value;
}

function normalizeOption(raw, index) {
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!value) throw new Error(`options[${index}] must not be empty`);
    if (value.length > MAX_OPTION_LEN) throw new Error(`options[${index}] is too long`);
    return { value, label: value };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`options[${index}] must be a string or object`);
  }
  const value = requiredString(String(raw.value ?? raw.label ?? ''), `options[${index}].value`, MAX_OPTION_LEN);
  const label = optionalString(String(raw.label ?? value), `options[${index}].label`, MAX_OPTION_LEN) || value;
  const description = optionalString(String(raw.description ?? ''), `options[${index}].description`, MAX_OPTION_LEN);
  return { value, label, ...(description ? { description } : {}) };
}

function normalizeField(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`fields[${index}] must be an object`);
  }
  const name = requiredString(String(raw.name ?? ''), `fields[${index}].name`, 80);
  const type = String(raw.type || 'text');
  const allowed = new Set(['text', 'number', 'boolean', 'select', 'multiselect']);
  if (!allowed.has(type)) throw new Error(`fields[${index}].type must be one of ${[...allowed].join(' | ')}`);
  const label = optionalString(String(raw.label ?? name), `fields[${index}].label`, 200) || name;
  const field = {
    name,
    type,
    label,
    required: raw.required === true,
    sensitive: raw.sensitive === true,
    placeholder: optionalString(String(raw.placeholder ?? ''), `fields[${index}].placeholder`, 300),
    description: optionalString(String(raw.description ?? ''), `fields[${index}].description`, 500),
  };
  if (type === 'select' || type === 'multiselect') {
    if (!Array.isArray(raw.options) || !raw.options.length) {
      throw new Error(`fields[${index}].options is required for ${type}`);
    }
    field.options = raw.options.map((opt, i) => normalizeOption(opt, i));
  }
  if (type === 'number') {
    if (raw.min !== undefined) field.min = Number(raw.min);
    if (raw.max !== undefined) field.max = Number(raw.max);
    if (raw.step !== undefined) field.step = Number(raw.step);
  }
  if (raw.default !== undefined) field.default = raw.default;
  return field;
}

export function normalizeAskUserInput(input) {
  const kind = String(input?.kind || inferKind(input)).toLowerCase();
  if (!VALID_KINDS.has(kind)) throw new Error(`kind must be one of ${[...VALID_KINDS].join(' | ')}`);

  const question = requiredString(String(input?.question ?? ''), 'question', MAX_QUESTION_LEN);
  const context = optionalString(String(input?.context ?? ''), 'context', MAX_CONTEXT_LEN);
  const allowSkip = input?.allowSkip !== false;
  const allowCustom = input?.allowCustom === true;
  const recommended = optionalString(String(input?.recommended ?? ''), 'recommended', MAX_OPTION_LEN);
  const defaultValue = input?.default;

  const normalized = {
    kind,
    question,
    ...(context ? { context } : {}),
    allowSkip,
    allowCustom,
    ...(recommended ? { recommended } : {}),
  };

  if (kind === 'confirm') {
    normalized.options = [
      { value: 'yes', label: String(input?.confirmYes || '是') },
      { value: 'no', label: String(input?.confirmNo || '否') },
    ];
    if (defaultValue !== undefined) normalized.default = String(defaultValue);
    return normalized;
  }

  if (kind === 'single' || kind === 'multi') {
    if (!Array.isArray(input?.options) || !input.options.length) {
      throw new Error('options is required for single/multi');
    }
    if (input.options.length > MAX_OPTIONS) throw new Error(`options must contain at most ${MAX_OPTIONS} items`);
    normalized.options = input.options.map((opt, i) => normalizeOption(opt, i));
    if (defaultValue !== undefined) {
      normalized.default = kind === 'multi'
        ? (Array.isArray(defaultValue) ? defaultValue.map(String) : [String(defaultValue)])
        : String(defaultValue);
    }
    if (kind === 'multi') {
      normalized.minSelections = input.minSelections === undefined ? 0 : Number(input.minSelections);
      normalized.maxSelections = input.maxSelections === undefined ? normalized.options.length : Number(input.maxSelections);
      if (!Number.isInteger(normalized.minSelections) || normalized.minSelections < 0) {
        throw new Error('minSelections must be a non-negative integer');
      }
      if (!Number.isInteger(normalized.maxSelections) || normalized.maxSelections < 1) {
        throw new Error('maxSelections must be a positive integer');
      }
    }
    return normalized;
  }

  if (kind === 'text') {
    normalized.multiline = input?.multiline !== false;
    normalized.placeholder = optionalString(String(input?.placeholder ?? ''), 'placeholder', 500);
    if (defaultValue !== undefined) normalized.default = String(defaultValue);
    return normalized;
  }

  if (kind === 'number') {
    if (input?.min !== undefined) normalized.min = Number(input.min);
    if (input?.max !== undefined) normalized.max = Number(input.max);
    if (input?.step !== undefined) normalized.step = Number(input.step);
    if (defaultValue !== undefined) normalized.default = Number(defaultValue);
    return normalized;
  }

  if (kind === 'form') {
    if (!Array.isArray(input?.fields) || !input.fields.length) {
      throw new Error('fields is required for form');
    }
    if (input.fields.length > MAX_FIELDS) throw new Error(`fields must contain at most ${MAX_FIELDS} items`);
    normalized.fields = input.fields.map((field, i) => normalizeField(field, i));
    return normalized;
  }

  return normalized;
}

function inferKind(input) {
  if (Array.isArray(input?.fields) && input.fields.length) return 'form';
  if (Array.isArray(input?.options) && input.options.length) {
    return input?.kind === 'multi' ? 'multi' : 'single';
  }
  if (input?.kind === 'number' || input?.min !== undefined || input?.max !== undefined) return 'number';
  if (input?.kind === 'confirm') return 'confirm';
  if (input?.multiline === false) return 'text';
  return 'text';
}

function validateNumberAnswer(value, normalized) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('answer must be a finite number');
  if (Math.abs(n) > MAX_NUMBER) throw new Error('answer is out of range');
  if (normalized.min !== undefined && n < normalized.min) throw new Error(`answer must be >= ${normalized.min}`);
  if (normalized.max !== undefined && n > normalized.max) throw new Error(`answer must be <= ${normalized.max}`);
  return n;
}

function validateResponseAgainstInput(response, normalized) {
  const status = response?.status || 'answered';
  if (status === 'skipped') return { status: 'skipped', reason: response?.reason || 'user_skipped' };
  if (status === 'cancelled') return { status: 'cancelled', reason: response?.reason || 'user_cancelled' };

  const { kind } = normalized;

  if (kind === 'confirm' || kind === 'single') {
    const answer = requiredString(String(response?.answer ?? ''), 'answer', MAX_OPTION_LEN);
    const allowed = new Set(normalized.options.map(o => o.value));
    if (!allowed.has(answer) && !(normalized.allowCustom && answer)) {
      throw new Error('answer must be one of the provided options');
    }
    return { status: 'answered', answer, ...(response?.customText ? { customText: String(response.customText) } : {}) };
  }

  if (kind === 'multi') {
    const answers = Array.isArray(response?.answers) ? response.answers.map(String) : [];
    const allowed = new Set(normalized.options.map(o => o.value));
    for (const a of answers) {
      if (!allowed.has(a)) throw new Error(`invalid selection: ${a}`);
    }
    const min = normalized.minSelections ?? 0;
    const max = normalized.maxSelections ?? normalized.options.length;
    if (answers.length < min) throw new Error(`select at least ${min} option(s)`);
    if (answers.length > max) throw new Error(`select at most ${max} option(s)`);
    return { status: 'answered', answers };
  }

  if (kind === 'text') {
    const answer = requiredString(String(response?.answer ?? ''), 'answer', MAX_TEXT_ANSWER);
    return { status: 'answered', answer };
  }

  if (kind === 'number') {
    const answer = validateNumberAnswer(response?.answer, normalized);
    return { status: 'answered', answer };
  }

  if (kind === 'form') {
    const values = response?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('values must be an object');
    }
    const out = {};
    for (const field of normalized.fields) {
      const raw = values[field.name];
      if (raw === undefined || raw === null || raw === '') {
        if (field.required) throw new Error(`field ${field.name} is required`);
        continue;
      }
      if (field.type === 'boolean') {
        out[field.name] = raw === true || raw === 'true';
      } else if (field.type === 'number') {
        out[field.name] = validateNumberAnswer(raw, field);
      } else if (field.type === 'multiselect') {
        const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
        out[field.name] = arr;
      } else {
        out[field.name] = String(raw);
      }
    }
    return {
      status: 'answered',
      values: out,
      sensitiveFields: normalized.fields.filter(f => f.sensitive).map(f => f.name),
    };
  }

  throw new Error('unsupported kind');
}

function systemPrompt() {
  return [
    '# ask_user — Human-in-the-Loop (use aggressively)',
    '',
    'xwork expects you to involve the user **more often than typical coding agents**. When in doubt, **ask instead of guessing**.',
    '',
    '## Default rule',
    '- If a choice, constraint, environment, scope, risk, or preference is **not explicit** in the user message or workspace facts, call **ask_user** before irreversible work.',
    '- Prefer **one focused ask_user per decision**. Do not bundle unrelated questions into one form unless they are truly one form (use kind=form).',
    '- After calling ask_user, **stop** in that turn — do not call other tools until you receive the tool_result.',
    '',
    '## Strong triggers (call ask_user)',
    '- Ambiguous requirements: scope, environment (dev/test/uat/prod), target service/repo, success criteria.',
    '- Multiple valid approaches (architecture, library, refactor strategy) — present 2–4 options with tradeoffs.',
    '- Destructive or high-risk actions: delete, overwrite, mass edit, production data, long shell commands — use kind=confirm first.',
    '- Missing credentials, IDs, branch names, release ticket numbers the user must supply.',
    '- Verification gates: "Does this match what you wanted?" before marking work complete.',
    '- When you would otherwise assume a default the user might disagree with (model choice, verbosity, test scope).',
    '',
    '## Kind selection',
    '- confirm: yes/no or approve/reject before risky steps.',
    '- single: pick one option; set recommended to pre-highlight your suggestion.',
    '- multi: select many scopes/modules/checks.',
    '- text: short or long free-form (set multiline=true for logs, pasted output, specs).',
    '- number: counts, timeouts, limits (set min/max).',
    '- form: multiple related fields in one shot (env + service + confirm flag).',
    '',
    '## Anti-patterns',
    '- Do NOT use ask_user to read code, search the repo, or run commands — use read_file/grep/glob/shell_command.',
    '- Do NOT ask_user inside subagents (delegate_task) — only the main thread may ask the human.',
    '- Do NOT ask trivial questions answerable from context; do NOT ask five separate ask_user calls when one form suffices.',
    '- Do NOT proceed with destructive tools before confirm when the user has not clearly authorized it.',
    '',
    '## Copy tips',
    '- question: one clear sentence. context: brief markdown with what you already know.',
    '- options: use { value, label, description } when tradeoffs matter.',
    '- allowSkip: true when a reasonable default exists; say what default you will use if skipped.',
  ].join('\n');
}

export const askUserTool = {
  id: 'ask_user',
  name: 'ask_user',
  title: 'Ask User',
  description:
    'Ask the human a clarifying question or get explicit approval before continuing. Use frequently when requirements, environment, scope, tradeoffs, or risk are unclear. Supports confirm/single/multi/text/number/form. Blocks until the user answers in the UI.',
  category: 'agent',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 600000,
  capabilities: {
    executionMode: 'sequential',
    requiresUserInput: true,
    cancellable: true,
    readOnly: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['confirm', 'single', 'multi', 'text', 'number', 'form'],
        description: 'Interaction shape. Inferred from options/fields if omitted.',
      },
      question: { type: 'string', description: 'Primary question shown to the user (required).' },
      context: { type: 'string', description: 'Optional markdown background shown above the question.' },
      options: {
        type: 'array',
        description: 'Choices for single/multi/confirm. Strings or { value, label, description }.',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                value: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['value'],
            },
          ],
        },
      },
      fields: {
        type: 'array',
        description: 'For kind=form: array of field definitions.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['text', 'number', 'boolean', 'select', 'multiselect'] },
            label: { type: 'string' },
            required: { type: 'boolean' },
            sensitive: { type: 'boolean' },
            placeholder: { type: 'string' },
            description: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            min: { type: 'number' },
            max: { type: 'number' },
            default: {},
          },
          required: ['name', 'type'],
        },
      },
      recommended: { type: 'string', description: 'Recommended option value for single/multi.' },
      default: { description: 'Default answer or default field values hint.' },
      allowSkip: { type: 'boolean', description: 'Show skip; you should state the default you will use if skipped.' },
      allowCustom: { type: 'boolean', description: 'Allow free-text "Other" for single select.' },
      multiline: { type: 'boolean', description: 'For kind=text: use textarea (default true).' },
      placeholder: { type: 'string', description: 'Placeholder for text/number inputs.' },
      min: { type: 'number' },
      max: { type: 'number' },
      step: { type: 'number' },
      minSelections: { type: 'number' },
      maxSelections: { type: 'number' },
      confirmYes: { type: 'string' },
      confirmNo: { type: 'string' },
    },
    required: ['question'],
    additionalProperties: false,
  },

  systemPrompt,

  validate(input) {
    normalizeAskUserInput(input);
  },

  async before(input, { context, emit }) {
    if ((context.agentDepth || 0) > 0) {
      throw new Error('ask_user is only available in the main conversation, not inside subagents');
    }
    const normalized = normalizeAskUserInput(input);
    emit?.({
      phase: 'pending',
      kind: normalized.kind,
      question: normalized.question,
      context: normalized.context,
      options: normalized.options,
      fields: normalized.fields,
      allowSkip: normalized.allowSkip,
      allowCustom: normalized.allowCustom,
      recommended: normalized.recommended,
      default: normalized.default,
      multiline: normalized.multiline,
      placeholder: normalized.placeholder,
      min: normalized.min,
      max: normalized.max,
      minSelections: normalized.minSelections,
      maxSelections: normalized.maxSelections,
    });
    return normalized;
  },

  async handler(normalized, { context, signal }) {
    const registry = context.userInputRegistry;
    if (!registry || typeof registry.waitForAnswer !== 'function') {
      throw new Error('User input registry is not available');
    }
    const runId = context.runId || context.rootRunId || context.agentRunId;
    const toolCallId = context.toolCallId;
    if (!runId || !toolCallId) {
      throw new Error('ask_user requires runId and toolCallId in context');
    }

    const response = await registry.waitForAnswer({
      runId,
      toolCallId,
      meta: normalized,
      signal,
    });

    const parsed = validateResponseAgainstInput(response, normalized);
    return {
      ...parsed,
      question: normalized.question,
      kind: normalized.kind,
    };
  },

  parseResult(output, input) {
    return {
      renderType: 'ask-user',
      data: {
        kind: output.kind || input?.kind,
        question: output.question || input?.question,
        context: input?.context,
        status: output.status || 'answered',
        answer: output.answer,
        answers: output.answers,
        values: output.values,
        reason: output.reason,
        options: input?.options,
        fields: input?.fields,
      },
    };
  },

  scrubRunRecord(outcome) {
    const input = outcome?.input || {};
    const fields = Array.isArray(input.fields) ? input.fields : [];
    const sensitiveNames = new Set(fields.filter(f => f?.sensitive).map(f => f.name));
    if (!sensitiveNames.size) return outcome;
    const clone = { ...outcome, input: { ...input } };
    if (clone.output && typeof clone.output === 'object' && clone.output.values) {
      clone.output = {
        ...clone.output,
        values: { ...clone.output.values },
      };
      for (const name of sensitiveNames) {
        if (clone.output.values[name] !== undefined) clone.output.values[name] = '[redacted]';
      }
    }
    return clone;
  },
};
