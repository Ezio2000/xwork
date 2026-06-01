import { appendStreamEvent } from './stream-reducer.js';
import { STREAM_EVENT_TYPES } from './stream-events.js';

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5000;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function reconnectUrl(stream) {
  return `/api/v1/chat-runs/${encodeURIComponent(stream.runId)}/stream?afterSeq=${encodeURIComponent(stream.lastSeq || 0)}`;
}

function reconnectDelay(attempt, override) {
  if (Number.isFinite(override)) return Math.max(0, override);
  return Math.min(BASE_RECONNECT_DELAY_MS * (2 ** Math.max(0, attempt - 1)), MAX_RECONNECT_DELAY_MS);
}

function canReconnect(stream) {
  return Boolean(
    stream?.runId
    && stream.status === 'running'
    && !stream.terminalEvent
    && !stream.finalized
    && !stream.stopping
  );
}

function isNonRecoverableStreamError(err) {
  return err?.status === 404 || err?.status === 409;
}

async function reconnectChatStream(stream, callbacks, cause = null) {
  if (!canReconnect(stream) || isNonRecoverableStreamError(cause)) {
    callbacks.onError(stream, cause || new Error('Stream connection closed before completion'));
    return;
  }

  const attempt = (stream.reconnectAttempts || 0) + 1;
  stream.reconnectAttempts = attempt;
  stream.lastReconnectError = cause?.message || String(cause || 'stream closed');

  if (attempt > (callbacks.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)) {
    callbacks.onError(stream, new Error(`Stream connection lost after ${attempt - 1} reconnect attempts: ${stream.lastReconnectError}`));
    return;
  }

  await wait(reconnectDelay(attempt, callbacks.reconnectDelayMs));
  if (!canReconnect(stream)) return;
  await attachChatStream(stream, fetch(reconnectUrl(stream)), callbacks);
}

export async function readChatStream(res, stream) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6);
      if (jsonStr === '[DONE]') continue;
      try {
        const evt = JSON.parse(jsonStr);
        appendStreamEvent(evt, stream);
        if (evt.type === STREAM_EVENT_TYPES.DONE || evt.type === STREAM_EVENT_TYPES.ERROR) {
          stream.terminalEvent = evt;
        }
      } catch {}
    }
  }

  const renderDeferredCharts = stream.status !== 'running' ? true : 'closed';
  stream.renderer.flush({
    renderMermaid: renderDeferredCharts,
    renderEcharts: renderDeferredCharts,
  });
  return stream.blocks;
}

export async function attachChatStream(stream, resPromise, { onComplete, onError, maxReconnectAttempts, reconnectDelayMs }) {
  const callbacks = { onComplete, onError, maxReconnectAttempts, reconnectDelayMs };
  try {
    const res = await resPromise;
    if (!res.ok) {
      const err = await res.text();
      let errMsg = `Error ${res.status}`;
      try {
        errMsg = JSON.parse(err).error || errMsg;
      } catch {}
      const httpError = new Error(errMsg);
      httpError.status = res.status;
      throw httpError;
    }
    const seqBeforeRead = stream.lastSeq || 0;
    await readChatStream(res, stream);
    if (stream.terminalEvent || (stream.lastSeq || 0) > seqBeforeRead) {
      stream.reconnectAttempts = 0;
      stream.lastReconnectError = '';
    }
    if (!stream.terminalEvent && stream.status === 'running') {
      await reconnectChatStream(stream, callbacks);
      return;
    }
    if (stream.terminalEvent?.type === 'error') {
      onError(stream, new Error(stream.terminalEvent.message || 'Unknown error'));
    } else {
      onComplete(stream);
    }
  } catch (err) {
    if (canReconnect(stream)) {
      await reconnectChatStream(stream, callbacks, err);
      return;
    }
    onError(stream, err);
  }
}
