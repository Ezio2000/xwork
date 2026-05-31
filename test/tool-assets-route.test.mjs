import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';

import { toolRoutes } from '../routes/tool-routes.mjs';
import { getProjectRoot } from '../lib/workspace-root.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6W1JwAAAABJRU5ErkJggg==',
  'base64',
);

async function withToolAssetServer(fn) {
  const app = express();
  app.use('/api/v1', await toolRoutes());
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('tool asset routes', () => {
  it('serves browser screenshots from the xwork project data directory', async () => {
    const filename = 'route-test-screenshot.png';
    const screenshotDir = join(getProjectRoot(), 'data', 'browser-screenshots');
    const screenshotPath = join(screenshotDir, filename);
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(screenshotPath, PNG_1X1);

    try {
      await withToolAssetServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/tool-assets/browser-screenshots/${filename}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_1X1);
      });
    } finally {
      await rm(screenshotPath, { force: true });
    }
  });
});
