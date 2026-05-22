import { Router } from 'express';

import { searchWorkspaceFiles } from '../lib/workspace-files.mjs';

export function workspaceRoutes() {
  const router = Router();

  router.get('/workspace/files', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Number(req.query.limit);
    const result = await searchWorkspaceFiles({
      query,
      limit: Number.isFinite(limit) ? limit : 20,
    });
    res.json(result);
  });

  return router;
}
