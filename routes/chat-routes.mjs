import { Router } from 'express';

import { handleChatRequest } from '../lib/chat-service.mjs';

export function chatRoutes() {
  const router = Router();

  router.post('/chat', handleChatRequest);

  return router;
}
