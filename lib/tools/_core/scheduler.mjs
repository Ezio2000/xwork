import { RUN_EVENT_TYPES } from '../../run-events.mjs';

function toolExecutionMode(tool) {
  return tool?.capabilities?.executionMode || tool?.executionMode || 'sequential';
}

function requiresUserInput(call) {
  return call?.name === 'ask_user';
}

export function defaultToolScheduler({ tools = [], parallelToolNames = [] } = {}) {
  const parallelNames = new Set(parallelToolNames || []);
  for (const tool of tools || []) {
    if (tool?.name && toolExecutionMode(tool) === 'parallel_batch') {
      parallelNames.add(tool.name);
    }
  }
  return {
    canRunBatch(call) {
      return parallelNames.has(call?.name);
    },
  };
}

export function createToolEventQueue() {
  const events = [];
  let waiters = [];
  return {
    push(event) {
      events.push(event);
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
    drain() {
      return events.splice(0);
    },
    wait() {
      if (events.length) return Promise.resolve();
      return new Promise(resolve => {
        waiters.push(resolve);
      });
    },
    clearWaiters() {
      waiters = [];
    },
  };
}

function collectBatch(calls, startIndex, scheduler) {
  const first = calls[startIndex];
  if (requiresUserInput(first)) {
    return { batch: [first], nextIndex: startIndex + 1, parallel: false };
  }
  if (!scheduler.canRunBatch(first)) {
    return { batch: [first], nextIndex: startIndex + 1, parallel: false };
  }

  const batch = [];
  let nextIndex = startIndex;
  while (nextIndex < calls.length && calls[nextIndex]?.name === first.name && scheduler.canRunBatch(calls[nextIndex])) {
    batch.push(calls[nextIndex]);
    nextIndex++;
  }
  return { batch, nextIndex, parallel: true };
}

async function* awaitOutcomesWithEvents(outcomesPromise, eventQueue) {
  if (!eventQueue) return await outcomesPromise;

  while (true) {
    const readyEvents = eventQueue.drain();
    for (const event of readyEvents) {
      yield event;
    }

    const winner = await Promise.race([
      outcomesPromise.then(outcomes => ({ type: 'outcomes', outcomes })),
      eventQueue.wait().then(() => ({ type: 'events' })),
    ]);

    if (winner.type === 'outcomes') {
      eventQueue.clearWaiters();
      for (const event of eventQueue.drain()) {
        yield event;
      }
      return winner.outcomes;
    }
  }
}

export async function* executeToolCalls({
  calls = [],
  signal,
  executeCall,
  publishOutcome,
  scheduler = defaultToolScheduler(),
  eventQueue = null,
}) {
  for (let i = 0; i < calls.length;) {
    if (signal?.aborted) return { aborted: true };

    const { batch, nextIndex, parallel } = collectBatch(calls, i, scheduler);
    for (const call of batch) {
      yield { type: RUN_EVENT_TYPES.TOOL_CALL, id: call.id, name: call.name, input: call.input || {} };
    }

    const outcomesPromise = parallel && batch.length > 1
      ? Promise.all(batch.map(executeCall))
      : (async () => {
          const outcomes = [];
          for (const call of batch) outcomes.push(await executeCall(call));
          return outcomes;
        })();
    const outcomes = yield* awaitOutcomesWithEvents(outcomesPromise, eventQueue);

    for (let j = 0; j < outcomes.length; j++) {
      yield publishOutcome(batch[j], outcomes[j]);
    }

    i = nextIndex;
  }
  return { aborted: false };
}
