import { appendStreamEvent } from './stream-reducer.js';

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
        if (evt.type === 'done' || evt.type === 'error') {
          stream.terminalEvent = evt;
        }
      } catch {}
    }
  }

  stream.renderer.flush();
  return stream.blocks;
}

export async function attachChatStream(stream, resPromise, { onComplete, onError }) {
  try {
    const res = await resPromise;
    if (!res.ok) {
      const err = await res.text();
      let errMsg = `Error ${res.status}`;
      try {
        errMsg = JSON.parse(err).error || errMsg;
      } catch {}
      throw new Error(errMsg);
    }
    await readChatStream(res, stream);
    if (!stream.terminalEvent && stream.status === 'running') {
      const url = `/api/v1/chat-runs/${encodeURIComponent(stream.runId)}/stream?afterSeq=${encodeURIComponent(stream.lastSeq || 0)}`;
      attachChatStream(stream, fetch(url), { onComplete, onError });
      return;
    }
    if (stream.terminalEvent?.type === 'error') {
      onError(stream, new Error(stream.terminalEvent.message || 'Unknown error'));
    } else {
      onComplete(stream);
    }
  } catch (err) {
    onError(stream, err);
  }
}
