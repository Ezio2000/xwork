import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { browserLiveRoutes } from '../../../routes/browser-live-routes.mjs';
import { tool } from './index.mjs';
import { __test, closeBrowserSession } from './cdp-session.mjs';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withLiveBrowserServer(fn) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/cdp-live-test', (_req, res) => {
    res.type('html').send(`<!doctype html>
      <html>
        <head><title>CDP Live Test</title></head>
        <body style="margin:0;font:24px sans-serif;background:#fef3c7;color:#111827">
          <main style="padding:40px">
            <h1>CDP Live Test</h1>
            <input id="name" autofocus>
            <p id="out">empty</p>
          </main>
          <script>
            document.getElementById('name').addEventListener('input', event => {
              document.getElementById('out').textContent = event.target.value;
            });
          </script>
        </body>
      </html>`);
  });
  app.use('/api/v1', browserLiveRoutes());
  const server = app.listen(0);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await closeBrowserSession();
    server.close();
    await once(server, 'close');
  }
}

async function collectSseEvents(url, { minFrames = 1, timeoutMs = 5000, done } = {}) {
  const controller = new AbortController();
  const events = [];
  let buffer = '';
  const shouldStop = () => (
    typeof done === 'function'
      ? done(events)
      : events.filter(event => event.type === 'frame').length >= minFrames
  );
  const read = (async () => {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (!shouldStop()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
        if (!dataLine) continue;
        events.push(JSON.parse(dataLine.slice(6)));
        if (shouldStop()) return events;
      }
    }
    return events;
  })();
  try {
    await Promise.race([
      read,
      wait(timeoutMs).then(() => {
        throw new Error('Timed out waiting for browser screencast frames');
      }),
    ]);
    return events;
  } finally {
    controller.abort();
    await read.catch(() => {});
  }
}

describe('browser CDP live session helpers', () => {
  it('normalizes viewport config', () => {
    assert.deepEqual(__test.viewportFromConfig({ viewportWidth: 100, viewportHeight: 99999 }), {
      width: 320,
      height: 2160,
    });
    assert.deepEqual(__test.viewportFromConfig({ viewportWidth: 1440, viewportHeight: 900 }), {
      width: 1440,
      height: 900,
    });
  });

  it('builds CDP modifier masks and key event types', () => {
    assert.equal(__test.modifierMask({ alt: true, ctrl: true, meta: true, shift: true }), 15);
    assert.equal(__test.modifierMask({ ctrl: true }), 2);
    assert.equal(__test.keyEventType('up', ''), 'keyUp');
    assert.equal(__test.keyEventType('down', 'a'), 'keyDown');
    assert.equal(__test.keyEventType('down', ''), 'rawKeyDown');
  });

  it('clamps pointer coordinates to the viewport', () => {
    assert.deepEqual(__test.clampPoint({ x: -10, y: 999 }, { width: 100, height: 200 }), {
      x: 0,
      y: 200,
    });
    assert.throws(() => __test.clampPoint({ x: 'bad', y: 1 }, { width: 100, height: 100 }), /finite/);
  });

  it('streams real browser frames over SSE and dispatches input through CDP', async () => {
    await withLiveBrowserServer(async (baseUrl) => {
      const streamPromise = collectSseEvents(`${baseUrl}/api/v1/browser-live/stream`, {
        done: events => events.some(event => event.type === 'frame' && event.url === `${baseUrl}/cdp-live-test`),
      });
      await wait(100);

      const opened = await tool.handler({ action: 'open', url: `${baseUrl}/cdp-live-test` }, {
        config: { ...tool.defaultConfig, allowedHosts: [] },
        emit() {},
      });
      assert.equal(opened.title, 'CDP Live Test');

      const events = await streamPromise;
      const frames = events.filter(event => event.type === 'frame');
      assert.ok(frames.length >= 1);
      assert.match(frames[0].data, /^[a-zA-Z0-9+/]+=*$/);
      assert.ok(frames[0].data.length > 1000);
      assert.ok(frames.some(frame => frame.url === `${baseUrl}/cdp-live-test`));

      await tool.handler({ action: 'click', selector: '#name' }, {
        config: { ...tool.defaultConfig, allowedHosts: [] },
        emit() {},
      });

      const inputResponse = await fetch(`${baseUrl}/api/v1/browser-live/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'insertText', text: 'Ningyun' }),
      });
      assert.equal(inputResponse.status, 200);
      assert.deepEqual(await inputResponse.json(), { ok: true });

      const typed = await tool.handler({
        action: 'evaluate',
        script: "document.querySelector('#name').value",
      }, {
        config: { ...tool.defaultConfig, allowedHosts: [] },
        emit() {},
      });
      assert.equal(typed.result, 'Ningyun');
    });
  });
});
