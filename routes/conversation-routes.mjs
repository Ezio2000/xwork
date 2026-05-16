import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import * as storage from '../lib/storage.mjs';

export function conversationRoutes() {
  const router = Router();

  router.get('/conversations', async (_req, res) => {
    res.json(await storage.listConversations());
  });

  router.post('/conversations', async (req, res) => {
    const id = randomUUID();
    const convo = await storage.createConversation(id, req.body?.title || 'New Chat');
    res.json(convo);
  });

  router.get('/conversations/:id', async (req, res) => {
    const convo = await storage.getConversation(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Not found' });
    return res.json(convo);
  });

  router.delete('/conversations/:id', async (req, res) => {
    await storage.deleteConversation(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
