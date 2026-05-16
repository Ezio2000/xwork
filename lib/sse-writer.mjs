export function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSseDone(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

export function writeSseError(res, err) {
  writeSse(res, { type: 'error', message: err.message || String(err) });
  res.end();
}
