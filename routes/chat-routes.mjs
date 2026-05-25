import { Router } from 'express';

import {
  handleChatRequest,
  handleChatRunStatus,
  handleChatRunStop,
  handleChatRunStream,
  handleChatRunUserInput,
} from '../lib/chat-service.mjs';

export function chatRoutes() {
  const router = Router();

  router.post('/chat', handleChatRequest);
  router.get('/chat-runs/:id', handleChatRunStatus);
  router.get('/chat-runs/:id/stream', handleChatRunStream);
  router.post('/chat-runs/:id/stop', handleChatRunStop);
  router.post('/chat-runs/:id/user-input', handleChatRunUserInput);

  return router;
}
