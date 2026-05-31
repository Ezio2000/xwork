import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getProjectRoot } from '../../workspace-root.mjs';

const BROWSER_SCREENSHOT_DIR = resolve(getProjectRoot(), 'data', 'browser-screenshots');
const SCREENSHOT_FILE_RE = /^[a-zA-Z0-9_.-]+\.png$/i;

export function registerRoutes(router) {
  router.get('/tool-assets/browser-screenshots/:filename', async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!SCREENSHOT_FILE_RE.test(filename)) {
      return res.status(400).json({ error: 'Invalid screenshot filename' });
    }

    const filePath = resolve(BROWSER_SCREENSHOT_DIR, filename);
    try {
      await access(filePath);
    } catch {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    res.type('png');
    res.set('Cache-Control', 'private, max-age=300');
    return res.sendFile(filePath);
  });
}
