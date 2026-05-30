import { Router } from 'express';

import { dispatchBrowserInput, subscribeBrowserScreencast } from '../lib/tools/browser-cdp-session.mjs';

export function browserLiveRoutes() {
  const router = Router();

  router.get('/browser-live/stream', async (req, res) => {
    try {
      await subscribeBrowserScreencast(req, res);
    } catch (err) {
      if (!res.headersSent) {
        return res.status(500).json({ error: err.message || String(err) });
      }
      res.end();
    }
  });

  router.post('/browser-live/input', async (req, res) => {
    try {
      const result = await dispatchBrowserInput(req.body || {});
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: err.message || String(err) });
    }
  });

  return router;
}
