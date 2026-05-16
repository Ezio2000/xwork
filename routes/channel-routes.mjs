import { Router } from 'express';

import {
  createChannel,
  deleteChannel,
  getActiveState,
  listChannels,
  setActiveState,
  updateChannel,
} from '../lib/channels.mjs';

function sendResult(res, result, fallbackStatus = 400) {
  if (result?.error) {
    return res.status(result.status || fallbackStatus).json({ error: result.error });
  }
  return res.json(result);
}

export function channelRoutes() {
  const router = Router();

  router.get('/active', async (_req, res) => {
    res.json(await getActiveState());
  });

  router.post('/active', async (req, res) => {
    sendResult(res, await setActiveState(req.body || {}));
  });

  router.get('/channels', async (_req, res) => {
    res.json(await listChannels());
  });

  router.post('/channels', async (req, res) => {
    sendResult(res, await createChannel(req.body || {}));
  });

  router.put('/channels/:id', async (req, res) => {
    sendResult(res, await updateChannel(req.params.id, req.body || {}));
  });

  router.delete('/channels/:id', async (req, res) => {
    sendResult(res, await deleteChannel(req.params.id));
  });

  return router;
}
