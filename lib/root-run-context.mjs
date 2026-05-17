import { buildAuditTrace, createAuditRecorder } from './audit-trace.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun, getAgentRunsByIds } from './agents/runs.mjs';

function eventType(event) {
  return event?.eventType || event?.event || event?.type;
}

export function isTransientSubagentEvent(event) {
  const type = eventType(event);
  return type === 'subagent_delta' || type === 'subagent_thinking';
}

function completionStatus(reason) {
  return reason === 'completed' ? 'completed' : reason;
}

export async function createRootRunContext({
  runId,
  conversationId = null,
  channelId = null,
  model = null,
  task = '',
  label = '',
  emit = () => {},
  source = 'runtime',
  environment = process.env.NODE_ENV || 'development',
  createRun = createAgentRun,
  appendRunEvent = appendAgentRunEvent,
  completeRun = completeAgentRun,
  getRunsByIds = getAgentRunsByIds,
} = {}) {
  const rootRun = await createRun({
    runId,
    role: 'root',
    conversationId,
    channelId,
    model,
    source,
    environment,
    task,
    label,
    depth: 0,
  });
  const childAgentRuns = [];
  const childAgentRunIds = new Set();
  const childAgentEvents = new Map();
  const rootToolCalls = [];
  const rootToolResults = [];
  const audit = createAuditRecorder();

  const fireAndForgetAppend = (event) => {
    appendRunEvent(rootRun.runId, event).catch(() => {});
  };

  const emitAgentEvent = (event) => {
    const transient = isTransientSubagentEvent(event);
    if (event.runId && !transient) {
      const events = childAgentEvents.get(event.runId) || [];
      events.push({
        id: event.id,
        createdAt: new Date().toISOString(),
        type: eventType(event),
        ...event,
      });
      childAgentEvents.set(event.runId, events);
    }

    if (event.eventType === 'subagent_done') {
      childAgentRunIds.add(event.runId);
      childAgentRuns.push({
        runId: event.runId,
        parentRunId: event.parentRunId || rootRun.runId,
        rootRunId: rootRun.runId,
        status: event.status,
        label: event.label || 'Subagent',
        task: event.task || '',
        result: event.result || null,
        error: event.error || null,
        durationMs: event.durationMs,
        events: childAgentEvents.get(event.runId) || [],
      });
    }

    if (!transient) audit.record('agent_event', event);
    emit({ type: 'agent_event', ...event });
  };

  return {
    rootRun,
    audit,
    emitAgentEvent,

    recordRootStart() {
      emit({
        type: 'agent_event',
        runId: rootRun.runId,
        role: 'root',
        event: 'root_start',
      });
      audit.record('root_start', {
        runId: rootRun.runId,
        conversationId,
        channelId,
        model,
        task,
      });
      fireAndForgetAppend({
        type: 'root_start',
        conversationId,
        channelId,
        model,
        task,
      });
    },

    recordToolCall(evt) {
      const call = {
        toolCallId: evt.id,
        name: evt.name,
        input: evt.input || {},
        runId: rootRun.runId,
        createdAt: new Date().toISOString(),
      };
      rootToolCalls.push(call);
      audit.record('tool_call', {
        runId: rootRun.runId,
        toolCallId: evt.id,
        name: evt.name,
        input: evt.input || {},
      });
      fireAndForgetAppend({
        type: 'tool_call',
        toolCallId: evt.id,
        name: evt.name,
        input: evt.input || {},
      });
      emit({
        type: 'tool_call',
        tools: [{ id: evt.id, name: evt.name, input: evt.input }],
      });
    },

    recordToolResult(evt) {
      const result = {
        toolCallId: evt.id,
        name: evt.name,
        isError: evt.isError,
        durationMs: evt.durationMs,
        input: evt.input || {},
        output: evt.output,
        renderType: evt.renderType,
        data: evt.data,
        runId: rootRun.runId,
        createdAt: new Date().toISOString(),
      };
      rootToolResults.push(result);
      audit.record('tool_result', {
        runId: rootRun.runId,
        toolCallId: evt.id,
        name: evt.name,
        isError: evt.isError,
        durationMs: evt.durationMs,
        input: evt.input || {},
        output: evt.output,
        renderType: evt.renderType,
        data: evt.data,
      });
      fireAndForgetAppend({
        type: 'tool_result',
        toolCallId: evt.id,
        name: evt.name,
        isError: evt.isError,
        durationMs: evt.durationMs,
        renderType: evt.renderType,
        output: evt.output,
      });
      emit({
        type: 'tool_result',
        tools: [{
          id: evt.id,
          name: evt.name,
          isError: evt.isError,
          durationMs: evt.durationMs,
          input: evt.input,
          ...(evt.renderType ? { renderType: evt.renderType, data: evt.data } : {}),
        }],
      });
    },

    async completeAndBuildTrace(finalState, { turnStartIndex = 0 } = {}) {
      const completedRootRun = await completeRun(rootRun.runId, {
        status: completionStatus(finalState.reason),
        result: {
          text: finalState.text,
          reason: finalState.reason,
          stopReason: finalState.stopReason,
          usage: finalState.usage,
        },
      });
      fireAndForgetAppend({
        type: 'root_done',
        status: finalState.reason,
        stopReason: finalState.stopReason,
        usage: finalState.usage,
      });
      audit.record('root_done', {
        runId: rootRun.runId,
        status: finalState.reason,
        stopReason: finalState.stopReason,
        usage: finalState.usage,
      });

      const storedChildRuns = await getRunsByIds([...childAgentRunIds]);
      const agentRuns = childAgentRuns.map(run => {
        const stored = storedChildRuns.find(item => item.runId === run.runId);
        return {
          ...(stored || run),
          events: childAgentEvents.get(run.runId) || stored?.events || run.events || [],
        };
      });
      const trace = buildAuditTrace({
        conversationId,
        channelId,
        model,
        rootRun: completedRootRun || rootRun,
        status: completionStatus(finalState.reason),
        finalState,
        turnStartIndex,
        events: audit.events,
        toolCalls: rootToolCalls,
        toolResults: rootToolResults,
        agentRuns,
      });

      return { completedRootRun: completedRootRun || rootRun, agentRuns, trace };
    },

    async recordError(err, { aborted = false } = {}) {
      const status = aborted ? 'aborted' : 'error';
      const error = err.message || String(err);
      fireAndForgetAppend({ type: 'root_error', status, error });
      await completeRun(rootRun.runId, { status, error }).catch(() => {});
    },
  };
}
