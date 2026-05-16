import { queryLoop } from '../query-loop.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun } from './runs.mjs';
import { appendToolRun as defaultAppendToolRun } from '../tools/runs.mjs';
import { runTool as defaultRunTool } from '../tools/runner.mjs';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_TURNS = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_CHARS = 2000;
const MAX_MAX_TURNS = 5;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_ALLOWED_TOOLS = ['web_search', 'get_current_time', 'calculator', 'uuid_gen'];
const TRANSIENT_EVENT_TYPES = new Set(['subagent_delta', 'subagent_thinking']);

function childSignal(parentSignal, timeoutMs) {
  const ac = new AbortController();
  let timer = null;

  const abort = () => ac.abort();
  if (parentSignal?.aborted) {
    ac.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', abort, { once: true });
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => ac.abort(), timeoutMs);
  }

  return {
    signal: ac.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abort);
    },
  };
}

function truncate(text, max = 4000) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function limitNumber(value, fallback, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function resolveAllowedToolNames({ allowedTools, allowSubagents }) {
  const base = Array.isArray(allowedTools) ? allowedTools : DEFAULT_ALLOWED_TOOLS;
  const names = new Set(base.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()));
  if (!allowSubagents) {
    names.delete('delegate_task');
  } else if (!allowedTools) {
    names.add('delegate_task');
  }
  return names;
}

function filterConfigTools(config, allowedNames) {
  const tools = Array.isArray(config?.tools) ? config.tools : [];
  return {
    ...(config || {}),
    tools: tools.filter(tool => allowedNames.has(tool?.name)),
  };
}

function shouldPersistEvent(event) {
  return !TRANSIENT_EVENT_TYPES.has(event?.type);
}

function buildRestrictedRunTool(runTool, allowedNames) {
  if (!runTool) return runTool;
  return async (call, context) => {
    if (!allowedNames.has(call?.name)) {
      return {
        id: call?.id,
        name: call?.name,
        isError: true,
        output: `Tool is not available to this subagent: ${call?.name}`,
        durationMs: 0,
      };
    }
    return runTool(call, context);
  };
}

function buildSubagentHistory({ objective, task, brief, expectedOutput, instructions, parentSummary, allowedToolNames, allowSubagents }) {
  const resolvedObjective = objective || task;
  const resolvedBrief = brief || parentSummary;
  const resolvedExpectedOutput = expectedOutput || instructions;
  const canDelegate = allowSubagents && allowedToolNames.has('delegate_task');
  const systemParts = [
    'You are a focused subagent working for a parent assistant.',
    'You have fresh context. You cannot see the parent conversation unless it is included in this prompt.',
    'Work only on the single delegated objective. Do not broaden the task, take ownership of adjacent work, or solve unrelated parts of the parent request.',
    'Complete the delegated task independently and return a concise, useful result.',
    'Keep the final result short: prefer one short paragraph or 3-6 bullets. Include only the findings, evidence, assumptions, or blockers the parent needs.',
    'Do not ask the user follow-up questions. State any assumptions or gaps in the final result.',
    `Available tools: ${Array.from(allowedToolNames).join(', ') || 'none'}.`,
    canDelegate
      ? 'Nested delegation is allowed only if the next subagent has one narrower objective and will materially reduce work.'
      : 'Do not create subagents. Finish this delegated objective directly with your available tools.',
    resolvedExpectedOutput ? `Expected output:\n${resolvedExpectedOutput}` : 'Expected output: concise result for the parent, preferably under 6 bullets.',
    resolvedBrief ? `Brief from parent:\n${resolvedBrief}` : '',
  ].filter(Boolean);

  const userParts = [
    `Objective:\n${resolvedObjective}`,
    resolvedBrief ? `Relevant context:\n${resolvedBrief}` : '',
    resolvedExpectedOutput ? `Output contract:\n${resolvedExpectedOutput}` : '',
  ].filter(Boolean);

  return [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

function serverToolOutput(event) {
  return {
    ...(event.data || {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
}

export async function runSubagent({
  task,
  objective = '',
  instructions = '',
  label = '',
  brief = '',
  expectedOutput = '',
  parentSummary = '',
  allowedTools = null,
  allowSubagents = false,
  parentRunId = null,
  parentToolCallId = null,
  depth = 0,
  config,
  context = {},
  signal,
  emitEvent,
  maxTurns = DEFAULT_MAX_TURNS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  maxDepth = DEFAULT_MAX_DEPTH,
  streamChat,
  runTool,
}) {
  if (depth >= maxDepth) {
    throw new Error(`Subagent depth limit reached (${maxDepth})`);
  }

  const effectiveMaxTurns = limitNumber(maxTurns, DEFAULT_MAX_TURNS, { min: 1, max: MAX_MAX_TURNS });
  const effectiveTimeoutMs = limitNumber(timeoutMs, DEFAULT_TIMEOUT_MS, { min: 1000, max: MAX_TIMEOUT_MS });
  const effectiveMaxOutputChars = limitNumber(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, { min: 500, max: MAX_OUTPUT_CHARS });
  const allowedToolNames = resolveAllowedToolNames({ allowedTools, allowSubagents });
  const subagentConfig = filterConfigTools(config, allowedToolNames);

  const run = await createAgentRun({
    role: 'subagent',
    parentRunId,
    rootRunId: context.rootRunId || parentRunId || null,
    conversationId: context.conversationId || null,
    channelId: context.channelId || null,
    model: context.model || config?.model || null,
    source: context.source || 'runtime',
    environment: context.environment || process.env.NODE_ENV || 'development',
    task,
    label,
    depth: depth + 1,
    parentToolCallId,
  });

  const publish = async (event) => {
    const { type, ...rest } = event;
    const payload = { runId: run.runId, parentRunId, rootRunId: run.rootRunId, eventType: type, ...rest };
    emitEvent?.(payload);
    if (!shouldPersistEvent(event)) return;
    await appendAgentRunEvent(run.runId, event).catch(() => {});
  };

  await publish({
    type: 'subagent_start',
    label: run.label,
    task: truncate(task, 1000),
    depth: run.depth,
    parentToolCallId,
    allowedTools: Array.from(allowedToolNames),
    allowSubagents,
    limits: {
      maxTurns: effectiveMaxTurns,
      timeoutMs: effectiveTimeoutMs,
      maxOutputChars: effectiveMaxOutputChars,
    },
  });

  const child = childSignal(signal, effectiveTimeoutMs);
  const history = buildSubagentHistory({
    objective: objective || task,
    task,
    instructions,
    brief,
    expectedOutput,
    parentSummary,
    allowedToolNames,
    allowSubagents,
  });
  const serverToolInputs = new Map();
  const serverToolStartedAt = new Map();
  const appendServerToolRun = config?.appendToolRun || defaultAppendToolRun;
  const selectedRunTool = buildRestrictedRunTool(runTool || config?.runTool || defaultRunTool, allowedToolNames);
  let finalState;

  try {
    const iterator = queryLoop({
      config: subagentConfig,
      history,
      maxTurns: effectiveMaxTurns,
      signal: child.signal,
      streamChat: streamChat || config?.streamChat,
      runTool: selectedRunTool,
      toolContext: {
        ...context,
        agentRunId: run.runId,
        parentRunId: run.runId,
        rootRunId: context.rootRunId || parentRunId || run.runId,
        agentDepth: run.depth,
        allowSubagents,
        allowedTools: Array.from(allowedToolNames),
        emitAgentEvent: emitEvent,
        runSubagent,
        subagentConfig,
      },
      onDelta: (delta) => {
        publish({ type: 'subagent_delta', text: delta }).catch(() => {});
      },
      onThinkingDelta: (thinkingText) => {
        publish({ type: 'subagent_thinking', text: truncate(thinkingText, 2000) }).catch(() => {});
      },
      onServerToolEvent: (event) => {
        if (event.phase === 'call') {
          serverToolInputs.set(event.id, event.input || {});
          serverToolStartedAt.set(event.id, Date.now());
        } else if (event.phase === 'result') {
          const input = serverToolInputs.get(event.id) || {};
          const startedAt = serverToolStartedAt.get(event.id) || Date.now();
          const durationMs = Date.now() - startedAt;
          Promise.resolve(appendServerToolRun({
            id: event.id,
            name: event.name,
            isError: event.isError,
            input,
            output: serverToolOutput(event),
            durationMs,
            context: {
              source: context.source || 'runtime',
              environment: context.environment || process.env.NODE_ENV || 'development',
              conversationId: context.conversationId || null,
              channelId: context.channelId || null,
              model: context.model || config?.model || null,
              adapter: event.name,
              agentRunId: run.runId,
              parentRunId,
              rootRunId: run.rootRunId,
              agentDepth: run.depth,
              toolCallId: event.id,
            },
          })).catch(() => {});
        }
        publish({ type: 'subagent_server_tool', event }).catch(() => {});
      },
    });

    let iterResult = await iterator.next();
    while (!iterResult.done) {
      const evt = iterResult.value;
      if (evt.type === 'tool_call') {
        await publish({
          type: 'subagent_tool_call',
          toolCallId: evt.id,
          name: evt.name,
          input: evt.input || {},
        });
      } else if (evt.type === 'tool_result') {
        await publish({
          type: 'subagent_tool_result',
          toolCallId: evt.id,
          name: evt.name,
          isError: evt.isError,
          durationMs: evt.durationMs,
          output: evt.output,
          ...(evt.renderType ? { renderType: evt.renderType, data: evt.data } : {}),
        });
      }
      iterResult = await iterator.next();
    }

    finalState = iterResult.value;
    const status = finalState.reason === 'completed' ? 'completed' : finalState.reason;
    const fullText = finalState.text || '';
    const result = {
      text: truncate(fullText, effectiveMaxOutputChars),
      ...(fullText.length > effectiveMaxOutputChars ? { truncated: true, fullTextLength: fullText.length } : {}),
      reason: finalState.reason,
      stopReason: finalState.stopReason,
      usage: finalState.usage,
      limits: {
        maxTurns: effectiveMaxTurns,
        timeoutMs: effectiveTimeoutMs,
        maxOutputChars: effectiveMaxOutputChars,
      },
      allowedTools: Array.from(allowedToolNames),
    };
    const completed = await completeAgentRun(run.runId, { status, result });
    await publish({
      type: 'subagent_done',
      status,
      label: run.label,
      task: run.task,
      result,
      durationMs: completed?.durationMs ?? null,
    });

    return {
      runId: run.runId,
      parentRunId,
      rootRunId: run.rootRunId,
      status,
      label: run.label,
      task: run.task,
      text: result.text,
      reason: finalState.reason,
      stopReason: finalState.stopReason,
      usage: finalState.usage,
      limits: result.limits,
      allowedTools: result.allowedTools,
      ...(result.truncated ? { truncated: true, fullTextLength: result.fullTextLength } : {}),
      durationMs: completed?.durationMs ?? null,
    };
  } catch (err) {
    const status = child.signal.aborted ? 'aborted' : 'error';
    const error = err.message || String(err);
    const completed = await completeAgentRun(run.runId, { status, error });
    await publish({ type: 'subagent_done', status, label: run.label, task: run.task, error, durationMs: completed?.durationMs ?? null });
    return {
      runId: run.runId,
      parentRunId,
      rootRunId: run.rootRunId,
      status,
      label: run.label,
      task: run.task,
      text: '',
      reason: status,
      error,
      durationMs: completed?.durationMs ?? null,
    };
  } finally {
    child.cleanup();
  }
}
