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
          blocks.push({ ...block, collapsed: true });
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
    const text = run.result?.text || '';
    const events = renderableAgentEvents(run.events || []);
    const timeline = agentRunTimeline(run.events || []);
    // childAgentEvents filters out subagent_delta, so timeline may lack text
    if (text && !timeline.some(item => item.kind === 'text')) {
      timeline.unshift({ kind: 'text', text });
    }
    const next = {
      type: 'subagent-run',
      runId: run.runId,
      parentRunId: run.parentRunId || null,
      rootRunId: run.rootRunId || null,
      status: run.status,
      label: run.label || run.expertAgent?.title || run.result?.expertAgent?.title || run.task || 'Expert Agent',
      task: run.task || '',
      expertAgent: run.expertAgent || run.result?.expertAgent || null,
      text,
      error: run.error || '',
      durationMs: run.durationMs,
      usage: run.result?.usage || run.usage || null,
      events,
      timeline,
    };
    const existing = out.find(block => block.type === 'subagent-run' && block.runId === run.runId);
    if (existing) {
      Object.assign(existing, Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== null && value !== '')));
      continue;
    }
    out.push(next);
  }
  return out.length ? out : undefined;
}

function renderableAgentEvents(events = []) {
  return events.filter(event => event?.type !== AGENT_EVENT_TYPES.SUBAGENT_DELTA && event?.type !== AGENT_EVENT_TYPES.SUBAGENT_THINKING);
}

function agentRunTimeline(events = []) {
  const out = [];
  for (const event of events) {
    if (event?.type === AGENT_EVENT_TYPES.SUBAGENT_THINKING || event?.type === AGENT_EVENT_TYPES.SUBAGENT_START) continue;
    if (event?.type === AGENT_EVENT_TYPES.SUBAGENT_DELTA) {
      const text = event.text || '';
      if (!text) continue;
      const last = out[out.length - 1];
      if (last?.kind === 'text') {
        last.text += text;
      } else {
        out.push({ kind: 'text', text });
      }
      continue;
    }
    out.push({ kind: 'event', event });
  }
  return out;
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
import { AGENT_EVENT_TYPES } from './run-events.mjs';
