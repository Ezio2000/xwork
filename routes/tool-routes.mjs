import { Router } from 'express';

import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { listToolRuns } from '../lib/tools/runs.mjs';

export function toolRoutes() {
  const router = Router();

  router.get('/tools', async (_req, res) => {
    res.json(await listTools());
  });

  router.put('/tools/:id', async (req, res) => {
    const tool = await updateToolConfig(req.params.id, req.body || {});
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    return res.json(tool);
  });

  router.post('/tools/:id/enable', async (req, res) => {
    const tool = await updateToolConfig(req.params.id, { enabled: true });
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    return res.json(tool);
  });

  router.post('/tools/:id/disable', async (req, res) => {
    const tool = await updateToolConfig(req.params.id, { enabled: false });
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    return res.json(tool);
  });

  router.get('/tool-runs', async (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json(await listToolRuns(limit));
  });

  return router;
}
