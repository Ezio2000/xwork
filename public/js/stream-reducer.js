import { state } from './state.js';
import { subagentEventToBlocks } from './message-blocks.js';
import { hideThinkingPopup, showThinkingPopup } from './thinking-popup.js';

function currentTextBlock(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text') return blocks[i];
  }
  const block = { type: 'text', content: '' };
  blocks.push(block);
  return block;
}

function pushSubagentEvent(block, evt) {
  const eventType = evt.eventType || evt.type || evt.event || '';
  if (eventType === 'subagent_delta' || eventType === 'subagent_thinking') return;
  block.events = Array.isArray(block.events) ? block.events : [];
  block.events.push({ ...evt });
  if (block.events.length > 80) block.events = block.events.slice(-80);
  block.timeline = Array.isArray(block.timeline) ? block.timeline : [];
  block.timeline.push({ kind: 'event', event: { ...evt } });
  if (block.timeline.length > 160) block.timeline = block.timeline.slice(-160);
  block.blocks = Array.isArray(block.blocks) ? block.blocks : [];
  block.blocks.push(...subagentEventToBlocks(evt));
}

function appendSubagentText(block, text) {
  if (!text) return;
  block.thinking = false;
  block.text = (block.text || '') + text;
  block.timeline = Array.isArray(block.timeline) ? block.timeline : [];
  const last = block.timeline[block.timeline.length - 1];
  if (last?.kind === 'text') {
    last.text += text;
  } else {
    block.timeline.push({ kind: 'text', text });
  }
  if (block.timeline.length > 160) block.timeline = block.timeline.slice(-160);
  block.blocks = Array.isArray(block.blocks) ? block.blocks : [];
  const lastBlock = block.blocks[block.blocks.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.content += text;
  } else {
    block.blocks.push({ type: 'text', content: text });
  }
}

function isTerminalSubagentBlock(block) {
  const status = String(block?.status || '').toLowerCase();
  return block?.type === 'subagent-run' && status && status !== 'running' && status !== 'tool_error';
}

function applyToolResult(evt, stream) {
  for (const tool of evt.tools) {
    if (tool.renderType && tool.data) {
      if (tool.renderType === 'subagent-run' && tool.data.runId) {
        const existing = stream.blocks.find(block => block.type === 'subagent-run' && block.runId === tool.data.runId);
        if (existing) {
          Object.assign(existing, { ...tool.data, type: 'subagent-run' });
          if (existing.collapsed === undefined && isTerminalSubagentBlock(existing)) existing.collapsed = true;
          continue;
        }
      }
      const block = { type: tool.renderType, ...tool.data };
      if (isTerminalSubagentBlock(block)) block.collapsed = true;
      if (block.type === 'source-cards' || block.type === 'sources' || block.type === 'web-fetch') block.collapsed = true;
      stream.blocks.push(block);
    }
  }
  const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
  if (errored) currentTextBlock(stream.blocks).content += `\n\n_Tool error: ${errored}_`;
  stream.blocks.push({ type: 'text', content: '' });
  stream.renderer.schedule();
}

function applyAgentEvent(evt, stream) {
  const agentEventType = evt.eventType || evt.event || '';
  if (agentEventType === 'root_start') return;
  if (agentEventType === 'subagent_thinking') {
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) block.thinking = true;
    stream.renderer.schedule();
    return;
  }
  if (agentEventType === 'subagent_start') {
    let block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (!block) {
      block = {
        type: 'subagent-run',
        runId: evt.runId,
        parentRunId: evt.parentRunId || null,
        status: 'running',
        label: evt.label || 'Subagent',
        task: evt.task || '',
        text: '',
        events: [],
        timeline: [],
        blocks: [],
      };
      stream.blocks.push(block);
    }
    pushSubagentEvent(block, evt);
  } else if (agentEventType === 'subagent_delta') {
    if (state.activeId === stream.conversationId) hideThinkingPopup();
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) {
      appendSubagentText(block, evt.text || '');
    }
  } else if (agentEventType === 'subagent_done') {
    if (state.activeId === stream.conversationId) hideThinkingPopup();
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) {
      block.thinking = false;
      block.status = evt.status || 'completed';
      block.text = evt.result?.text || block.text || '';
      block.error = evt.error || '';
      block.durationMs = evt.durationMs ?? block.durationMs;
      block.parentRunId = evt.parentRunId || block.parentRunId || null;
      block.rootRunId = evt.rootRunId || block.rootRunId || null;
      pushSubagentEvent(block, evt);
      block.collapsed = true;
    }
    stream.renderer.flush({ rememberCollapseState: false });
    return;
  } else if (agentEventType === 'subagent_tool_call' || agentEventType === 'subagent_server_tool') {
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) {
      block.thinking = false;
      pushSubagentEvent(block, evt);
    }
  } else if (agentEventType === 'subagent_tool_result') {
    for (let i = stream.blocks.length - 1; i >= 0; i--) {
      const block = stream.blocks[i];
      if (block.type === 'subagent-run' && block.runId === evt.runId) {
        block.thinking = false;
        block.status = evt.isError ? 'tool_error' : block.status || 'running';
        pushSubagentEvent(block, evt);
        break;
      }
    }
  }
  stream.renderer.schedule();
}

export function appendStreamEvent(evt, stream) {
  stream.lastSeq = Math.max(stream.lastSeq || 0, Number(evt.seq || 0));

  if (evt.type === 'chat_run_start') {
    if (evt.chatRunId) stream.runId = evt.chatRunId;
    return;
  }

  if (evt.type === 'thinking') {
    if (state.activeId === stream.conversationId) showThinkingPopup(evt.text);
    return;
  }

  if (evt.type === 'delta') {
    if (state.activeId === stream.conversationId) hideThinkingPopup();
    currentTextBlock(stream.blocks).content += evt.text;
    stream.renderer.schedule();
    return;
  }

  if (evt.type === 'tool_call') {
    stream.renderer.schedule();
    return;
  }

  if (evt.type === 'tool_result') {
    applyToolResult(evt, stream);
    return;
  }

  if (evt.type === 'agent_event') {
    applyAgentEvent(evt, stream);
    return;
  }

  if (evt.type === 'error') {
    stream.status = 'error';
    stream.error = evt.message || 'Unknown error';
    stream.renderer.cancel();
  }
}
