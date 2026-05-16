function jsonClone(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function cloneArray(value) {
  return Array.isArray(value) ? jsonClone(value) : [];
}

export function createAuditRecorder() {
  const events = [];

  return {
    events,
    record(type, payload = {}) {
      const event = {
        type,
        createdAt: new Date().toISOString(),
        ...jsonClone(payload),
      };
      events.push(event);
      return event;
    },
  };
}

export function buildAuditTrace({
  conversationId = null,
  channelId = null,
  model = null,
  rootRun = null,
  status = null,
  finalState = {},
  turnStartIndex = 0,
  events = [],
  toolCalls = [],
  toolResults = [],
  agentRuns = [],
} = {}) {
  const messages = Array.isArray(finalState.messages)
    ? finalState.messages.slice(turnStartIndex)
    : [];

  return {
    schemaVersion: 1,
    kind: 'assistant_turn',
    conversationId,
    channelId,
    model,
    rootRunId: rootRun?.runId || null,
    status,
    reason: finalState.reason || null,
    stopReason: finalState.stopReason || null,
    usage: finalState.usage || null,
    startedAt: rootRun?.startedAt || null,
    completedAt: rootRun?.completedAt || null,
    durationMs: rootRun?.durationMs ?? null,
    messages: cloneArray(messages),
    toolCalls: cloneArray(toolCalls),
    toolResults: cloneArray(toolResults),
    serverToolEvents: cloneArray(finalState.serverToolEvents || []),
    agentRuns: cloneArray(agentRuns),
    events: cloneArray(events),
  };
}
