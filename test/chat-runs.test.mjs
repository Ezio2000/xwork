import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearChatRunsForTest,
  getChatRun,
  getChatRunSnapshot,
  publishChatRunEvent,
  startChatRun,
  subscribeResponseToRun,
} from '../lib/chat-runs.mjs';

function fakeSseResponse() {
  const writes = [];
  const closeHandlers = [];
  return {
    res: {
      destroyed: false,
      writableEnded: false,
      write(chunk) {
        writes.push(String(chunk));
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      on(event, handler) {
        if (event === 'close') closeHandlers.push(handler);
      },
    },
    writes,
    close() {
      for (const handler of closeHandlers) handler();
    },
  };
}

describe('chat run event store', () => {
  afterEach(() => {
    clearChatRunsForTest();
  });

  it('starts a run, publishes terminal events, and exposes snapshots', async () => {
    const run = startChatRun({
      runId: 'run_contract',
      conversationId: 'conv_contract',
      message: 'hi',
    }, {
      execute: async ({ emit }) => {
        emit({ type: 'delta', text: 'hello' });
        emit({ type: 'done', stopReason: 'end_turn', usage: null });
      },
    });

    await run.promise;

    const snapshot = getChatRunSnapshot('run_contract');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.conversationId, 'conv_contract');
    assert.equal(snapshot.lastSeq, 3);
    assert.equal(getChatRun('run_contract').events.at(-1).type, 'done');
  });

  it('replays only events after the requested sequence and closes completed streams', async () => {
    const run = startChatRun({ runId: 'run_replay', message: 'hi' }, {
      execute: async () => {},
    });
    publishChatRunEvent(run, { type: 'delta', text: 'a' });
    publishChatRunEvent(run, { type: 'delta', text: 'b' });
    publishChatRunEvent(run, { type: 'done' });

    const { res, writes } = fakeSseResponse();
    subscribeResponseToRun(run, res, { afterSeq: 2 });

    assert.equal(res.writableEnded, true);
    assert.ok(!writes.some(chunk => chunk.includes('chat_run_start')));
    assert.ok(!writes.some(chunk => chunk.includes('"text":"a"')));
    assert.ok(writes.some(chunk => chunk.includes('"text":"b"')));
    assert.ok(writes.some(chunk => chunk.includes('"type":"done"')));
    assert.ok(writes.some(chunk => chunk.includes('[DONE]')));
  });

  it('does not abort background execution when a subscriber closes', async () => {
    let sawAbortedSignal = null;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const run = startChatRun({ runId: 'run_close', message: 'hi' }, {
      execute: async ({ signal, emit }) => {
        await wait(10);
        sawAbortedSignal = signal.aborted;
        emit({ type: 'done' });
      },
    });

    const { res, close } = fakeSseResponse();
    subscribeResponseToRun(run, res);
    res.destroyed = true;
    close();
    await run.promise;

    assert.equal(sawAbortedSignal, false);
    assert.equal(getChatRunSnapshot('run_close').status, 'completed');
  });
});
