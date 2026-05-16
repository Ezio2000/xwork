import { assistantMessage } from './api.mjs';
import { buildAuditTrace, createAuditRecorder } from './audit-trace.mjs';
import { resolveChatChannel } from './channels.mjs';
import { queryLoop } from './query-loop.mjs';
import { startSse, writeSse, writeSseDone, writeSseError } from './sse-writer.mjs';
import * as storage from './storage.mjs';
import { getEnabledToolDefinitions } from './tools/registry.mjs';
import { appendToolRun } from './tools/runs.mjs';
import { SchemaValidationError, validateChatRequest } from './schema.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun, getAgentRunsByIds } from './agents/runs.mjs';
import { runSubagent } from './agents/subagent-runtime.mjs';

function titleFromMessage(message) {
  return message.slice(0, 50) + (message.length > 50 ? '…' : '');
}

function makeServerToolEventHandler({ res, conversationId, channelId, model, rootRunId, audit }) {
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
        appendAgentRunEvent(rootRunId, {
          type: 'server_tool_call',
          toolCallId: event.id,
          name: event.name,
          input: event.input || {},
        }).catch(() => {});
      }
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
      appendAgentRunEvent(rootRunId, {
        type: 'server_tool_result',
        toolCallId: event.id,
        name: event.name,
        isError: event.isError,
        durationMs,
        renderType: event.renderType,
      }).catch(() => {});
    }

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
  const turnStartIndex = history.length - 1;

  startSse(res);
  const rootRun = await createAgentRun({
    role: 'root',
    conversationId,
    channelId: channel.id,
    model: requestModel,
    source: 'runtime',
    environment: process.env.NODE_ENV || 'development',
    task: message,
    label: titleFromMessage(message),
    depth: 0,
  });
  const childAgentRuns = [];
  const childAgentRunIds = new Set();
  const rootToolCalls = [];
  const rootToolResults = [];
  const childAgentEvents = new Map();
  const audit = createAuditRecorder();

  const emitAgentEvent = (event) => {
    if (event.runId) {
      const events = childAgentEvents.get(event.runId) || [];
      events.push({
        id: event.id,
        createdAt: new Date().toISOString(),
        type: event.eventType || event.event || event.type,
        ...event,
      });
      childAgentEvents.set(event.runId, events);
    }
    if (event.eventType === 'subagent_done') {
      childAgentRunIds.add(event.runId);
      childAgentRuns.push({
        runId: event.runId,
        parentRunId: event.parentRunId || rootRun.runId,
        rootRunId: rootRun.runId,
        status: event.status,
        label: event.label || 'Subagent',
        task: event.task || '',
        result: event.result || null,
        error: event.error || null,
        durationMs: event.durationMs,
        events: childAgentEvents.get(event.runId) || [],
      });
    }
    audit.record('agent_event', event);
    writeSse(res, { type: 'agent_event', ...event });
  };

  writeSse(res, {
    type: 'agent_event',
    runId: rootRun.runId,
    role: 'root',
    event: 'root_start',
  });
  audit.record('root_start', {
    runId: rootRun.runId,
    conversationId,
    channelId: channel.id,
    model: requestModel,
    task: message,
  });
  await appendAgentRunEvent(rootRun.runId, {
    type: 'root_start',
    conversationId,
    channelId: channel.id,
    model: requestModel,
    task: message,
  }).catch(() => {});

  try {
    const iterator = queryLoop({
      config: channelConfig,
      history,
      maxTurns: 5,
      signal: ac.signal,
      toolContext: {
        source: 'runtime',
        environment: process.env.NODE_ENV || 'development',
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
        rootRunId: rootRun.runId,
        audit,
      }),
    });

    let iterResult = await iterator.next();
    while (!iterResult.done) {
      const evt = iterResult.value;
      if (evt.type === 'tool_call') {
        rootToolCalls.push({
          toolCallId: evt.id,
          name: evt.name,
          input: evt.input || {},
          runId: rootRun.runId,
          createdAt: new Date().toISOString(),
        });
        audit.record('tool_call', {
          runId: rootRun.runId,
          toolCallId: evt.id,
          name: evt.name,
          input: evt.input || {},
        });
        await appendAgentRunEvent(rootRun.runId, {
          type: 'tool_call',
          toolCallId: evt.id,
          name: evt.name,
          input: evt.input || {},
        }).catch(() => {});
        writeSse(res, {
          type: 'tool_call',
          tools: [{ id: evt.id, name: evt.name, input: evt.input }],
        });
      } else if (evt.type === 'tool_result') {
        rootToolResults.push({
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
        });
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
        await appendAgentRunEvent(rootRun.runId, {
          type: 'tool_result',
          toolCallId: evt.id,
          name: evt.name,
          isError: evt.isError,
          durationMs: evt.durationMs,
          renderType: evt.renderType,
          output: evt.output,
        }).catch(() => {});
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
    const completedRootRun = await completeAgentRun(rootRun.runId, {
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
    audit.record('root_done', {
      runId: rootRun.runId,
      status: finalState.reason,
      stopReason: finalState.stopReason,
      usage: finalState.usage,
    });

    const storedChildRuns = await getAgentRunsByIds([...childAgentRunIds]);
    const agentRuns = childAgentRuns.map(run => {
      const stored = storedChildRuns.find(item => item.runId === run.runId);
      return {
        ...(stored || run),
        events: childAgentEvents.get(run.runId) || stored?.events || run.events || [],
      };
    });
    const trace = buildAuditTrace({
      conversationId,
      channelId: channel.id,
      model: requestModel,
      rootRun: completedRootRun || rootRun,
      status: finalState.reason === 'completed' ? 'completed' : finalState.reason,
      finalState,
      turnStartIndex,
      events: audit.events,
      toolCalls: rootToolCalls,
      toolResults: rootToolResults,
      agentRuns,
    });

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

    writeSse(res, { type: 'done', stopReason: finalState.stopReason, usage: finalState.usage });
    writeSseDone(res);
  } catch (err) {
    await appendAgentRunEvent(rootRun.runId, {
      type: 'root_error',
      status: ac.signal.aborted ? 'aborted' : 'error',
      error: err.message || String(err),
    }).catch(() => {});
    audit.record('root_error', {
      runId: rootRun.runId,
      status: ac.signal.aborted ? 'aborted' : 'error',
      error: err.message || String(err),
    });
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
  let responseFinished = false;
  req.on('aborted', () => ac.abort());
  res.on('close', () => {
    if (!responseFinished) ac.abort();
  });

  if (!payload.conversationId) {
    await runChatRequest({ res, payload, ac });
    responseFinished = true;
    return;
  }

  await storage.withConversationQueue(payload.conversationId, () => (
    runChatRequest({ res, payload, ac })
  ));
  responseFinished = true;
}
