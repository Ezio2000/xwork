export const RUN_EVENT_TYPES = Object.freeze({
  CHAT_RUN_START: 'chat_run_start',
  DELTA: 'delta',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_DELTA: 'tool_delta',
  TOOL_RESULT: 'tool_result',
  AGENT_EVENT: 'agent_event',
  DONE: 'done',
  ERROR: 'error',
});

export const AGENT_EVENT_TYPES = Object.freeze({
  ROOT_START: 'root_start',
  ROOT_DONE: 'root_done',
  ROOT_ERROR: 'root_error',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  SUBAGENT_START: 'subagent_start',
  SUBAGENT_DELTA: 'subagent_delta',
  SUBAGENT_THINKING: 'subagent_thinking',
  SUBAGENT_TOOL_CALL: 'subagent_tool_call',
  SUBAGENT_TOOL_RESULT: 'subagent_tool_result',
  SUBAGENT_SERVER_TOOL: 'subagent_server_tool',
  SUBAGENT_DONE: 'subagent_done',
});

export function eventType(event) {
  return event?.eventType || event?.event || event?.type || '';
}

export function isTransientAgentEvent(event) {
  const type = eventType(event);
  return type === AGENT_EVENT_TYPES.SUBAGENT_DELTA || type === AGENT_EVENT_TYPES.SUBAGENT_THINKING;
}

export function chatDeltaEvent(text) {
  return { type: RUN_EVENT_TYPES.DELTA, text };
}

export function thinkingEvent(text) {
  return { type: RUN_EVENT_TYPES.THINKING, text };
}

export function doneEvent({ stopReason, usage } = {}) {
  return { type: RUN_EVENT_TYPES.DONE, stopReason, usage };
}

export function errorEvent(message) {
  return { type: RUN_EVENT_TYPES.ERROR, message };
}
