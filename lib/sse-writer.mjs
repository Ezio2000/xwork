import { errorEvent } from './run-events.mjs';

export function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.socket?.setTimeout?.(0);
  res.socket?.setNoDelay?.(true);
  res.socket?.setKeepAlive?.(true);
}

export function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSseComment(res, comment = 'ping') {
  res.write(`: ${comment}\n\n`);
}

export function writeSseDone(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

export function writeSseError(res, err) {
  writeSse(res, errorEvent(err.message || String(err)));
  res.end();
}
