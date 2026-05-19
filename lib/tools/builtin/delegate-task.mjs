function systemPrompt() {
  return [
    '# Subagent Delegation Policy',
    'delegate_task launches a fresh-context subagent to autonomously handle one bounded objective. Use it to divide complex work, gather independent evidence, protect the main context from noisy tool output, or get an independent check before you answer.',
    '',
    '## Default decision rule',
    '- Treat delegate_task as the standard execution path for complex, multi-step, multi-topic, parallelizable, uncertain, or verification-heavy work. It is not a last resort.',
    '- At the start of every non-trivial request, decide the division of labor before doing all research or inspection yourself.',
    '- If the user request naturally separates into independent workstreams, launch subagents first, then continue useful local planning or blocking work while they run.',
    '- If you decide not to delegate a non-trivial task, the reason should be clear: the task is simple, tightly coupled, requires one continuous context, or the user explicitly asked not to use subagents.',
    '',
    '## Strong triggers',
    '- Use delegate_task when the request has 3 or more independent topics, vendors, APIs, files, modules, services, logs, options, or evaluation dimensions.',
    '- Use delegate_task for comparisons where each alternative can be investigated independently.',
    '- Use delegate_task for broad codebase exploration, especially when the answer may require several searches, file reads, or checks across different areas.',
    '- Use delegate_task for latest-information research across multiple subjects. Do not have the main thread perform every web_search itself when independent subjects can be delegated.',
    '- Use delegate_task for independent verification after non-trivial implementation, risky changes, backend/API changes, or cross-module edits.',
    '- Use delegate_task when you need a second opinion, risk review, or adversarial check before reporting completion.',
    '',
    '## Parallelism',
    '- When multiple subagent objectives are independent, call delegate_task multiple times in the same assistant response so they run concurrently.',
    '- Prefer 2-3 well-scoped subagents for complex work. Avoid one broad subagent that owns the whole project.',
    '- Keep the main thread focused on coordination and synthesis. Do not duplicate the exact searches or file inspections assigned to subagents unless you are spot-checking.',
    '',
    '## Writing subagent prompts',
    '- Each delegate_task call must give exactly one concrete objective in objective. Do not bundle unrelated questions or multi-step project ownership into one subagent.',
    '- Make the objective specific and bounded: name the target, success criteria, and expected evidence.',
    '- Treat subagents as fresh-context workers. Put only necessary background in brief; do not assume they can see the full conversation.',
    '- Use expectedOutput to tell the subagent exactly what concise result to output. Subagent output is pasted verbatim into your context — every word costs tokens. Request the minimum: "list the findings in 3 bullets" rather than "write a comprehensive report".',
    '- Tell the subagent whether it should only investigate or may also make changes.',
    '- By default, subagents cannot create more subagents. Set allowSubagents only when nested delegation is explicitly necessary and bounded.',
    '',
    '## Turn budget',
    '- Subagents default to 3 tool-calling turns (max 5). Each turn = one assistant response + tool results. Multiple parallel tool calls in one response count as one turn.',
    '- Plan objectives so the subagent can finish within the turn budget. If more rounds are needed, set maxTurns to 5.',
    '- Reserve the last turn for the subagent to write its final answer. Objectives that require extensive multi-step tool use should be split across multiple subagents.',
    '',
    '## Examples',
    '- Good: compare four vendors by launching one subagent per vendor, each asked for recent changes, pricing risk, and evidence; then synthesize the tradeoff yourself.',
    '- Good: for a codebase reliability review, launch separate subagents for backend/API risk, frontend streaming UX, and test coverage; then merge findings into priorities.',
    '- Good: after implementation across multiple files, launch a verification subagent with changed files, original request, and commands to run.',
    '- Bad: ask one subagent to "research everything and write the final answer". You must own synthesis.',
    '- Bad: delegate a search to a subagent and then run the same search yourself in the main thread.',
  ].join('\n');
}

const TOOL_ALLOWLIST = ['web_search', 'get_current_time', 'calculator', 'uuid_gen', 'web_fetch', 'delegate_task'];

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

export const delegateTaskTool = {
  id: 'delegate_task',
  name: 'delegate_task',
  title: 'Delegate Task',
  description: 'Launch a fresh-context subagent to autonomously handle one bounded objective. Use this as the standard path for complex, multi-step, multi-topic, parallelizable, uncertain, or verification-heavy work; for comparisons; for broad codebase or web research across independent subjects; and for independent verification. Launch multiple delegate_task calls concurrently when objectives are independent.',
  category: 'agent',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'medium',
  defaultEnabled: true,
  timeoutMs: 125000,
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'Exactly one concrete objective for the subagent to complete. Include the target and success criteria; do not bundle unrelated work.',
      },
      task: {
        type: 'string',
        description: 'Legacy alias for objective. Use objective for new calls.',
      },
      label: {
        type: 'string',
        description: 'Short display label for the subagent run.',
      },
      brief: {
        type: 'string',
        description: 'Necessary background for this fresh-context subagent. Include only context needed to make good judgments; do not paste the full conversation.',
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
        description: 'Optional tool allowlist for the subagent. Defaults to safe tools and excludes delegate_task; include only tools needed for this objective.',
        items: { type: 'string', enum: TOOL_ALLOWLIST },
      },
      allowSubagents: {
        type: 'boolean',
        description: 'Allow this subagent to call delegate_task. Defaults to false.',
      },
      maxTurns: {
        type: 'number',
        description: 'Optional subagent tool-calling turn budget. Default 3, maximum 5.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional subagent timeout in milliseconds. Default 90000, maximum 120000.',
      },
      maxOutputChars: {
        type: 'number',
        description: 'Optional maximum result text returned to the parent. Default 2000, maximum 4000.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  systemPrompt,

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
    optionalNumber(input.maxTurns, 'maxTurns', { min: 1, max: 5 });
    optionalNumber(input.timeoutMs, 'timeoutMs', { min: 1000, max: 120000 });
    optionalNumber(input.maxOutputChars, 'maxOutputChars', { min: 500, max: 4000 });
    if (input.allowSubagents !== undefined && typeof input.allowSubagents !== 'boolean') {
      throw new Error('allowSubagents must be a boolean');
    }
    if (input.allowedTools !== undefined) {
      if (!Array.isArray(input.allowedTools)) throw new Error('allowedTools must be an array');
      for (const name of input.allowedTools) {
        if (typeof name !== 'string') throw new Error('allowedTools must contain strings');
        if (!TOOL_ALLOWLIST.includes(name)) throw new Error(`Unsupported subagent tool: ${name}`);
      }
    }
  },

  async handler(input, { context, signal }) {
    if (typeof context.runSubagent !== 'function') {
      throw new Error('Subagent runtime is not available');
    }
    if ((context.agentDepth || 0) > 0 && !context.allowSubagents) {
      throw new Error('Nested subagents are disabled for this subagent');
    }

    const objective = firstText(input.objective, input.task);
    const brief = firstText(input.brief, input.parentSummary);
    const expectedOutput = firstText(input.expectedOutput, input.instructions);

    return context.runSubagent({
      task: objective,
      objective,
      label: input.label || '',
      instructions: input.instructions || '',
      brief,
      expectedOutput,
      parentSummary: input.parentSummary || '',
      allowedTools: input.allowedTools || null,
      allowSubagents: input.allowSubagents === true,
      maxTurns: input.maxTurns,
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
        limits: output.limits,
        allowedTools: output.allowedTools,
        truncated: output.truncated,
        fullTextLength: output.fullTextLength,
      },
    };
  },
};
