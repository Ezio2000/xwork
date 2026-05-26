import { Router } from 'express';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { clearStoredUserTokens } from '../lib/feishu-auth.mjs';
import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { listToolRuns } from '../lib/tools/runs.mjs';
import { SchemaValidationError, validateSafeId } from '../lib/schema.mjs';

const BROWSER_SCREENSHOT_DIR = resolve(process.cwd(), 'data', 'browser-screenshots');
const SCREENSHOT_FILE_RE = /^[a-zA-Z0-9_.-]+\.png$/i;

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

  router.post('/tools/feishu_auth/clear-token', async (_req, res) => {
    await clearStoredUserTokens();
    const tools = await listTools();
    return res.json({
      feishu_auth: tools.find(tool => tool.id === 'feishu_auth') || null,
      feishu_read: tools.find(tool => tool.id === 'feishu_read') || null,
    });
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
    const source = req.query.source === undefined ? undefined : String(req.query.source);
    const environment = req.query.environment === undefined ? undefined : String(req.query.environment);
    const includeTest = req.query.includeTest === '1' || req.query.includeTest === 'true';
    res.json(await listToolRuns({ limit, source, environment, includeTest }));
  });

  router.get('/tool-assets/browser-screenshots/:filename', async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!SCREENSHOT_FILE_RE.test(filename)) {
      return res.status(400).json({ error: 'Invalid screenshot filename' });
    }

    const filePath = resolve(BROWSER_SCREENSHOT_DIR, filename);
    try {
      await access(filePath);
    } catch {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    res.type('png');
    res.set('Cache-Control', 'private, max-age=300');
    return res.sendFile(filePath);
  });

  return router;
}
