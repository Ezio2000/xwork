function expertCatalog(expertAgents = []) {
  if (!expertAgents.length) {
    return [
      '## Expert agents',
      '- general_task_agent: General Task Agent — default bounded expert for delegated work.',
    ].join('\n');
  }
  return [
    '## Expert agents',
    'Choose the most suitable expertAgentId for every delegate_task call. Use the default general expert only when no specialized profile is a better fit.',
    ...expertAgents.map(agent => {
      const hints = [agent.description, agent.selectionPrompt].filter(Boolean).join(' ');
      const tools = Array.isArray(agent.allowedTools) && agent.allowedTools.length
        ? ` Tools: ${agent.allowedTools.join(', ')}.`
        : '';
      return `- ${agent.id}: ${agent.title}${hints ? ` — ${hints}` : ''}.${tools}`;
    }),
  ].join('\n');
}

function systemPrompt(tool = {}) {
  return [
    '# Expert Agent Delegation Policy',
    'delegate_task launches a fresh-context expert agent to autonomously handle one bounded objective. Use it to divide complex work, gather independent evidence, protect the main context from noisy tool output, or get an independent check before you answer.',
    '',
    '## Default decision rule',
    '- Treat delegate_task as the standard execution path for complex, multi-step, multi-topic, parallelizable, uncertain, or verification-heavy work. It is not a last resort.',
    '- At the start of every non-trivial request, decide the division of labor before doing all research or inspection yourself.',
    '- If the user request naturally separates into independent workstreams, launch expert agents first, then continue useful local planning or blocking work while they run.',
    '- If you decide not to delegate a non-trivial task, the reason should be clear: the task is simple, tightly coupled, requires one continuous context, or the user explicitly asked not to use delegation.',
    '',
    '## Strong triggers',
    '- Use delegate_task when the request has 3 or more independent topics, vendors, APIs, files, modules, services, logs, options, or evaluation dimensions.',
    '- Use delegate_task for comparisons where each alternative can be investigated independently.',
    '- Use delegate_task for broad codebase exploration, especially when the answer may require glob/grep/read_file across different areas.',
    '- Use delegate_task for latest-information research across multiple subjects. Do not have the main thread perform every web_search itself when independent subjects can be delegated.',
    '- Use delegate_task for independent verification after non-trivial implementation, risky changes, backend/API changes, or cross-module edits.',
    '- Use delegate_task when you need a second opinion, risk review, or adversarial check before reporting completion.',
    '',
    '## Parallelism',
    '- When multiple expert-agent objectives are independent, call delegate_task multiple times in the same assistant response so they run concurrently.',
    '- Prefer 2-3 well-scoped expert agents for complex work. Avoid one broad expert agent that owns the whole project.',
    '- Keep the main thread focused on coordination and synthesis. Do not duplicate the exact searches or file inspections assigned to expert agents unless you are spot-checking.',
    '',
    '## Writing expert-agent prompts',
    '- Each delegate_task call must give exactly one concrete objective in objective. Do not bundle unrelated questions or multi-step project ownership into one expert agent.',
    '- Make the objective specific and bounded: name the target, success criteria, and expected evidence.',
    '- Treat expert agents as fresh-context workers. Put only necessary background in brief; do not assume they can see the full conversation.',
    '- Use expectedOutput to tell the expert agent exactly what concise result to output. Expert output is pasted verbatim into your context — every word costs tokens. Request the minimum: "list the findings in 3 bullets" rather than "write a comprehensive report".',
    '- Tell the expert agent whether it should only investigate or may also make changes.',
    '- By default, expert agents cannot create more agents. Set allowSubagents only when nested delegation is explicitly necessary and bounded.',
    '- Set expertAgentId to the best matching expert from the catalog below. If no expert clearly fits, use general_task_agent or omit expertAgentId.',
    '',
    expertCatalog(tool.expertAgents || []),
    '',
    '## Turn budget',
    '- The main agent and each expert agent have independent turn budgets. Each turn = one assistant response + tool results. Multiple parallel tool calls in one response count as one turn.',
    '- Expert agents default to the configurable turn budget from their profile. If a specific delegated task needs a different budget, set maxTurns up to 100 for that delegate_task call.',
    '- Reserve the last turn for the expert agent to write its final answer. Objectives that require extensive multi-step tool use should be split across multiple agents.',
    '',
    '## Examples',
    '- Good: compare four vendors by launching one expert agent per vendor, each asked for recent changes, pricing risk, and evidence; then synthesize the tradeoff yourself.',
    '- Good: for a codebase reliability review, launch separate expert agents for backend/API risk, frontend streaming UX, and test coverage; then merge findings into priorities.',
    '- Good: after implementation across multiple files, launch a verification expert with changed files, original request, and commands to run.',
    '- Bad: ask one expert agent to "research everything and write the final answer". You must own synthesis.',
    '- Bad: delegate a search to an expert agent and then run the same search yourself in the main thread.',
  ].join('\n');
}

// Runtime-definition helpers. These rewrite the API-facing definition with the
// live expert-agent catalog. Byte-stable output is required to preserve provider
// prefix-cache hits: keep the same concat order and the same property/enum order
// as before (these were previously hardcoded in lib/tools/_core/registry.mjs).
function expertAgentDescription(expertAgents = []) {
  if (!expertAgents.length) return '';
  const lines = expertAgents.map(agent => {
    const prompt = agent.selectionPrompt || agent.description || '';
    return `- ${agent.id}: ${agent.title}${prompt ? ` — ${prompt}` : ''}`;
  });
  return `\n\nAvailable expert agents:\n${lines.join('\n')}`;
}

function expertAgentInputSchema(schema, expertAgents = []) {
  if (!schema) return schema;
  const inputSchema = JSON.parse(JSON.stringify(schema));
  const properties = inputSchema.properties || {};
  const ids = expertAgents.map(agent => agent.id).filter(Boolean);
  properties.expertAgentId = {
    type: 'string',
    description: 'Expert agent profile to use for this delegated objective. Choose the best id from the available expert agents listed in the system prompt. Omit only when the default general expert is the best fit.',
    ...(ids.length ? { enum: ids } : {}),
  };
  inputSchema.properties = properties;
  return inputSchema;
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function optionalString(value, name, max) {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function optionalNumber(value, name, { min, max }) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
}

function optionalSafeName(value, name) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) throw new Error(`${name} must be a safe id`);
}

const SUBAGENT_MAX_TURNS_MIN = 1;
const SUBAGENT_MAX_TURNS_MAX = 100;
const SUBAGENT_TIMEOUT_MS_MAX = 300_000;
const LEGACY_TIMEOUT_MS = [125_000];

function configuredDefaultMaxTurns(config = {}) {
  const n = Number(config.defaultMaxTurns);
  if (!Number.isInteger(n) || n < SUBAGENT_MAX_TURNS_MIN || n > SUBAGENT_MAX_TURNS_MAX) return undefined;
  return n;
}

export const tool = {
  id: 'delegate_task',
  name: 'delegate_task',
  title: 'Delegate Task',
  description: 'Launch a fresh-context expert agent to autonomously handle one bounded objective. Choose the best expertAgentId for the task when specialized expert profiles are available. Use this as the standard path for complex, multi-step, multi-topic, parallelizable, uncertain, or verification-heavy work; for comparisons; for broad codebase or web research across independent subjects; and for independent verification. Launch multiple delegate_task calls concurrently when objectives are independent.',
  category: 'agent',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'medium',
  defaultEnabled: true,
  timeoutMs: 305000,
  legacyTimeoutMs: LEGACY_TIMEOUT_MS,
  defaultConfig: {
    defaultMaxTurns: 3,
  },
  configSchema: {
    type: 'object',
    properties: {
      defaultMaxTurns: {
        type: 'number',
        description: 'Default expert-agent turn budget when a delegate_task call does not provide maxTurns.',
      },
    },
    additionalProperties: false,
  },
  configExamples: [],
  capabilities: {
    executionMode: 'parallel_batch',
    cancellable: true,
    readOnly: false,
    network: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'Exactly one concrete objective for the expert agent to complete. Include the target and success criteria; do not bundle unrelated work.',
      },
      expertAgentId: {
        type: 'string',
        description: 'Optional expert agent profile id. Choose the best matching expert from the catalog injected into the system prompt.',
      },
      task: {
        type: 'string',
        description: 'Legacy alias for objective. Use objective for new calls.',
      },
      label: {
        type: 'string',
        description: 'Short display label for the expert agent run.',
      },
      brief: {
        type: 'string',
        description: 'Necessary background for this fresh-context expert agent. Include only context needed to make good judgments; do not paste the full conversation.',
      },
      expectedOutput: {
        type: 'string',
        description: 'Concise output contract, for example "3-5 bullets with evidence, assumptions, and blockers only".',
      },
      instructions: {
        type: 'string',
        description: 'Legacy alias for expectedOutput or extra constraints.',
      },
      parentSummary: {
        type: 'string',
        description: 'Legacy alias for brief.',
      },
      allowedTools: {
        type: 'array',
        description: 'Optional tool allowlist for this delegated run. It narrows the selected expert profile tools and cannot enable globally disabled tools.',
        items: { type: 'string' },
      },
      allowSubagents: {
        type: 'boolean',
        description: 'Allow this expert agent to call delegate_task. Defaults to the selected expert profile.',
      },
      maxTurns: {
        type: 'number',
        description: 'Optional expert-agent tool-calling turn budget for this call. Overrides the selected expert profile. Maximum 100.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional expert-agent timeout in milliseconds. Default comes from the selected expert profile; maximum 300000.',
      },
      maxOutputChars: {
        type: 'number',
        description: 'Optional maximum result text returned to the parent. Default 2000, maximum 8000.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  systemPrompt,

  // Declares the runtime data this tool needs; the registry collects only these
  // keys and passes them to resolveDefinition (no tool-name hardcoding upstream).
  runtimeContext: ['expertAgents'],

  // Rewrite the API-facing definition with the live expert-agent catalog: append
  // the catalog to the description and inject the expertAgentId enum. Mirrors what
  // systemPrompt(tool) already does, keeping all expert-injection logic in one place.
  resolveDefinition(definition, runtimeContext = {}) {
    const expertAgents = runtimeContext.expertAgents || [];
    return {
      ...definition,
      description: `${definition.description}${expertAgentDescription(expertAgents)}`,
      inputSchema: expertAgentInputSchema(definition.inputSchema, expertAgents),
      expertAgents,
    };
  },

  validate(input) {
    const objective = firstText(input.objective, input.task);
    if (!objective) {
      throw new Error('objective is required');
    }
    if (objective.length > 1600) throw new Error('objective is too long');
    optionalString(input.task, 'task', 1600);
    optionalString(input.objective, 'objective', 1600);
    optionalString(input.label, 'label', 120);
    optionalString(input.brief, 'brief', 2500);
    optionalString(input.parentSummary, 'parentSummary', 2500);
    optionalString(input.expectedOutput, 'expectedOutput', 1000);
    optionalString(input.instructions, 'instructions', 1000);
    optionalSafeName(input.expertAgentId, 'expertAgentId');
    optionalNumber(input.maxTurns, 'maxTurns', { min: SUBAGENT_MAX_TURNS_MIN, max: SUBAGENT_MAX_TURNS_MAX });
    optionalNumber(input.timeoutMs, 'timeoutMs', { min: 1000, max: SUBAGENT_TIMEOUT_MS_MAX });
    optionalNumber(input.maxOutputChars, 'maxOutputChars', { min: 500, max: 8000 });
    if (input.allowSubagents !== undefined && typeof input.allowSubagents !== 'boolean') {
      throw new Error('allowSubagents must be a boolean');
    }
    if (input.allowedTools !== undefined) {
      if (!Array.isArray(input.allowedTools)) throw new Error('allowedTools must be an array');
      for (const name of input.allowedTools) {
        if (typeof name !== 'string') throw new Error('allowedTools must contain strings');
        if (!SAFE_NAME_RE.test(name)) throw new Error(`Unsupported tool id: ${name}`);
      }
    }
  },

  async handler(input, { config, context, signal }) {
    if (typeof context.runSubagent !== 'function') {
      throw new Error('Subagent runtime is not available');
    }
    if ((context.agentDepth || 0) > 0 && !context.allowSubagents) {
      throw new Error('Nested expert agents are disabled for this expert agent');
    }

    const objective = firstText(input.objective, input.task);
    const brief = firstText(input.brief, input.parentSummary);
    const expectedOutput = firstText(input.expectedOutput, input.instructions);

    return context.runSubagent({
      task: objective,
      objective,
      expertAgentId: input.expertAgentId || null,
      label: input.label || '',
      instructions: input.instructions || '',
      brief,
      expectedOutput,
      parentSummary: input.parentSummary || '',
      allowedTools: input.allowedTools || null,
      allowSubagents: input.allowSubagents === true,
      maxTurns: input.maxTurns ?? configuredDefaultMaxTurns(config),
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars,
      parentRunId: context.agentRunId || null,
      parentToolCallId: context.toolCallId || null,
      depth: context.agentDepth || 0,
      config: context.subagentConfig,
      context,
      signal,
      emitEvent: context.emitAgentEvent,
    });
  },

  parseResult(output) {
    return {
      renderType: 'subagent-run',
      data: {
        runId: output.runId,
        parentRunId: output.parentRunId,
        rootRunId: output.rootRunId,
        status: output.status,
        label: output.label,
        task: output.task,
        text: output.text,
        reason: output.reason,
        error: output.error,
        durationMs: output.durationMs,
        usage: output.usage,
        expertAgent: output.expertAgent,
        limits: output.limits,
        allowedTools: output.allowedTools,
        forcedSummary: output.forcedSummary,
        truncated: output.truncated,
        fullTextLength: output.fullTextLength,
      },
    };
  },
};
