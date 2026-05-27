import { Router } from 'express';

import {
  createExpertAgent,
  deleteExpertAgent,
  getExpertAgent,
  listExpertAgents,
  resetExpertAgent,
  updateExpertAgent,
} from '../lib/agents/profiles.mjs';
import { SchemaValidationError, validateSafeId } from '../lib/schema.mjs';

function sendResult(res, result, fallbackStatus = 400) {
  if (result?.error) {
    return res.status(result.status || fallbackStatus).json({ error: result.error });
  }
  return res.json(result);
}

function sendError(res, err) {
  if (err instanceof SchemaValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

export function expertAgentRoutes() {
  const router = Router();

  router.get('/expert-agents', async (_req, res) => {
    res.json(await listExpertAgents());
  });

  router.get('/expert-agents/:id', async (req, res) => {
    try {
      const profile = await getExpertAgent(validateSafeId(req.params.id, 'expertAgentId'));
      if (!profile) return res.status(404).json({ error: 'Expert agent not found' });
      return res.json(profile);
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.post('/expert-agents', async (req, res) => {
    try {
      return sendResult(res, await createExpertAgent(req.body || {}));
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.put('/expert-agents/:id', async (req, res) => {
    try {
      return sendResult(
        res,
        await updateExpertAgent(validateSafeId(req.params.id, 'expertAgentId'), req.body || {}),
      );
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.delete('/expert-agents/:id', async (req, res) => {
    try {
      return sendResult(res, await deleteExpertAgent(validateSafeId(req.params.id, 'expertAgentId')));
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.post('/expert-agents/:id/reset', async (req, res) => {
    try {
      return sendResult(res, await resetExpertAgent(validateSafeId(req.params.id, 'expertAgentId')));
    } catch (err) {
      return sendError(res, err);
    }
  });

  return router;
}
