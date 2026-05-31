import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { toolStaticRoutes } from '../routes/tool-static-routes.mjs';

async function withToolStaticServer(fn) {
  const app = express();
  app.use(toolStaticRoutes());
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('tool static routes', () => {
  it('serves tool UI modules from package folders', async () => {
    await withToolStaticServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/js/tools/ask-user/ui.mjs`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      assert.match(await response.text(), /export function renderBlock/);
    });
  });

  it('rejects encoded path traversal in tool slugs', async () => {
    await withToolStaticServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/js/tools/.%2F..%2Ftools%2Fask-user/ui.mjs`);
      assert.equal(response.status, 400);
    });
  });
});
