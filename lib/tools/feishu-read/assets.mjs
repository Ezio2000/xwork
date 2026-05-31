import { access } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const FEISHU_MEDIA_DIR = resolve(process.cwd(), 'data', 'feishu-media');
const FEISHU_MEDIA_FILE_RE = /^[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,8}$/;

export function registerRoutes(router) {
  router.get('/tool-assets/feishu-media/:filename', async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!FEISHU_MEDIA_FILE_RE.test(filename)) {
      return res.status(400).json({ error: 'Invalid Feishu media filename' });
    }

    const filePath = resolve(FEISHU_MEDIA_DIR, filename);
    const rel = relative(FEISHU_MEDIA_DIR, filePath);
    if (!rel || rel.startsWith('..') || resolve(rel) === rel) {
      return res.status(400).json({ error: 'Invalid Feishu media path' });
    }
    try {
      await access(filePath);
    } catch {
      return res.status(404).json({ error: 'Feishu media not found' });
    }

    res.set('Cache-Control', 'private, max-age=300');
    return res.sendFile(filePath);
  });
}
