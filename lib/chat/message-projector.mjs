import { assistantMessage } from '../api.mjs';

export function titleFromMessage(message) {
  const text = String(message || 'Image chat');
  return text.slice(0, 50) + (text.length > 50 ? '…' : '');
}

export function assistantTurnResult({ finalState, agentRuns, trace }) {
  return {
    ...(finalState.result || {}),
    text: finalState.text,
    content: finalState.content,
    serverToolEvents: finalState.serverToolEvents,
    builtinToolResults: finalState.builtinToolResults || [],
    agentRuns,
    __toolResults: trace?.messages || finalState.messages,
    trace,
  };
}

export function buildStoredMessages({ history, originalMessageCount, finalState, model, agentRuns, trace }) {
  const storeMessages = [...history.slice(0, originalMessageCount + 1)];
  storeMessages.push(assistantMessage(assistantTurnResult({ finalState, agentRuns, trace }), model));
  return storeMessages;
}
