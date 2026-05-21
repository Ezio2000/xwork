import { appendAgentRunEvent } from './agents/runs.mjs';
import { appendToolRun as defaultAppendToolRun } from './tools/runs.mjs';
import { RUN_EVENT_TYPES } from './run-events.mjs';

export function serverToolOutput(event) {
  return {
    ...(event.data || {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
}

export function makeServerToolEventHandler({
  emit,
  conversationId,
  channelId,
  model,
  rootRunId,
  audit,
  appendToolRun = defaultAppendToolRun,
  appendRunEvent = appendAgentRunEvent,
}) {
  const serverToolInputs = new Map();
  const serverToolStartedAt = new Map();

  return async (event) => {
    if (event.phase === 'call') {
      serverToolInputs.set(event.id, event.input || {});
      serverToolStartedAt.set(event.id, Date.now());
      audit?.record('server_tool_call', {
        runId: rootRunId,
        toolCallId: event.id,
        name: event.name,
        input: event.input || {},
      });
      if (rootRunId) {
        appendRunEvent(rootRunId, {
          type: 'server_tool_call',
          toolCallId: event.id,
          name: event.name,
          input: event.input || {},
        }).catch(() => {});
      }
      emit({
        type: RUN_EVENT_TYPES.TOOL_CALL,
        tools: [{ id: event.id, name: event.name, input: event.input || {} }],
      });
      return;
    }

    if (event.phase !== 'result') return;

    const input = serverToolInputs.get(event.id) || {};
    const startedAt = serverToolStartedAt.get(event.id) || Date.now();
    const durationMs = Date.now() - startedAt;
    const output = serverToolOutput(event);
    const context = {
      source: 'runtime',
      environment: process.env.NODE_ENV || 'development',
      conversationId,
      channelId,
      model,
      adapter: event.name,
      agentRunId: rootRunId,
      rootRunId,
    };

    appendToolRun({
      id: event.id,
      name: event.name,
      isError: event.isError,
      input,
      output,
      durationMs,
      context,
    }).catch(() => {});
    audit?.record('server_tool_result', {
      runId: rootRunId,
      toolCallId: event.id,
      name: event.name,
      isError: event.isError,
      input,
      output,
      durationMs,
      renderType: event.renderType,
    });
    if (rootRunId) {
      appendRunEvent(rootRunId, {
        type: 'server_tool_result',
        toolCallId: event.id,
        name: event.name,
        isError: event.isError,
        durationMs,
        renderType: event.renderType,
      }).catch(() => {});
    }

    emit({
      type: RUN_EVENT_TYPES.TOOL_RESULT,
      tools: [{
        id: event.id,
        name: event.name,
        isError: event.isError,
        durationMs,
        input,
        renderType: event.renderType,
        data: event.data,
      }],
    });
  };
}
