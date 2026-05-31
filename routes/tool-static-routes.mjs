import { access } from 'node:fs/promises';
import { Router } from 'express';

import { toolStaticFilePath } from '../lib/tools/ui-manifest.mjs';

function sendToolStaticFile(res, slug, filename) {
  const filePath = toolStaticFilePath(slug, filename);
  if (!filePath) {
    return res.status(400).json({ error: 'Invalid tool static path' });
  }
  return access(filePath)
    .then(() => {
      if (filename.endsWith('.css')) res.type('text/css');
      else res.type('application/javascript');
      res.set('Cache-Control', 'private, max-age=60');
      return res.sendFile(filePath);
    })
    .catch(() => res.status(404).json({ error: 'Tool static file not found' }));
}

export function toolStaticRoutes() {
  const router = Router();

  router.get('/js/tools/:slug/ui.mjs', (req, res) => sendToolStaticFile(res, req.params.slug, 'ui.mjs'));
  router.get('/js/tools/:slug/client.mjs', (req, res) => sendToolStaticFile(res, req.params.slug, 'client.mjs'));
  router.get('/js/tools/:slug/stream.mjs', (req, res) => sendToolStaticFile(res, req.params.slug, 'stream.mjs'));
  router.get('/css/tools/:slug/styles.css', (req, res) => sendToolStaticFile(res, req.params.slug, 'styles.css'));
  router.get('/css/tools/_shared/shell-toggle.css', (req, res) => sendToolStaticFile(res, '_shared', 'styles.css'));

  return router;
}
