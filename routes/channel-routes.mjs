import { Router } from 'express';

import {
  createChannel,
  createVisionProvider,
  deleteChannel,
  deleteVisionProvider,
  getActiveState,
  listChannels,
  listVisionProviders,
  setActiveState,
  setVisionState,
  updateChannel,
  updateVisionProvider,
} from '../lib/channels.mjs';
import { SchemaValidationError } from '../lib/schema.mjs';

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

export function channelRoutes() {
  const router = Router();

  router.get('/active', async (_req, res) => {
    res.json(await getActiveState());
  });

  router.post('/active', async (req, res) => {
    try {
      sendResult(res, await setActiveState(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/vision', async (req, res) => {
    try {
      sendResult(res, await setVisionState(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/vision-providers', async (_req, res) => {
    res.json(await listVisionProviders());
  });

  router.post('/vision-providers', async (req, res) => {
    try {
      sendResult(res, await createVisionProvider(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/vision-providers/:id', async (req, res) => {
    try {
      sendResult(res, await updateVisionProvider(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/vision-providers/:id', async (req, res) => {
    try {
      sendResult(res, await deleteVisionProvider(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/channels', async (_req, res) => {
    res.json(await listChannels());
  });

  router.post('/channels', async (req, res) => {
    try {
      sendResult(res, await createChannel(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/channels/:id', async (req, res) => {
    try {
      sendResult(res, await updateChannel(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/channels/:id', async (req, res) => {
    try {
      sendResult(res, await deleteChannel(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
