import { buildAuditTrace, createAuditRecorder } from './audit-trace.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun, getAgentRunsByIds } from './agents/runs.mjs';
import { AGENT_EVENT_TYPES, RUN_EVENT_TYPES, eventType, isTransientAgentEvent } from './run-events.mjs';

export function isTransientSubagentEvent(event) {
  return isTransientAgentEvent(event);
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

    if (event.eventType === AGENT_EVENT_TYPES.SUBAGENT_DONE) {
      childAgentRunIds.add(event.runId);
      childAgentRuns.push({
        runId: event.runId,
        parentRunId: event.parentRunId || rootRun.runId,
        rootRunId: rootRun.runId,
        status: event.status,
        label: event.label || event.expertAgent?.title || 'Expert Agent',
        task: event.task || '',
        expertAgent: event.expertAgent || event.result?.expertAgent || null,
        result: event.result || null,
        error: event.error || null,
        durationMs: event.durationMs,
        events: childAgentEvents.get(event.runId) || [],
      });
    }

    if (!transient) audit.record('agent_event', event);
    emit({ type: RUN_EVENT_TYPES.AGENT_EVENT, ...event });
  };

  return {
    rootRun,
    audit,
    emitAgentEvent,

    recordRootStart() {
      emit({
        type: RUN_EVENT_TYPES.AGENT_EVENT,
        runId: rootRun.runId,
        role: 'root',
        event: AGENT_EVENT_TYPES.ROOT_START,
      });
      audit.record('root_start', {
        runId: rootRun.runId,
        conversationId,
        channelId,
        model,
        task,
      });
      fireAndForgetAppend({
        type: AGENT_EVENT_TYPES.ROOT_START,
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
        type: AGENT_EVENT_TYPES.TOOL_CALL,
        toolCallId: evt.id,
        name: evt.name,
        input: evt.input || {},
      });
      emit({
        type: RUN_EVENT_TYPES.TOOL_CALL,
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
        type: AGENT_EVENT_TYPES.TOOL_RESULT,
        toolCallId: evt.id,
        name: evt.name,
        isError: evt.isError,
        durationMs: evt.durationMs,
        renderType: evt.renderType,
        output: evt.output,
      });
      emit({
        type: RUN_EVENT_TYPES.TOOL_RESULT,
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
        type: AGENT_EVENT_TYPES.ROOT_DONE,
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
      fireAndForgetAppend({ type: AGENT_EVENT_TYPES.ROOT_ERROR, status, error });
      await completeRun(rootRun.runId, { status, error }).catch(() => {});
    },
  };
}
