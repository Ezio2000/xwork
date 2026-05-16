export function parseSseChunk(rawBuffer) {
  const events = [];
  const parts = rawBuffer.split('\n\n');
  const rest = parts.pop() || '';

  for (const part of parts) {
    let eventName = '';
    const dataLines = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const data = dataLines.join('\n');
    if (data === '[DONE]') continue;
    try {
      events.push({ eventName, data: JSON.parse(data) });
    } catch {
      // Ignore malformed provider chunks.
    }
  }

  return { events, rest };
}
