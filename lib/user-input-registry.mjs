/**
 * In-memory registry for ask_user tool calls awaiting human input.
 * Keyed by root chat run id + tool_use id.
 */

function makeKey(runId, toolCallId) {
  return `${runId}:${toolCallId}`;
}

export function createUserInputRegistry({ onWaiting } = {}) {
  const pending = new Map();

  return {
    waitForAnswer({ runId, toolCallId, meta = {}, signal }) {
      if (!runId || !toolCallId) {
        return Promise.reject(new Error('runId and toolCallId are required'));
      }
      const key = makeKey(runId, toolCallId);
      if (pending.has(key)) {
        return Promise.reject(new Error(`ask_user already pending for ${toolCallId}`));
      }

      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, meta, runId, toolCallId, createdAt: Date.now() };
        pending.set(key, entry);
        onWaiting?.({ runId, toolCallId, ...meta });

        const onAbort = () => {
          if (!pending.has(key)) return;
          pending.delete(key);
          reject(new Error('Tool execution aborted'));
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },

    submitAnswer({ runId, toolCallId, response }) {
      const key = makeKey(runId, toolCallId);
      const entry = pending.get(key);
      if (!entry) {
        return { ok: false, error: 'No pending question for this tool call' };
      }
      pending.delete(key);
      entry.resolve(response);
      return { ok: true };
    },

    getPending({ runId, toolCallId }) {
      return pending.get(makeKey(runId, toolCallId)) || null;
    },

    listPendingForRun(runId) {
      const items = [];
      for (const [key, entry] of pending) {
        if (entry.runId === runId) items.push({ key, ...entry });
      }
      return items;
    },

    clearForTest() {
      pending.clear();
    },
  };
}

export const globalUserInputRegistry = createUserInputRegistry();
