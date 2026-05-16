import { Router } from 'express';

import { channelRoutes } from './channel-routes.mjs';
import { chatRoutes } from './chat-routes.mjs';
import { conversationRoutes } from './conversation-routes.mjs';
import { toolRoutes } from './tool-routes.mjs';
import { agentRoutes } from './agent-routes.mjs';

export function apiRoutes() {
  const router = Router();
  router.use(channelRoutes());
  router.use(toolRoutes());
  router.use(agentRoutes());
  router.use(conversationRoutes());
  router.use(chatRoutes());
  return router;
}
