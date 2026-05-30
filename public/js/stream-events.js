export const STREAM_EVENT_TYPES = Object.freeze({
  CHAT_RUN_START: 'chat_run_start',
  DELTA: 'delta',
  ASSISTANT_RETRY: 'assistant_retry',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_DELTA: 'tool_delta',
  TOOL_RESULT: 'tool_result',
  ASK_USER_PENDING: 'ask_user_pending',
  AGENT_EVENT: 'agent_event',
  DONE: 'done',
  ERROR: 'error',
});

export const STREAM_AGENT_EVENT_TYPES = Object.freeze({
  ROOT_START: 'root_start',
  SUBAGENT_START: 'subagent_start',
  SUBAGENT_DELTA: 'subagent_delta',
  SUBAGENT_THINKING: 'subagent_thinking',
  SUBAGENT_TOOL_CALL: 'subagent_tool_call',
  SUBAGENT_TOOL_RESULT: 'subagent_tool_result',
  SUBAGENT_SERVER_TOOL: 'subagent_server_tool',
  SUBAGENT_DONE: 'subagent_done',
});

export function streamAgentEventType(evt) {
  return evt.eventType || evt.type || evt.event || '';
}
