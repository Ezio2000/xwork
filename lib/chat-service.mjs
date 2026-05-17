import { randomUUID } from 'node:crypto';

import { assistantMessage } from './api.mjs';
import { buildAuditTrace, createAuditRecorder } from './audit-trace.mjs';
import { resolveChatChannel } from './channels.mjs';
import { queryLoop } from './query-loop.mjs';
import { startSse, writeSse, writeSseDone } from './sse-writer.mjs';
import * as storage from './storage.mjs';
import { getEnabledToolDefinitions } from './tools/registry.mjs';
import { appendToolRun } from './tools/runs.mjs';
import { SchemaValidationError, validateChatRequest, validateSafeId } from './schema.mjs';
import { createAgentRun, appendAgentRunEvent, completeAgentRun, getAgentRunsByIds } from './agents/runs.mjs';
import { runSubagent } from './agents/subagent-runtime.mjs';

export const CHAT_SERVICE_TEST_HOOKS = {
  streamChat: null,
  runTool: null,
};

const MAX_CHAT_RUNS = 100;
const MAX_CHAT_RUN_EVENTS = 2000;
const chatRuns = new Map();

function titleFromMessage(message) {
  return message.slice(0, 50) + (message.length > 50 ? '…' : '');
}

function isTransientSubagentEvent(event) {
  const eventType = event.eventType || event.event || event.type;
  return eventType === 'subagent_delta' || eventType === 'subagent_thinking';
}

function isTerminalSseEvent(event) {
  return event?.type === 'done' || event?.type === 'error';
}

function safeWriteSse(res, event) {
  if (!res || res.destroyed || res.writableEnded) return false;
  try {
    writeSse(res, event);
    return true;
  } catch {
    return false;
  }
}

function safeWriteDone(res) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    writeSseDone(res);
  } catch {}
}

function pruneChatRuns() {
  const runs = [...chatRuns.values()];
  if (runs.length <= MAX_CHAT_RUNS) return;
  const removable = runs
    .filter(run => run.status !== 'running')
    .sort((a, b) => new Date(a.completedAt || a.startedAt) - new Date(b.completedAt || b.startedAt));
  while (chatRuns.size > MAX_CHAT_RUNS && removable.length) {
    chatRuns.delete(removable.shift().runId);
  }
}

function serializeChatRun(run) {
  return {
    runId: run.runId,
    conversationId: run.conversationId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    lastSeq: run.nextSeq - 1,
  };
}

function publishChatRunEvent(run, event) {
  const now = new Date().toISOString();
  const payload = {
    chatRunId: run.runId,
    conversationId: run.conversationId || null,
    seq: run.nextSeq++,
    createdAt: now,
    ...event,
  };

  run.events.push(payload);
  if (run.events.length > MAX_CHAT_RUN_EVENTS) {
    run.events = run.events.slice(-MAX_CHAT_RUN_EVENTS);
  }

  if (isTerminalSseEvent(payload)) {
    run.status = payload.type === 'done' ? 'completed' : 'error';
    run.completedAt = now;
    run.error = payload.type === 'error' ? payload.message || 'Unknown error' : null;
  }

  for (const res of [...run.subscribers]) {
    if (!safeWriteSse(res, payload)) {
      run.subscribers.delete(res);
    }
  }

  if (isTerminalSseEvent(payload)) {
    for (const res of [...run.subscribers]) {
      safeWriteDone(res);
      run.subscribers.delete(res);
    }
    pruneChatRuns();
  }

  return payload;
}

function subscribeResponseToRun(run, res, { afterSeq = 0 } = {}) {
  for (const event of run.events) {
    if (event.seq > afterSeq && !safeWriteSse(res, event)) return;
  }

  if (run.status !== 'running') {
    safeWriteDone(res);
    return;
  }

  run.subscribers.add(res);
  res.on('close', () => {
    run.subscribers.delete(res);
  });
}

function makeServerToolEventHandler({ emit, conversationId, channelId, model, rootRunId, audit }) {
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
      emit({
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

    emit({
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

async function runChatRequest({ payload, signal, emit, rootRunId }) {
  const { conversationId, message, channelId, model } = payload;
  let rootRun = null;

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
      extraHeaders: channel.extraHeaders,
      tools: enabledTools,
    };

    const { history, existingTitle, originalMessageCount } = await loadConversationState(conversationId);
    history.push({ role: 'user', content: message });
    const turnStartIndex = history.length - 1;

    rootRun = await createAgentRun({
      runId: rootRunId,
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
      const transient = isTransientSubagentEvent(event);
      if (event.runId && !transient) {
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
      if (!transient) audit.record('agent_event', event);
      emit({ type: 'agent_event', ...event });
    };

    emit({
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
    appendAgentRunEvent(rootRun.runId, {
      type: 'root_start',
      conversationId,
      channelId: channel.id,
      model: requestModel,
      task: message,
    }).catch(() => {});

    const iterator = queryLoop({
      config: channelConfig,
      history,
      maxTurns: 5,
      signal,
      streamChat: CHAT_SERVICE_TEST_HOOKS.streamChat || undefined,
      runTool: CHAT_SERVICE_TEST_HOOKS.runTool || undefined,
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
      onDelta: (delta) => emit({ type: 'delta', text: delta }),
      onThinkingDelta: (thinkingText) => emit({ type: 'thinking', text: thinkingText }),
      onServerToolEvent: makeServerToolEventHandler({
        emit,
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
        appendAgentRunEvent(rootRun.runId, {
          type: 'tool_call',
          toolCallId: evt.id,
          name: evt.name,
          input: evt.input || {},
        }).catch(() => {});
        emit({
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
        appendAgentRunEvent(rootRun.runId, {
          type: 'tool_result',
          toolCallId: evt.id,
          name: evt.name,
          isError: evt.isError,
          durationMs: evt.durationMs,
          renderType: evt.renderType,
          output: evt.output,
        }).catch(() => {});
        emit({
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
    appendAgentRunEvent(rootRun.runId, {
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

    emit({ type: 'done', stopReason: finalState.stopReason, usage: finalState.usage });
  } catch (err) {
    if (rootRun) {
      appendAgentRunEvent(rootRun.runId, {
        type: 'root_error',
        status: signal?.aborted ? 'aborted' : 'error',
        error: err.message || String(err),
      }).catch(() => {});
      await completeAgentRun(rootRun.runId, {
        status: signal?.aborted ? 'aborted' : 'error',
        error: err.message || String(err),
      }).catch(() => {});
    }
    emit({ type: 'error', message: err.message || String(err) });
  }
}

function startChatRun(payload) {
  const runId = payload.runId || randomUUID();
  const existing = chatRuns.get(runId);
  if (existing?.status === 'running') return existing;
  const startedAt = new Date().toISOString();
  const run = {
    runId,
    conversationId: payload.conversationId || null,
    payload,
    status: 'running',
    startedAt,
    completedAt: null,
    error: null,
    nextSeq: 1,
    events: [],
    subscribers: new Set(),
    controller: new AbortController(),
    promise: null,
  };

  chatRuns.set(runId, run);
  publishChatRunEvent(run, {
    type: 'chat_run_start',
    rootRunId: runId,
    status: 'running',
  });

  run.promise = (async () => {
    const execute = () => runChatRequest({
      payload,
      signal: run.controller.signal,
      rootRunId: run.runId,
      emit: (event) => publishChatRunEvent(run, event),
    });

    if (payload.conversationId) {
      await storage.withConversationQueue(payload.conversationId, execute);
    } else {
      await execute();
    }
  })().catch((err) => {
    if (run.status === 'running') {
      publishChatRunEvent(run, { type: 'error', message: err.message || String(err) });
    }
  });

  pruneChatRuns();
  return run;
}

export function getChatRunSnapshot(runId) {
  const run = chatRuns.get(runId);
  return run ? serializeChatRun(run) : null;
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

  const run = startChatRun(payload);
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

  const run = chatRuns.get(runId);
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
