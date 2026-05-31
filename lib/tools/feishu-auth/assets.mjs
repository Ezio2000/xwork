import { clearStoredUserTokens } from '../_shared/feishu-oauth.mjs';
import { listTools } from '../registry.mjs';

export function registerRoutes(router) {
  router.post('/tools/feishu_auth/clear-token', async (_req, res) => {
    await clearStoredUserTokens();
    const tools = await listTools();
    return res.json({
      feishu_auth: tools.find(tool => tool.id === 'feishu_auth') || null,
      feishu_read: tools.find(tool => tool.id === 'feishu_read') || null,
    });
  });
}
