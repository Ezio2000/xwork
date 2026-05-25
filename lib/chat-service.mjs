import { getChatRun, getChatRunSnapshot, startChatRun, stopChatRun, subscribeResponseToRun } from './chat-runs.mjs';
import { CHAT_SERVICE_TEST_HOOKS, runChatRequest } from './chat/request-runner.mjs';
import { startSse } from './sse-writer.mjs';
import * as storage from './storage.mjs';
import { SchemaValidationError, validateAskUserResponse, validateChatRequest, validateSafeId } from './schema.mjs';
import { globalUserInputRegistry } from './user-input-registry.mjs';

export { getChatRunSnapshot };
export { CHAT_SERVICE_TEST_HOOKS };

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

  const run = startChatRun(payload, {
    execute: runChatRequest,
    enqueueConversation: storage.withConversationQueue,
  });
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

  const run = getChatRun(runId);
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

export function handleChatRunUserInput(req, res) {
  let runId;
  let body;
  try {
    runId = validateSafeId(req.params.id, 'runId');
    body = validateAskUserResponse(req.body || {});
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const run = getChatRun(runId);
  if (!run) return res.status(404).json({ error: 'Chat run not found' });
  if (run.status !== 'running' && run.status !== 'waiting_user') {
    return res.status(409).json({ error: 'Run is not waiting for user input' });
  }

  const result = globalUserInputRegistry.submitAnswer({
    runId,
    toolCallId: body.toolCallId,
    response: body.response,
  });
  if (!result.ok) return res.status(404).json({ error: result.error });
  return res.json({ ok: true });
}

export function handleChatRunStop(req, res) {
  let runId;
  try {
    runId = validateSafeId(req.params.id, 'runId');
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const result = stopChatRun(runId);
  if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
  return res.json({ ok: true, stopped: result.stopped, run: result.run });
}
