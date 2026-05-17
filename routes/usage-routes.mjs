import { Router } from 'express';

import { buildUsageReport } from '../lib/usage-report.mjs';

export function usageRoutes() {
  const router = Router();

  router.get('/usage', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const includeTest = req.query.includeTest === '1' || req.query.includeTest === 'true';
    res.json(await buildUsageReport({ limit, includeTest }));
  });

  return router;
}
