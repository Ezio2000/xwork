import { queryLoop } from '../query-loop.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun } from './runs.mjs';
import { DEFAULT_EXPERT_ALLOWED_TOOLS, resolveExpertAgentForRun } from './profiles.mjs';
import { readConfig } from '../config-store.mjs';
import { firstModelId, findChannelModel } from '../channels.mjs';
import { streamChat as defaultStreamChat } from '../api.mjs';
import { appendToolRun as defaultAppendToolRun } from '../tools/runs.mjs';
import { runTool as defaultRunTool } from '../tools/runner.mjs';
import { createToolBudgetGuard } from '../tools/budget.mjs';
import { AGENT_EVENT_TYPES, RUN_EVENT_TYPES, isTransientAgentEvent } from '../run-events.mjs';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_CHARS = 2000;
const MAX_MAX_TURNS = 100;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 8000;
const MAX_MAX_DEPTH = 4;

function childSignal(parentSignal, timeoutMs) {
  const ac = new AbortController();
  let timer = null;

  const abort = () => {
    if (!ac.signal.aborted) ac.abort(parentSignal?.reason || new Error('Parent run aborted'));
  };
  if (parentSignal?.aborted) {
    ac.abort(parentSignal.reason || new Error('Parent run aborted'));
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', abort, { once: true });
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      if (!ac.signal.aborted) ac.abort(new Error(`Subagent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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

function resolveAllowedToolNames({ profile, allowedTools, allowSubagents }) {
  const profileTools = Array.isArray(profile?.allowedTools)
    ? profile.allowedTools
    : DEFAULT_EXPERT_ALLOWED_TOOLS;
  const names = new Set(profileTools.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()));
  if (Array.isArray(allowedTools)) {
    const requested = new Set(allowedTools.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()));
    for (const name of [...names]) {
      if (!requested.has(name)) names.delete(name);
    }
  }
  if (!allowSubagents) {
    names.delete('delegate_task');
  }
  names.delete('ask_user');
  return names;
}

function filterConfigTools(config, allowedNames) {
  const tools = Array.isArray(config?.tools) ? config.tools : [];
  return {
    ...(config || {}),
    tools: tools.filter(tool => allowedNames.has(tool?.name)),
  };
}

function clampLimit(value, fallback, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

async function resolveProfileChannelConfig({ config, profile }) {
  const model = typeof profile?.model === 'string' ? profile.model.trim() : '';
  const channelId = typeof profile?.channelId === 'string' ? profile.channelId.trim() : '';
  if (!channelId && !model) return { config, fallbackReason: '' };

  if (!channelId) {
    return { config: { ...(config || {}), ...(model ? { model } : {}) }, fallbackReason: '' };
  }

  try {
    const appConfig = await readConfig();
    const channel = appConfig.channels.find(item => item.id === channelId);
    if (!channel) return { config, fallbackReason: 'expert channel not found' };
    if (!channel.apiKey) return { config, fallbackReason: 'expert channel has no API key' };
    let requestModel = model || appConfig.activeModel || firstModelId(channel) || config?.model || '';
    if (channel.models?.length && !findChannelModel(channel, requestModel)) {
      requestModel = firstModelId(channel);
    }
    return {
      config: {
        ...(config || {}),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        model: requestModel,
        maxTokens: channel.maxTokens || config?.maxTokens,
        maxTurns: channel.maxTurns || config?.maxTurns,
        extraHeaders: channel.extraHeaders || {},
      },
      fallbackReason: '',
    };
  } catch (err) {
    return { config, fallbackReason: err.message || 'failed to resolve expert channel' };
  }
}

function shouldPersistEvent(event) {
  return !isTransientAgentEvent(event);
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

function buildSubagentHistory({ objective, task, brief, expectedOutput, instructions, parentSummary, allowedToolNames, allowSubagents, maxTurns, profile }) {
  const resolvedObjective = objective || task;
  const resolvedBrief = brief || parentSummary;
  const resolvedExpectedOutput = expectedOutput || instructions || profile?.outputContract;
  const canDelegate = allowSubagents && allowedToolNames.has('delegate_task');
  const systemParts = [
    'You are a focused expert agent working for a parent assistant.',
    profile?.title ? `Expert profile: ${profile.title}.` : '',
    profile?.description ? `Profile description: ${profile.description}` : '',
    'You have fresh context. You cannot see the parent conversation unless it is included in this prompt.',
    'Work only on the single delegated objective. Do not broaden the task, take ownership of adjacent work, or solve unrelated parts of the parent request.',
    'Your entire output is pasted verbatim into the parent conversation. Every word costs the parent tokens.',
    profile?.systemPrompt ? `Expert instructions:\n${profile.systemPrompt}` : '',
    resolvedExpectedOutput ? `OUTPUT CONTRACT — follow it strictly:\n${resolvedExpectedOutput}` : '',
    'Do not ask the user follow-up questions. State any assumptions or gaps in the final result.',
    `Available tools: ${Array.from(allowedToolNames).join(', ') || 'none'}.`,
    canDelegate
      ? 'Nested delegation is allowed only if the next subagent has one narrower objective and will materially reduce work.'
      : 'Do not create subagents. Finish this delegated objective directly with your available tools.',
    'Expected output: raw facts only. 3-6 bullets. No introductions, conclusions, or meta. If the parent needed prose it would not have delegated.',
    `Turn budget: ${maxTurns} turns. Each turn = one assistant response + tool results. Parallel tool calls in one response count as one turn. You MUST reserve the last turn to write your final answer. If you are running low on turns, stop calling tools and write your conclusion now.`,
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

function appendFinalSummaryInstruction(messages = [], instruction) {
  const out = messages.map(message => ({
    ...message,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
  }));
  const textBlock = { type: 'text', text: instruction };
  const last = out[out.length - 1];

  if (last?.role === 'user') {
    if (Array.isArray(last.content)) {
      last.content = [...last.content, textBlock];
    } else if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content }, textBlock];
    } else {
      last.content = [textBlock];
    }
    return out;
  }

  out.push({ role: 'user', content: instruction });
  return out;
}

function finalSummaryInstruction({ expectedOutput, maxTurns }) {
  return [
    `The expert-agent turn budget (${maxTurns} turns) has been reached.`,
    'No tools are available in this finalization call. Do not request or simulate tool calls.',
    'Write the final answer now using only the conversation and tool results already present above.',
    expectedOutput ? `Follow this output contract:\n${expectedOutput}` : '',
    'Be concise. If evidence is incomplete, state the gap or assumption directly.',
  ].filter(Boolean).join('\n\n');
}

async function summarizeAfterMaxTurns({
  finalState,
  subagentConfig,
  selectedStreamChat,
  childSignal,
  publish,
  expectedOutput,
  effectiveMaxTurns,
}) {
  if (finalState?.reason !== 'max_turns' || childSignal?.aborted) return finalState;

  let summaryError = null;
  const summaryConfig = { ...(subagentConfig || {}), tools: [] };
  const summaryMessages = appendFinalSummaryInstruction(
    finalState.messages || [],
    finalSummaryInstruction({ expectedOutput, maxTurns: effectiveMaxTurns }),
  );

  let summaryResult;
  try {
    summaryResult = await selectedStreamChat(
      summaryConfig,
      summaryMessages,
      (delta) => {
        publish({ type: AGENT_EVENT_TYPES.SUBAGENT_DELTA, text: delta }).catch(() => {});
      },
      (thinkingText) => {
        publish({ type: AGENT_EVENT_TYPES.SUBAGENT_THINKING, text: truncate(thinkingText, 2000) }).catch(() => {});
      },
      () => {},
      (err) => {
        summaryError = err;
      },
      () => {},
      { signal: childSignal },
    );
  } catch (err) {
    summaryError = err;
  }

  const summaryText = String(summaryResult?.text || '').trim();
  const triedToolCall = Boolean(summaryResult?.toolCalls?.length) || summaryResult?.stopReason === 'tool_use';
  if (summaryError || !summaryText || triedToolCall) {
    return {
      ...finalState,
      forcedSummary: {
        attempted: true,
        success: false,
        ...(summaryError ? { error: summaryError.message || String(summaryError) } : {}),
        ...(triedToolCall ? { error: 'final summary attempted to call tools' } : {}),
      },
    };
  }

  const messages = [
    ...summaryMessages,
    {
      role: 'assistant',
      content: Array.isArray(summaryResult.content) && summaryResult.content.length
        ? summaryResult.content
        : [{ type: 'text', text: summaryText }],
    },
  ];

  return {
    ...finalState,
    reason: 'max_turns_summarized',
    messages,
    text: summaryText,
    content: summaryResult.content || finalState.content,
    stopReason: summaryResult.stopReason || finalState.stopReason,
    usage: summaryResult.usage || finalState.usage,
    result: summaryResult || finalState.result,
    forcedSummary: {
      attempted: true,
      success: true,
      previousReason: 'max_turns',
    },
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
  maxTurns = null,
  timeoutMs = null,
  maxOutputChars = null,
  maxDepth = null,
  expertAgentId = null,
  streamChat,
  runTool,
}) {
  const profileResolution = await resolveExpertAgentForRun(expertAgentId);
  const profile = profileResolution.profile;
  const effectiveMaxDepth = clampLimit(maxDepth ?? profile.maxDepth, profile.maxDepth || DEFAULT_MAX_DEPTH, { min: 1, max: MAX_MAX_DEPTH });
  if (depth >= effectiveMaxDepth) {
    throw new Error(`Subagent depth limit reached (${effectiveMaxDepth})`);
  }

  const effectiveAllowSubagents = allowSubagents === true || profile.allowSubagents === true;
  const effectiveMaxTurns = limitNumber(maxTurns ?? profile.maxTurns, DEFAULT_MAX_TURNS, { min: 1, max: MAX_MAX_TURNS });
  const effectiveTimeoutMs = limitNumber(timeoutMs ?? profile.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 1000, max: MAX_TIMEOUT_MS });
  const effectiveMaxOutputChars = limitNumber(maxOutputChars ?? profile.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, { min: 500, max: MAX_OUTPUT_CHARS });
  const allowedToolNames = resolveAllowedToolNames({ profile, allowedTools, allowSubagents: effectiveAllowSubagents });
  const profileChannel = await resolveProfileChannelConfig({ config, profile });
  const subagentConfig = filterConfigTools(profileChannel.config, allowedToolNames);

  const run = await createAgentRun({
    role: 'subagent',
    parentRunId,
    rootRunId: context.rootRunId || parentRunId || null,
    conversationId: context.conversationId || null,
    channelId: context.channelId || null,
    model: subagentConfig?.model || context.model || config?.model || null,
    expertAgentId: profile.id,
    expertAgentTitle: profile.title,
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
    appendAgentRunEvent(run.runId, event).catch(() => {});
  };

  await publish({
    type: AGENT_EVENT_TYPES.SUBAGENT_START,
    label: run.label,
    task: truncate(task, 1000),
    depth: run.depth,
    parentToolCallId,
    expertAgent: {
      id: profile.id,
      title: profile.title,
      requestedId: profileResolution.requestedId,
      fallbackReason: profileResolution.fallbackReason || profileChannel.fallbackReason || '',
    },
    allowedTools: Array.from(allowedToolNames),
    allowSubagents: effectiveAllowSubagents,
    limits: {
      maxTurns: effectiveMaxTurns,
      timeoutMs: effectiveTimeoutMs,
      maxOutputChars: effectiveMaxOutputChars,
      maxDepth: effectiveMaxDepth,
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
    allowSubagents: effectiveAllowSubagents,
    maxTurns: effectiveMaxTurns,
    profile,
  });
  const serverToolInputs = new Map();
  const serverToolStartedAt = new Map();
  const appendServerToolRun = config?.appendToolRun || defaultAppendToolRun;
  const selectedRunTool = buildRestrictedRunTool(runTool || config?.runTool || defaultRunTool, allowedToolNames);
  const selectedStreamChat = streamChat || config?.streamChat || defaultStreamChat;
  const toolBudgetGuard = createToolBudgetGuard(subagentConfig?.tools);
  let finalState;

  try {
    const iterator = queryLoop({
      config: subagentConfig,
      history,
      maxTurns: effectiveMaxTurns,
      signal: child.signal,
      streamChat: selectedStreamChat,
      runTool: selectedRunTool,
      beforeToolCall: toolBudgetGuard.beforeToolCall,
      toolContext: {
        ...context,
        agentRunId: run.runId,
        parentRunId: run.runId,
        rootRunId: context.rootRunId || parentRunId || run.runId,
        agentDepth: run.depth,
        allowSubagents: effectiveAllowSubagents,
        allowedTools: Array.from(allowedToolNames),
        expertAgentId: profile.id,
        expertAgentTitle: profile.title,
        emitAgentEvent: emitEvent,
        runSubagent,
        subagentConfig,
      },
      onDelta: (delta) => {
        publish({ type: AGENT_EVENT_TYPES.SUBAGENT_DELTA, text: delta }).catch(() => {});
      },
      onThinkingDelta: (thinkingText) => {
        publish({ type: AGENT_EVENT_TYPES.SUBAGENT_THINKING, text: truncate(thinkingText, 2000) }).catch(() => {});
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
              model: subagentConfig?.model || context.model || config?.model || null,
              adapter: event.name,
              agentRunId: run.runId,
              parentRunId,
              rootRunId: run.rootRunId,
              agentDepth: run.depth,
              expertAgentId: profile.id,
              expertAgentTitle: profile.title,
              toolCallId: event.id,
            },
          })).catch(() => {});
        }
        publish({ type: AGENT_EVENT_TYPES.SUBAGENT_SERVER_TOOL, event }).catch(() => {});
      },
    });

    let iterResult = await iterator.next();
    while (!iterResult.done) {
      const evt = iterResult.value;
      if (evt.type === RUN_EVENT_TYPES.TOOL_CALL) {
        await publish({
          type: AGENT_EVENT_TYPES.SUBAGENT_TOOL_CALL,
          toolCallId: evt.id,
          name: evt.name,
          input: evt.input || {},
        });
      } else if (evt.type === RUN_EVENT_TYPES.TOOL_RESULT) {
        await publish({
          type: AGENT_EVENT_TYPES.SUBAGENT_TOOL_RESULT,
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
    finalState = await summarizeAfterMaxTurns({
      finalState,
      subagentConfig,
      selectedStreamChat,
      childSignal: child.signal,
      publish,
      expectedOutput: expectedOutput || instructions || profile?.outputContract || '',
      effectiveMaxTurns,
    });
    const status = finalState.reason === 'completed' || finalState.reason === 'max_turns_summarized'
      ? 'completed'
      : finalState.reason;
    const fullText = finalState.text || '';
    const error = finalState.error || '';
    const result = {
      text: truncate(fullText, effectiveMaxOutputChars),
      ...(fullText.length > effectiveMaxOutputChars ? { truncated: true, fullTextLength: fullText.length } : {}),
      reason: finalState.reason,
      stopReason: finalState.stopReason,
      ...(error ? { error } : {}),
      usage: finalState.usage,
      expertAgent: {
        id: profile.id,
        title: profile.title,
        requestedId: profileResolution.requestedId,
        fallbackReason: profileResolution.fallbackReason || profileChannel.fallbackReason || '',
      },
      limits: {
        maxTurns: effectiveMaxTurns,
        timeoutMs: effectiveTimeoutMs,
        maxOutputChars: effectiveMaxOutputChars,
        maxDepth: effectiveMaxDepth,
      },
      allowedTools: Array.from(allowedToolNames),
      ...(finalState.forcedSummary ? { forcedSummary: finalState.forcedSummary } : {}),
    };
    const completed = await completeAgentRun(run.runId, { status, result, ...(error ? { error } : {}) });
    await publish({
      type: AGENT_EVENT_TYPES.SUBAGENT_DONE,
      status,
      label: run.label,
      task: run.task,
      result,
      ...(error ? { error } : {}),
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
      ...(error ? { error } : {}),
      usage: finalState.usage,
      expertAgent: result.expertAgent,
      limits: result.limits,
      allowedTools: result.allowedTools,
      ...(result.forcedSummary ? { forcedSummary: result.forcedSummary } : {}),
      ...(result.truncated ? { truncated: true, fullTextLength: result.fullTextLength } : {}),
      durationMs: completed?.durationMs ?? null,
    };
  } catch (err) {
    const status = child.signal.aborted ? 'aborted' : 'error';
    const error = err.message || String(err);
    const expertAgent = {
      id: profile.id,
      title: profile.title,
      requestedId: profileResolution.requestedId,
      fallbackReason: profileResolution.fallbackReason || profileChannel.fallbackReason || '',
    };
    const completed = await completeAgentRun(run.runId, { status, error, result: { expertAgent } });
    await publish({ type: AGENT_EVENT_TYPES.SUBAGENT_DONE, status, label: run.label, task: run.task, expertAgent, error, durationMs: completed?.durationMs ?? null });
    return {
      runId: run.runId,
      parentRunId,
      rootRunId: run.rootRunId,
      status,
      label: run.label,
      task: run.task,
      expertAgent,
      text: '',
      reason: status,
      error,
      durationMs: completed?.durationMs ?? null,
    };
  } finally {
    child.cleanup();
  }
}
