import { subagentEventToBlocks } from './message-blocks.js';
import { STREAM_AGENT_EVENT_TYPES, STREAM_EVENT_TYPES, streamAgentEventType } from './stream-events.js';
import { hideThinkingPopup, showThinkingPopup } from './thinking-popup.js';
import { isActiveConversation } from './stores/app-store.js';

function defaultEffects(stream) {
  return {
    isActiveConversation: () => isActiveConversation(stream.conversationId),
    showThinking: showThinkingPopup,
    hideThinking: hideThinkingPopup,
    scheduleRender: () => stream.renderer.schedule(),
    flushRender: (options) => stream.renderer.flush(options),
    cancelRender: () => stream.renderer.cancel(),
  };
}

function currentTextBlock(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text') return blocks[i];
  }
  const block = { type: 'text', content: '' };
  blocks.push(block);
  return block;
}

function pushSubagentEvent(block, evt) {
  const eventType = streamAgentEventType(evt);
  if (eventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_DELTA || eventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_THINKING) return;
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

function markExistingShellCommandErrored(tool, stream) {
  if (tool.name !== 'shell_command' || !tool.id || !tool.isError) return false;
  const existing = stream.blocks.find(block => block.type === 'shell-command' && block.toolCallId === tool.id);
  if (!existing) return false;
  Object.assign(existing, {
    status: 'error',
    durationMs: tool.durationMs,
    stderr: existing.stderr || 'Tool execution was blocked or failed before command output was available.',
    collapsed: true,
  });
  return true;
}

function markExistingBrowserActionErrored(tool, stream) {
  if (tool.name !== 'browser_action' || !tool.id || !tool.isError) return false;
  const existing = stream.blocks.find(block => block.type === 'browser-action' && block.toolCallId === tool.id);
  if (!existing) return false;
  existing.status = 'error';
  existing.error = String(tool.output || 'Browser action failed');
  existing.durationMs = tool.durationMs;
  existing.steps = Array.isArray(existing.steps) ? existing.steps : [];
  existing.steps.push({
    phase: 'error',
    action: existing.action || 'browser',
    label: existing.error,
    ts: new Date().toISOString(),
  });
  existing.collapsed = false;
  return true;
}

function applyToolResult(evt, stream, effects) {
  for (const tool of evt.tools) {
    if (markExistingBrowserActionErrored(tool, stream)) continue;
    if (markExistingShellCommandErrored(tool, stream)) continue;
    if (tool.renderType && tool.data) {
      if (tool.renderType === 'browser-action' && tool.id) {
        const existing = stream.blocks.find(block => block.type === 'browser-action' && block.toolCallId === tool.id);
        if (existing) {
          Object.assign(existing, {
            type: 'browser-action',
            toolCallId: tool.id,
            status: tool.isError ? 'error' : 'completed',
            ...tool.data,
          });
          existing.collapsed = !tool.isError;
          continue;
        }
      }
      if (tool.renderType === 'shell-command' && tool.id) {
        const existing = stream.blocks.find(block => block.type === 'shell-command' && block.toolCallId === tool.id);
        if (existing) {
          Object.assign(existing, { type: 'shell-command', toolCallId: tool.id, status: tool.isError ? 'error' : 'completed', ...tool.data });
          existing.collapsed = true;
          continue;
        }
      }
      if (tool.renderType === 'subagent-run' && tool.data.runId) {
        const existing = stream.blocks.find(block => block.type === 'subagent-run' && block.runId === tool.data.runId);
        if (existing) {
          Object.assign(existing, { ...tool.data, type: 'subagent-run' });
          if (existing.collapsed === undefined && isTerminalSubagentBlock(existing)) existing.collapsed = true;
          continue;
        }
      }
      const block = { type: tool.renderType, ...tool.data };
      if (tool.id) block.toolCallId = tool.id;
      if (isTerminalSubagentBlock(block)) block.collapsed = true;
      if (block.type === 'source-cards' || block.type === 'sources' || block.type === 'web-fetch' || block.type === 'file-snippet' || block.type === 'file-write' || block.type === 'symbol-list' || block.type === 'grep-matches' || block.type === 'glob-list' || block.type === 'shell-command') block.collapsed = true;
      if (block.type === 'browser-action') block.collapsed = !tool.isError;
      stream.blocks.push(block);
    }
  }
  const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
  if (errored) currentTextBlock(stream.blocks).content += `\n\n_Tool error: ${errored}_`;
  stream.blocks.push({ type: 'text', content: '' });
  effects.scheduleRender();
}

function applyToolCall(evt, stream, effects) {
  for (const tool of evt.tools || []) {
    if (tool.name === 'browser_action' && tool.id) {
      const existing = stream.blocks.find(block => block.type === 'browser-action' && block.toolCallId === tool.id);
      if (existing) {
        Object.assign(existing, {
          status: 'running',
          action: tool.input?.action || existing.action || 'browser',
          textQuery: tool.input?.action !== 'type' ? tool.input?.text || existing.textQuery || '' : existing.textQuery || '',
          collapsed: false,
        });
        continue;
      }
      stream.blocks.push({
        type: 'browser-action',
        toolCallId: tool.id,
        status: 'running',
        action: tool.input?.action || 'browser',
        url: tool.input?.url || '',
        selector: tool.input?.selector || '',
        textQuery: tool.input?.action !== 'type' ? tool.input?.text || '' : '',
        key: tool.input?.key || '',
        steps: [{
          phase: 'call',
          action: tool.input?.action || 'browser',
          label: `call ${tool.input?.action || 'browser'}`,
          ts: new Date().toISOString(),
        }],
        collapsed: false,
        startedAt: Date.now(),
      });
      continue;
    }
    if (tool.name !== 'shell_command' || !tool.id) continue;
    const existing = stream.blocks.find(block => block.type === 'shell-command' && block.toolCallId === tool.id);
    if (existing) {
      Object.assign(existing, {
        status: 'running',
        command: tool.input?.command || existing.command || 'shell command',
        cwd: tool.input?.cwd || existing.cwd || '',
        startedAt: Date.now(),
        collapsed: false,
      });
      continue;
    }
    stream.blocks.push({
      type: 'shell-command',
      toolCallId: tool.id,
      status: 'running',
      command: tool.input?.command || 'shell command',
      cwd: tool.input?.cwd || '',
      stdout: '',
      stderr: '',
      collapsed: false,
      startedAt: Date.now(),
    });
  }
  effects.scheduleRender();
}

function applyToolDelta(evt, stream, effects) {
  if (evt.name === 'browser_action' && evt.id) {
    const block = stream.blocks.find(item => item.type === 'browser-action' && item.toolCallId === evt.id);
    if (!block) return;
    block.steps = Array.isArray(block.steps) ? block.steps : [];
    block.steps.push({
      phase: evt.phase || 'event',
      action: evt.action || block.action || 'browser',
      label: evt.label || `${evt.phase || 'event'} ${evt.action || block.action || 'browser'}`,
      ts: evt.ts || new Date().toISOString(),
      url: evt.url,
      title: evt.title,
      selector: evt.selector,
      textQuery: evt.textQuery,
      key: evt.key,
      waitUntil: evt.waitUntil,
      waitState: evt.waitState,
      statusCode: evt.statusCode,
      screenshotUrl: evt.screenshotUrl,
      screenshotPath: evt.screenshotPath,
      count: evt.count,
      textLength: evt.textLength,
      resultType: evt.resultType,
      truncated: evt.truncated,
      fullPage: evt.fullPage,
      closed: evt.closed,
    });
    if (evt.url) block.url = evt.url;
    if (evt.title) block.title = evt.title;
    if (evt.textQuery) block.textQuery = evt.textQuery;
    if (evt.screenshotUrl) block.screenshotUrl = evt.screenshotUrl;
    if (evt.screenshotPath) block.screenshotPath = evt.screenshotPath;
    block.status = evt.phase === 'complete' ? 'completed' : 'running';
    block.collapsed = false;
    effects.scheduleRender();
    return;
  }

  if (evt.name === 'shell_command' && evt.id) {
    const block = stream.blocks.find(item => item.type === 'shell-command' && item.toolCallId === evt.id);
    if (!block) return;
    if (evt.stream === 'stderr') {
      block.stderr = (block.stderr || '') + (evt.text || '');
    } else {
      block.stdout = (block.stdout || '') + (evt.text || '');
    }
    block.status = block.status || 'running';
    block.collapsed = false;
    effects.scheduleRender();
  }
}

function applyAgentEvent(evt, stream, effects) {
  const agentEventType = streamAgentEventType(evt);
  if (agentEventType === STREAM_AGENT_EVENT_TYPES.ROOT_START) return;
  if (agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_THINKING) {
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) block.thinking = true;
    effects.scheduleRender();
    return;
  }
  if (agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_START) {
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
  } else if (agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_DELTA) {
    if (effects.isActiveConversation()) effects.hideThinking();
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) {
      appendSubagentText(block, evt.text || '');
    }
  } else if (agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_DONE) {
    if (effects.isActiveConversation()) effects.hideThinking();
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
    effects.flushRender({ rememberCollapseState: false });
    return;
  } else if (agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_TOOL_CALL || agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_SERVER_TOOL) {
    const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
    if (block) {
      block.thinking = false;
      pushSubagentEvent(block, evt);
    }
  } else if (agentEventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_TOOL_RESULT) {
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
  effects.scheduleRender();
}

export function appendStreamEvent(evt, stream, injectedEffects = null) {
  const effects = injectedEffects || defaultEffects(stream);
  stream.lastSeq = Math.max(stream.lastSeq || 0, Number(evt.seq || 0));

  if (evt.type === STREAM_EVENT_TYPES.CHAT_RUN_START) {
    if (evt.chatRunId) stream.runId = evt.chatRunId;
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.THINKING) {
    if (effects.isActiveConversation()) effects.showThinking(evt.text);
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.DELTA) {
    if (effects.isActiveConversation()) effects.hideThinking();
    currentTextBlock(stream.blocks).content += evt.text;
    effects.scheduleRender();
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.TOOL_CALL) {
    applyToolCall(evt, stream, effects);
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.TOOL_DELTA) {
    applyToolDelta(evt, stream, effects);
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.TOOL_RESULT) {
    applyToolResult(evt, stream, effects);
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.AGENT_EVENT) {
    applyAgentEvent(evt, stream, effects);
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.ERROR) {
    stream.status = 'error';
    stream.error = evt.message || 'Unknown error';
    effects.cancelRender();
  }
}
