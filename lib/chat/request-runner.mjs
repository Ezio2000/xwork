import { queryLoop } from '../query-loop.mjs';
import { createRootRunContext } from '../root-run-context.mjs';
import { makeServerToolEventHandler } from '../server-tool-events.mjs';
import { runSubagent } from '../agents/subagent-runtime.mjs';
import { RUN_EVENT_TYPES, chatDeltaEvent, doneEvent, errorEvent, thinkingEvent } from '../run-events.mjs';
import { buildStoredMessages, titleFromMessage } from './message-projector.mjs';
import {
  appendUserMessage,
  loadConversationState,
  saveCompletedTurn,
  titleForCompletedTurn,
} from './conversation-turn.mjs';
import { resolveRuntimeChannelConfig } from './channel-config.mjs';
import { expandFileMentionsInHistory } from './expand-file-mentions.mjs';
import { globalUserInputRegistry } from '../user-input-registry.mjs';

export const CHAT_SERVICE_TEST_HOOKS = {
  streamChat: null,
  runTool: null,
};

function buildToolContext({ conversationId, channelId, model, rootContext, channelConfig, runId }) {
  return {
    source: 'runtime',
    environment: process.env.NODE_ENV || 'development',
    conversationId,
    channelId,
    model,
    runId,
    agentRunId: rootContext.rootRun.runId,
    rootRunId: rootContext.rootRun.runId,
    agentDepth: 0,
    emitAgentEvent: rootContext.emitAgentEvent,
    runSubagent,
    subagentConfig: channelConfig,
    userInputRegistry: globalUserInputRegistry,
  };
}

export async function runChatRequest({ payload, signal, emit, rootRunId }) {
  const { conversationId, message, channelId, model } = payload;
  let rootContext = null;

  try {
    const resolved = await resolveRuntimeChannelConfig({ channelId, model });
    if (resolved.error) {
      emit(errorEvent(resolved.error));
      return;
    }

    const { channel, requestModel, channelConfig } = resolved;
    const { history, existingTitle, originalMessageCount } = await loadConversationState(conversationId);
    const turnStartIndex = appendUserMessage(history, message);
    const historyForApi = await expandFileMentionsInHistory(history);

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
      history: historyForApi,
      maxTurns: channelConfig.maxTurns,
      signal,
      streamChat: CHAT_SERVICE_TEST_HOOKS.streamChat || undefined,
      runTool: CHAT_SERVICE_TEST_HOOKS.runTool || undefined,
      toolContext: buildToolContext({
        conversationId,
        channelId: channel.id,
        model: requestModel,
        rootContext,
        channelConfig,
        runId: rootContext.rootRun.runId,
      }),
      onDelta: (delta) => emit(chatDeltaEvent(delta)),
      onThinkingDelta: (thinkingText) => emit(thinkingEvent(thinkingText)),
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
      if (evt.type === RUN_EVENT_TYPES.TOOL_CALL) {
        rootContext.recordToolCall(evt);
      } else if (evt.type === RUN_EVENT_TYPES.TOOL_DELTA || evt.type === RUN_EVENT_TYPES.ASK_USER_PENDING) {
        emit(evt);
      } else if (evt.type === RUN_EVENT_TYPES.TOOL_RESULT) {
        rootContext.recordToolResult(evt);
      }
      iterResult = await iterator.next();
    }

    const finalState = iterResult.value;
    if (finalState.reason === 'api_error') {
      throw new Error(finalState.error || 'API request failed');
    }

    const { agentRuns, trace } = await rootContext.completeAndBuildTrace(finalState, { turnStartIndex });
    const storeMessages = buildStoredMessages({
      history,
      originalMessageCount,
      finalState,
      model: requestModel,
      agentRuns,
      trace,
    });
    const title = titleForCompletedTurn({ originalMessageCount, existingTitle, message });

    try {
      await saveCompletedTurn({ conversationId, messages: storeMessages, title });
    } catch (err) {
      console.error('[chat] failed to save conversation:', err);
    }

    emit(doneEvent({ stopReason: finalState.stopReason, usage: finalState.usage }));
  } catch (err) {
    if (rootContext) {
      await rootContext.recordError(err, { aborted: signal?.aborted });
    }
    emit(errorEvent(err.message || String(err)));
  }
}
