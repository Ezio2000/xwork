import { Router } from 'express';

import { handleChatRequest, handleChatRunStatus, handleChatRunStream } from '../lib/chat-service.mjs';

export function chatRoutes() {
  const router = Router();

  router.post('/chat', handleChatRequest);
  router.get('/chat-runs/:id', handleChatRunStatus);
  router.get('/chat-runs/:id/stream', handleChatRunStream);

  return router;
}
