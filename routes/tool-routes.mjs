import { Router } from 'express';

import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { listToolRuns } from '../lib/tools/runs.mjs';
import { SchemaValidationError, validateSafeId } from '../lib/schema.mjs';

function sendError(res, err) {
  if (err instanceof SchemaValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

export function toolRoutes() {
  const router = Router();

  router.get('/tools', async (_req, res) => {
    res.json(await listTools());
  });

  router.put('/tools/:id', async (req, res) => {
    try {
      const tool = await updateToolConfig(validateSafeId(req.params.id, 'toolId'), req.body || {});
      if (!tool) return res.status(404).json({ error: 'Tool not found' });
      return res.json(tool);
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.post('/tools/:id/enable', async (req, res) => {
    try {
      const tool = await updateToolConfig(validateSafeId(req.params.id, 'toolId'), { enabled: true });
      if (!tool) return res.status(404).json({ error: 'Tool not found' });
      return res.json(tool);
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.post('/tools/:id/disable', async (req, res) => {
    try {
      const tool = await updateToolConfig(validateSafeId(req.params.id, 'toolId'), { enabled: false });
      if (!tool) return res.status(404).json({ error: 'Tool not found' });
      return res.json(tool);
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.get('/tool-runs', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json(await listToolRuns(limit));
  });

  return router;
}
