import { assistantMessage } from './api.mjs';
import { resolveChatChannel } from './channels.mjs';
import { queryLoop } from './query-loop.mjs';
import { startSse, writeSse, writeSseDone, writeSseError } from './sse-writer.mjs';
import * as storage from './storage.mjs';
import { getEnabledToolDefinitions } from './tools/registry.mjs';
import { appendToolRun } from './tools/runs.mjs';

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

function buildStoredMessages({ history, originalMessageCount, finalState, model }) {
  const mergedResult = {
    ...(finalState.result || {}),
    text: finalState.text,
    content: finalState.content,
    serverToolEvents: finalState.serverToolEvents,
    builtinToolResults: finalState.builtinToolResults || [],
    __toolResults: finalState.messages,
  };

  const storeMessages = [...history.slice(0, originalMessageCount + 1)];
  storeMessages.push(assistantMessage(mergedResult, model));
  return storeMessages;
}

export async function handleChatRequest(req, res) {
  const { conversationId, message, channelId, model } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const resolved = await resolveChatChannel({ channelId, model });
  if (resolved.error) return res.status(400).json({ error: resolved.error });

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

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const iterator = queryLoop({
      config: channelConfig,
      history,
      maxTurns: 5,
      signal: ac.signal,
      toolContext: { conversationId, channelId: channel.id, model: requestModel },
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
    const storeMessages = buildStoredMessages({ history, originalMessageCount, finalState, model: requestModel });
    const title = originalMessageCount === 0 || existingTitle === 'New Chat'
      ? titleFromMessage(message)
      : undefined;

    if (conversationId) {
      try {
        await storage.saveConversation(conversationId, storeMessages, title);
      } catch (err) {
        console.error('[chat] failed to save conversation:', err);
      }
    }

    writeSse(res, { type: 'done', stopReason: finalState.stopReason, usage: finalState.usage });
    writeSseDone(res);
  } catch (err) {
    writeSseError(res, err);
  }
}
