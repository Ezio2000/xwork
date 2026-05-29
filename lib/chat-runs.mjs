import { randomUUID } from 'node:crypto';

import { writeSse, writeSseDone } from './sse-writer.mjs';
import { RUN_EVENT_TYPES } from './run-events.mjs';

const DEFAULT_MAX_CHAT_RUNS = 100;
const DEFAULT_MAX_CHAT_RUN_EVENTS = 2000;

const chatRuns = new Map();
const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_user']);

function isTerminalSseEvent(event) {
  return event?.type === RUN_EVENT_TYPES.DONE || event?.type === RUN_EVENT_TYPES.ERROR;
}

function isActiveRun(run) {
  return Boolean(run && ACTIVE_RUN_STATUSES.has(run.status));
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

function pruneChatRuns({ maxRuns = DEFAULT_MAX_CHAT_RUNS } = {}) {
  const runs = [...chatRuns.values()];
  if (runs.length <= maxRuns) return;
  const removable = runs
    .filter(run => run.status !== 'running')
    .sort((a, b) => new Date(a.completedAt || a.startedAt) - new Date(b.completedAt || b.startedAt));
  while (chatRuns.size > maxRuns && removable.length) {
    chatRuns.delete(removable.shift().runId);
  }
}

export function serializeChatRun(run) {
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

export function publishChatRunEvent(run, event, options = {}) {
  if (!isActiveRun(run) && isTerminalSseEvent(event)) return null;

  const now = new Date().toISOString();
  const payload = {
    chatRunId: run.runId,
    conversationId: run.conversationId || null,
    seq: run.nextSeq++,
    createdAt: now,
    ...event,
  };

  run.events.push(payload);
  const maxEvents = options.maxEvents || DEFAULT_MAX_CHAT_RUN_EVENTS;
  if (run.events.length > maxEvents) {
    run.events = run.events.slice(-maxEvents);
  }

  if (payload.type === RUN_EVENT_TYPES.ASK_USER_PENDING) {
    run.status = 'waiting_user';
  } else if (run.status === 'waiting_user' && (payload.type === RUN_EVENT_TYPES.TOOL_RESULT || payload.type === RUN_EVENT_TYPES.TOOL_DELTA)) {
    run.status = 'running';
  }

  if (isTerminalSseEvent(payload)) {
    run.status = payload.type === RUN_EVENT_TYPES.DONE ? 'completed' : 'error';
    run.completedAt = now;
    run.error = payload.type === RUN_EVENT_TYPES.ERROR ? payload.message || 'Unknown error' : null;
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
    pruneChatRuns(options);
  }

  return payload;
}

export function subscribeResponseToRun(run, res, { afterSeq = 0 } = {}) {
  for (const event of run.events) {
    if (event.seq > afterSeq && !safeWriteSse(res, event)) return;
  }

  if (!isActiveRun(run)) {
    safeWriteDone(res);
    return;
  }

  run.subscribers.add(res);
  res.on('close', () => {
    run.subscribers.delete(res);
  });
}

export function startChatRun(payload, { execute, enqueueConversation, maxRuns } = {}) {
  if (typeof execute !== 'function') {
    throw new TypeError('startChatRun requires an execute function');
  }

  const runId = payload.runId || randomUUID();
  const existing = chatRuns.get(runId);
  if (isActiveRun(existing)) return existing;

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
    type: RUN_EVENT_TYPES.CHAT_RUN_START,
    rootRunId: runId,
    status: 'running',
  }, { maxRuns });

  run.promise = (async () => {
    const runExecution = () => execute({
      payload,
      signal: run.controller.signal,
      rootRunId: run.runId,
      emit: (event) => {
        if (!isActiveRun(run)) return null;
        return publishChatRunEvent(run, event, { maxRuns });
      },
    });

    if (payload.conversationId && typeof enqueueConversation === 'function') {
      await enqueueConversation(payload.conversationId, runExecution);
    } else {
      await runExecution();
    }
  })().catch((err) => {
    if (isActiveRun(run)) {
      publishChatRunEvent(run, { type: RUN_EVENT_TYPES.ERROR, message: err.message || String(err) }, { maxRuns });
    }
  });

  pruneChatRuns({ maxRuns });
  return run;
}

export function getChatRun(runId) {
  return chatRuns.get(runId) || null;
}

export function getChatRunSnapshot(runId) {
  const run = getChatRun(runId);
  return run ? serializeChatRun(run) : null;
}

export function stopChatRun(runId, { reason = 'user_stopped', maxRuns } = {}) {
  const run = getChatRun(runId);
  if (!run) return { ok: false, status: 404, error: 'Chat run not found' };
  if (!isActiveRun(run)) {
    return { ok: true, stopped: false, run: serializeChatRun(run) };
  }

  run.controller.abort();
  publishChatRunEvent(run, { type: RUN_EVENT_TYPES.DONE, stopReason: reason, usage: null }, { maxRuns });
  return { ok: true, stopped: true, run: serializeChatRun(run) };
}

export function clearChatRunsForTest() {
  chatRuns.clear();
}
