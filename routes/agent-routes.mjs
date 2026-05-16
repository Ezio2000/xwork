import { Router } from 'express';

import { getAgentRun, listAgentRuns } from '../lib/agents/runs.mjs';
import { SchemaValidationError, validateOptionalSafeId, validateSafeId } from '../lib/schema.mjs';

function sendError(res, err) {
  if (err instanceof SchemaValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

export function agentRoutes() {
  const router = Router();

  router.get('/agent-runs', async (req, res) => {
    try {
      const conversationId = validateOptionalSafeId(req.query.conversationId, 'conversationId');
      const parentRunId = req.query.parentRunId === undefined
        ? undefined
        : validateOptionalSafeId(req.query.parentRunId, 'parentRunId') ?? null;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      res.json(await listAgentRuns({ limit, conversationId, parentRunId }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/agent-runs/:id', async (req, res) => {
    try {
      const run = await getAgentRun(validateSafeId(req.params.id, 'runId'));
      if (!run) return res.status(404).json({ error: 'Agent run not found' });
      return res.json(run);
    } catch (err) {
      return sendError(res, err);
    }
  });

  return router;
}
