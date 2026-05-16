import { assistantMessage } from './api.mjs';
import { resolveChatChannel } from './channels.mjs';
import { queryLoop } from './query-loop.mjs';
import { startSse, writeSse, writeSseDone, writeSseError } from './sse-writer.mjs';
import * as storage from './storage.mjs';
import { getEnabledToolDefinitions } from './tools/registry.mjs';
import { appendToolRun } from './tools/runs.mjs';
import { SchemaValidationError, validateChatRequest } from './schema.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun } from './agents/runs.mjs';
import { runSubagent } from './agents/subagent-runtime.mjs';

function titleFromMessage(message) {
  return message.slice(0, 50) + (message.length > 50 ? '…' : '');
}

function makeServerToolEventHandler({ res, conversationId, channelId, model }) {
  const serverToolInputs = new Map();
  const serverToolStartedAt = new Map();

  return (event) => {
    if (event.phase === 'call') {
      serverToolInputs.set(event.id, event.input || {});
      serverToolStartedAt.set(event.id, Date.now());
      writeSse(res, {
        type: 'tool_call',
        tools: [{ id: event.id, name: event.name, input: event.input || {} }],
      });
      return;
    }

    if (event.phase !== 'result') return;

    const input = serverToolInputs.get(event.id) || {};
    const startedAt = serverToolStartedAt.get(event.id) || Date.now();
    const durationMs = Date.now() - startedAt;
    const output = {
      ...(event.data || {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    };

    appendToolRun({
      id: event.id,
      name: event.name,
      isError: event.isError,
      input,
      output,
      durationMs,
      context: { conversationId, channelId, model, adapter: event.name },
    }).catch(() => {});

    writeSse(res, {
      type: 'tool_result',
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

async function loadConversationState(conversationId) {
  let history = [];
  let existingTitle = '';
  let originalMessageCount = 0;

  if (conversationId) {
    const convo = await storage.getConversation(conversationId);
    if (convo) {
      history = convo.messages;
      existingTitle = convo.title || '';
      originalMessageCount = history.length;
    }
  }

  return { history, existingTitle, originalMessageCount };
}

function buildStoredMessages({ history, originalMessageCount, finalState, model, agentRuns }) {
  const mergedResult = {
    ...(finalState.result || {}),
    text: finalState.text,
    content: finalState.content,
    serverToolEvents: finalState.serverToolEvents,
    builtinToolResults: finalState.builtinToolResults || [],
    agentRuns,
    __toolResults: finalState.messages,
  };

  const storeMessages = [...history.slice(0, originalMessageCount + 1)];
  storeMessages.push(assistantMessage(mergedResult, model));
  return storeMessages;
}

async function runChatRequest({ res, payload, ac }) {
  const { conversationId, message, channelId, model } = payload;

  const resolved = await resolveChatChannel({ channelId, model });
  if (resolved.error) {
    res.status(400).json({ error: resolved.error });
    return;
  }

  const { channel, requestModel } = resolved;
  const enabledTools = await getEnabledToolDefinitions();
  const channelConfig = {
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    model: requestModel,
    maxTokens: channel.maxTokens,
    extraHeaders: channel.extraHeaders,
    tools: enabledTools,
  };

  const { history, existingTitle, originalMessageCount } = await loadConversationState(conversationId);
  history.push({ role: 'user', content: message });

  startSse(res);
  const rootRun = await createAgentRun({
    role: 'root',
    conversationId,
    channelId: channel.id,
    model: requestModel,
    task: message,
    label: titleFromMessage(message),
    depth: 0,
  });
  const childAgentRuns = [];

  const emitAgentEvent = (event) => {
    if (event.eventType === 'subagent_done') {
      childAgentRuns.push({
        runId: event.runId,
        parentRunId: event.parentRunId || rootRun.runId,
        status: event.status,
        label: event.label || 'Subagent',
        task: event.task || '',
        result: event.result || null,
        error: event.error || null,
      });
    }
    writeSse(res, { type: 'agent_event', ...event });
  };

  writeSse(res, {
    type: 'agent_event',
    runId: rootRun.runId,
    role: 'root',
    event: 'root_start',
  });

  try {
    const iterator = queryLoop({
      config: channelConfig,
      history,
      maxTurns: 5,
      signal: ac.signal,
      toolContext: {
        conversationId,
        channelId: channel.id,
        model: requestModel,
        agentRunId: rootRun.runId,
        rootRunId: rootRun.runId,
        agentDepth: 0,
        emitAgentEvent,
        runSubagent,
        subagentConfig: channelConfig,
      },
      onDelta: (delta) => writeSse(res, { type: 'delta', text: delta }),
      onThinkingDelta: (thinkingText) => writeSse(res, { type: 'thinking', text: thinkingText }),
      onServerToolEvent: makeServerToolEventHandler({
        res,
        conversationId,
        channelId: channel.id,
        model: requestModel,
      }),
    });

    let iterResult = await iterator.next();
    while (!iterResult.done) {
      const evt = iterResult.value;
      if (evt.type === 'tool_call') {
        writeSse(res, {
          type: 'tool_call',
          tools: [{ id: evt.id, name: evt.name, input: evt.input }],
        });
      } else if (evt.type === 'tool_result') {
        writeSse(res, {
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
      }
      iterResult = await iterator.next();
    }

    const finalState = iterResult.value;
    await completeAgentRun(rootRun.runId, {
      status: finalState.reason === 'completed' ? 'completed' : finalState.reason,
      result: {
        text: finalState.text,
        reason: finalState.reason,
        stopReason: finalState.stopReason,
        usage: finalState.usage,
      },
    });
    await appendAgentRunEvent(rootRun.runId, {
      type: 'root_done',
      status: finalState.reason,
      stopReason: finalState.stopReason,
      usage: finalState.usage,
    }).catch(() => {});

    const storeMessages = buildStoredMessages({ history, originalMessageCount, finalState, model: requestModel, agentRuns: childAgentRuns });
    const title = originalMessageCount === 0 || existingTitle === 'New Chat'
      ? titleFromMessage(message)
      : undefined;

    if (conversationId) {
      try {
        await storage.saveConversationUnlocked(conversationId, storeMessages, title);
      } catch (err) {
        console.error('[chat] failed to save conversation:', err);
      }
    }

    writeSse(res, { type: 'done', stopReason: finalState.stopReason, usage: finalState.usage });
    writeSseDone(res);
  } catch (err) {
    await completeAgentRun(rootRun.runId, {
      status: ac.signal.aborted ? 'aborted' : 'error',
      error: err.message || String(err),
    }).catch(() => {});
    writeSseError(res, err);
  }
}

export async function handleChatRequest(req, res) {
  let payload;
  try {
    payload = validateChatRequest(req.body || {});
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  if (!payload.conversationId) {
    await runChatRequest({ res, payload, ac });
    return;
  }

  await storage.withConversationQueue(payload.conversationId, () => (
    runChatRequest({ res, payload, ac })
  ));
}
