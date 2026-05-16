import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import * as storage from '../lib/storage.mjs';
import { SchemaValidationError, validateConversationTitle, validateSafeId } from '../lib/schema.mjs';

function sendError(res, err) {
  if (err instanceof SchemaValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  throw err;
}

export function conversationRoutes() {
  const router = Router();

  router.get('/conversations', async (_req, res) => {
    res.json(await storage.listConversations());
  });

  router.post('/conversations', async (req, res) => {
    try {
      const id = randomUUID();
      const convo = await storage.createConversation(id, validateConversationTitle(req.body?.title));
      res.json(convo);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/conversations/:id', async (req, res) => {
    try {
      const convo = await storage.getConversation(validateSafeId(req.params.id, 'conversationId'));
      if (!convo) return res.status(404).json({ error: 'Not found' });
      return res.json(convo);
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.delete('/conversations/:id', async (req, res) => {
    try {
      await storage.deleteConversation(validateSafeId(req.params.id, 'conversationId'));
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
