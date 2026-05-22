import { Router } from 'express';

import { searchWorkspaceFiles, invalidateWorkspaceFileIndex } from '../lib/workspace-files.mjs';
import { updateConfig } from '../lib/config-store.mjs';
import {
  getWorkspaceInfo,
  setWorkspaceRoot,
  validateWorkspaceCandidate,
} from '../lib/workspace-root.mjs';

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

  router.get('/workspace', async (_req, res) => {
    res.json(getWorkspaceInfo());
  });

  router.put('/workspace', async (req, res) => {
    const body = req.body || {};
    try {
      const { absolutePath } = validateWorkspaceCandidate(body.root);
      const labelInput = body.label;
      const label = typeof labelInput === 'string' && labelInput.trim()
        ? labelInput.trim().slice(0, 80)
        : null;
      await updateConfig((cfg) => {
        cfg.workspace = { root: absolutePath, label };
        return cfg.workspace;
      });
      setWorkspaceRoot(absolutePath, { label });
      invalidateWorkspaceFileIndex();
      res.json(getWorkspaceInfo());
    } catch (err) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
