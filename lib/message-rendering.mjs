function renderByCallId(result) {
  const renderMap = {};

  for (const event of (result.serverToolEvents || [])) {
    if (event.phase === 'result' && event.renderType && event.data) {
      renderMap[event.id] = { type: event.renderType, ...event.data };
    }
  }

  for (const item of (result.builtinToolResults || [])) {
    if (item.renderType && item.data) {
      renderMap[item.callId] = { type: item.renderType, ...item.data };
    }
  }

  return renderMap;
}

export function buildRenderBlocks(result) {
  const msgs = result.__toolResults || [];
  const blocks = [];
  const renderMap = renderByCallId(result);
  let textBuf = '';

  function flushText() {
    const content = textBuf.trim();
    if (content) blocks.push({ type: 'text', content });
    textBuf = '';
  }

  for (const msg of msgs) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'text') {
        textBuf += (textBuf ? '\n' : '') + (part.text || '');
        continue;
      }
      if (part.type === 'tool_use' || part.type === 'server_tool_use') {
        flushText();
        const block = renderMap[part.id || part.tool_use_id];
        if (block) {
          blocks.push(block);
          blocks.push({ type: 'text', content: '' });
        }
      }
    }
  }

  flushText();
  while (blocks.length && blocks[blocks.length - 1].type === 'text' && !blocks[blocks.length - 1].content) {
    blocks.pop();
  }

  return blocks.length ? blocks : undefined;
}

export function appendAgentRunBlocks(blocks, agentRuns = []) {
  if (!Array.isArray(agentRuns) || !agentRuns.length) return blocks;
  const out = blocks ? [...blocks] : [];
  for (const run of agentRuns) {
    if (!run?.runId) continue;
    if (out.some(block => block.type === 'subagent-run' && block.runId === run.runId)) continue;
    out.push({
      type: 'subagent-run',
      runId: run.runId,
      parentRunId: run.parentRunId || null,
      status: run.status,
      label: run.label || run.task || 'Subagent',
      task: run.task || '',
      text: run.result?.text || '',
      error: run.error || '',
      durationMs: run.durationMs,
    });
  }
  return out.length ? out : undefined;
}

export function uniqueSources(sources = []) {
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source) continue;
    const key = source.url || `${source.title}|${source.pageAge}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

export function searchCountFromEvents(events = []) {
  return events.reduce((sum, event) => {
    if (event.phase === 'result' && event.data?.searchCount) return sum + event.data.searchCount;
    return sum;
  }, 0);
}
