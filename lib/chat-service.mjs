import { assistantMessage } from './api.mjs';
import { resolveChatChannel } from './channels.mjs';
import { getChatRun, getChatRunSnapshot, startChatRun, subscribeResponseToRun } from './chat-runs.mjs';
import { queryLoop } from './query-loop.mjs';
import { createRootRunContext } from './root-run-context.mjs';
import { makeServerToolEventHandler } from './server-tool-events.mjs';
import { startSse } from './sse-writer.mjs';
import * as storage from './storage.mjs';
import { getEnabledToolDefinitions } from './tools/registry.mjs';
import { SchemaValidationError, validateChatRequest, validateSafeId } from './schema.mjs';
import { runSubagent } from './agents/subagent-runtime.mjs';

export const CHAT_SERVICE_TEST_HOOKS = {
  streamChat: null,
  runTool: null,
};

export { getChatRunSnapshot };

function titleFromMessage(message) {
  return message.slice(0, 50) + (message.length > 50 ? '…' : '');
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

function buildStoredMessages({ history, originalMessageCount, finalState, model, agentRuns, trace }) {
  const mergedResult = {
    ...(finalState.result || {}),
    text: finalState.text,
    content: finalState.content,
    serverToolEvents: finalState.serverToolEvents,
    builtinToolResults: finalState.builtinToolResults || [],
    agentRuns,
    __toolResults: finalState.messages,
    trace,
  };

  const storeMessages = [...history.slice(0, originalMessageCount + 1)];
  storeMessages.push(assistantMessage(mergedResult, model));
  return storeMessages;
}

async function runChatRequest({ payload, signal, emit, rootRunId }) {
  const { conversationId, message, channelId, model } = payload;
  let rootContext = null;

  try {
    const resolved = await resolveChatChannel({ channelId, model });
    if (resolved.error) {
      emit({ type: 'error', message: resolved.error });
      return;
    }

    const { channel, requestModel } = resolved;
    const enabledTools = await getEnabledToolDefinitions();
    const channelConfig = {
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: requestModel,
      maxTokens: channel.maxTokens,
      maxTurns: channel.maxTurns || 5,
      extraHeaders: channel.extraHeaders,
      tools: enabledTools,
    };

    const { history, existingTitle, originalMessageCount } = await loadConversationState(conversationId);
    history.push({ role: 'user', content: message });
    const turnStartIndex = history.length - 1;

    rootContext = await createRootRunContext({
      runId: rootRunId,
      conversationId,
      channelId: channel.id,
      model: requestModel,
      task: message,
      label: titleFromMessage(message),
      emit,
    });
    rootContext.recordRootStart();

    const iterator = queryLoop({
      config: channelConfig,
      history,
      maxTurns: channelConfig.maxTurns,
      signal,
      streamChat: CHAT_SERVICE_TEST_HOOKS.streamChat || undefined,
      runTool: CHAT_SERVICE_TEST_HOOKS.runTool || undefined,
      toolContext: {
        source: 'runtime',
        environment: process.env.NODE_ENV || 'development',
        conversationId,
        channelId: channel.id,
        model: requestModel,
        agentRunId: rootContext.rootRun.runId,
        rootRunId: rootContext.rootRun.runId,
        agentDepth: 0,
        emitAgentEvent: rootContext.emitAgentEvent,
        runSubagent,
        subagentConfig: channelConfig,
      },
      onDelta: (delta) => emit({ type: 'delta', text: delta }),
      onThinkingDelta: (thinkingText) => emit({ type: 'thinking', text: thinkingText }),
      onServerToolEvent: makeServerToolEventHandler({
        emit,
        conversationId,
        channelId: channel.id,
        model: requestModel,
        rootRunId: rootContext.rootRun.runId,
        audit: rootContext.audit,
      }),
    });

    let iterResult = await iterator.next();
    while (!iterResult.done) {
      const evt = iterResult.value;
      if (evt.type === 'tool_call') {
        rootContext.recordToolCall(evt);
      } else if (evt.type === 'tool_result') {
        rootContext.recordToolResult(evt);
      }
      iterResult = await iterator.next();
    }

    const finalState = iterResult.value;
    const { agentRuns, trace } = await rootContext.completeAndBuildTrace(finalState, { turnStartIndex });

    const storeMessages = buildStoredMessages({ history, originalMessageCount, finalState, model: requestModel, agentRuns, trace });
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

    emit({ type: 'done', stopReason: finalState.stopReason, usage: finalState.usage });
  } catch (err) {
    if (rootContext) {
      await rootContext.recordError(err, { aborted: signal?.aborted });
    }
    emit({ type: 'error', message: err.message || String(err) });
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

  const run = startChatRun(payload, {
    execute: runChatRequest,
    enqueueConversation: storage.withConversationQueue,
  });
  startSse(res);
  subscribeResponseToRun(run, res);
}

export function handleChatRunStream(req, res) {
  let runId;
  try {
    runId = validateSafeId(req.params.id, 'runId');
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const run = getChatRun(runId);
  if (!run) return res.status(404).json({ error: 'Chat run not found' });

  const afterSeq = Math.max(0, Number.parseInt(req.query.afterSeq, 10) || 0);
  startSse(res);
  subscribeResponseToRun(run, res, { afterSeq });
}

export function handleChatRunStatus(req, res) {
  let runId;
  try {
    runId = validateSafeId(req.params.id, 'runId');
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const snapshot = getChatRunSnapshot(runId);
  if (!snapshot) return res.status(404).json({ error: 'Chat run not found' });
  return res.json(snapshot);
}
