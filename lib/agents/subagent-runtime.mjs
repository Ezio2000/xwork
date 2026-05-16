import { queryLoop } from '../query-loop.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun } from './runs.mjs';

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_TURNS = 4;
const DEFAULT_TIMEOUT_MS = 120_000;

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

function buildSubagentHistory({ task, instructions, parentSummary }) {
  const systemParts = [
    'You are a focused subagent working for a parent assistant.',
    'Complete the delegated task independently and return a concise, useful result.',
    'Do not ask the user follow-up questions. State any assumptions or gaps in the final result.',
    instructions ? `Additional instructions:\n${instructions}` : '',
    parentSummary ? `Relevant parent context:\n${parentSummary}` : '',
  ].filter(Boolean);

  return [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: task },
  ];
}

export async function runSubagent({
  task,
  instructions = '',
  label = '',
  parentSummary = '',
  parentRunId = null,
  parentToolCallId = null,
  depth = 0,
  config,
  context = {},
  signal,
  emitEvent,
  maxTurns = DEFAULT_MAX_TURNS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxDepth = DEFAULT_MAX_DEPTH,
  streamChat,
  runTool,
}) {
  if (depth >= maxDepth) {
    throw new Error(`Subagent depth limit reached (${maxDepth})`);
  }

  const run = await createAgentRun({
    role: 'subagent',
    parentRunId,
    rootRunId: context.rootRunId || parentRunId || null,
    conversationId: context.conversationId || null,
    channelId: context.channelId || null,
    model: context.model || config?.model || null,
    task,
    label,
    depth: depth + 1,
    parentToolCallId,
  });

  const publish = async (event) => {
    const { type, ...rest } = event;
    const payload = { runId: run.runId, parentRunId, eventType: type, ...rest };
    emitEvent?.(payload);
    await appendAgentRunEvent(run.runId, event).catch(() => {});
  };

  await publish({
    type: 'subagent_start',
    label: run.label,
    task: truncate(task, 1000),
    depth: run.depth,
    parentToolCallId,
  });

  const child = childSignal(signal, timeoutMs);
  const history = buildSubagentHistory({ task, instructions, parentSummary });
  let finalState;

  try {
    const iterator = queryLoop({
      config,
      history,
      maxTurns,
      signal: child.signal,
      streamChat: streamChat || config?.streamChat,
      runTool: runTool || config?.runTool,
      toolContext: {
        ...context,
        agentRunId: run.runId,
        parentRunId: run.runId,
        rootRunId: context.rootRunId || parentRunId || run.runId,
        agentDepth: run.depth,
        emitAgentEvent: emitEvent,
        runSubagent,
        subagentConfig: config,
      },
      onDelta: (delta) => {
        publish({ type: 'subagent_delta', text: delta }).catch(() => {});
      },
      onThinkingDelta: (thinkingText) => {
        publish({ type: 'subagent_thinking', text: truncate(thinkingText, 2000) }).catch(() => {});
      },
      onServerToolEvent: (event) => {
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
          ...(evt.renderType ? { renderType: evt.renderType, data: evt.data } : {}),
        });
      }
      iterResult = await iterator.next();
    }

    finalState = iterResult.value;
    const status = finalState.reason === 'completed' ? 'completed' : finalState.reason;
    const result = {
      text: truncate(finalState.text, 12000),
      reason: finalState.reason,
      stopReason: finalState.stopReason,
      usage: finalState.usage,
    };
    await completeAgentRun(run.runId, { status, result });
    await publish({
      type: 'subagent_done',
      status,
      label: run.label,
      task: run.task,
      result,
    });

    return {
      runId: run.runId,
      status,
      text: result.text,
      reason: finalState.reason,
      stopReason: finalState.stopReason,
      usage: finalState.usage,
    };
  } catch (err) {
    const status = child.signal.aborted ? 'aborted' : 'error';
    const error = err.message || String(err);
    await completeAgentRun(run.runId, { status, error });
    await publish({ type: 'subagent_done', status, label: run.label, task: run.task, error });
    return {
      runId: run.runId,
      status,
      text: '',
      reason: status,
      error,
    };
  } finally {
    child.cleanup();
  }
}
