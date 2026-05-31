import { subagentEventToBlocks } from './message-blocks.js';
import { STREAM_AGENT_EVENT_TYPES, STREAM_EVENT_TYPES, streamAgentEventType } from './stream-events.js';
import {
  buildRunningToolBlock,
  collapseFinishedToolBlock,
  isTerminalSubagentBlock,
  shouldKeepToolBlockExpanded,
  shouldCreateRunningToolBlock,
} from './tool-block-collapse.js';
import { hideThinkingPopup, showThinkingPopup } from './thinking-popup.js';
import { isActiveConversation } from './stores/app-store.js';
import { completeBrowserLivePreview, updateBrowserLivePreview } from './browser-live-preview.js';
import {
  dispatchAskUserPending,
  dispatchToolCall,
  dispatchToolDelta,
  dispatchToolResultTool,
  getStreamHelpers,
} from './tool-stream-registry.js';
import { getStreamModules } from './tool-ui-registry.js';
import { applyBlockOptions } from './tool-ui-registry.js';

function defaultEffects(stream) {
  return {
    isActiveConversation: () => isActiveConversation(stream.conversationId),
    showThinking: showThinkingPopup,
    hideThinking: hideThinkingPopup,
    scheduleRender: () => stream.renderer.schedule(),
    flushRender: (options) => stream.renderer.flush(options),
    cancelRender: () => stream.renderer.cancel(),
    updateBrowserLivePreview: (payload, options) => updateBrowserLivePreview(payload, options),
    completeBrowserLivePreview: (tool, options) => completeBrowserLivePreview(tool, options),
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

function currentBlockTextBlock(block) {
  block.blocks = Array.isArray(block.blocks) ? block.blocks : [];
  return currentTextBlock(block.blocks);
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
  applySubagentEventBlocks(block, evt);
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

function streamModules() {
  return getStreamModules();
}

function streamHelpers() {
  return getStreamHelpers(streamModules());
}

function findToolBlockByCallId(stream, toolCallId) {
  if (!toolCallId) return null;
  return stream.blocks.find(block => block.toolCallId === toolCallId && block.type !== 'text') || null;
}

function replaceToolBlock(existing, next) {
  if (!existing) return next;
  const toolCallId = existing.toolCallId;
  Object.keys(existing).forEach(key => { delete existing[key]; });
  Object.assign(existing, next, toolCallId ? { toolCallId } : {});
  return existing;
}

function findNestedToolBlockByCallId(block, toolCallId) {
  if (!toolCallId || !Array.isArray(block?.blocks)) return null;
  return block.blocks.find(item => item.toolCallId === toolCallId && item.type !== 'text') || null;
}

function applyToolCallBlock(blocks, tool) {
  if (!Array.isArray(blocks) || !tool?.id) return;
  if (tool.name === 'shell_command') {
    const existing = blocks.find(item => item.type === 'shell-command' && item.toolCallId === tool.id);
    const next = {
      type: 'shell-command',
      toolCallId: tool.id,
      status: 'running',
      command: tool.input?.command || existing?.command || 'shell command',
      cwd: tool.input?.cwd || existing?.cwd || '',
      stdout: existing?.stdout || '',
      stderr: existing?.stderr || '',
      collapsed: false,
      startedAt: Date.now(),
    };
    if (existing) Object.assign(existing, next);
    else blocks.push(next);
    return;
  }

  if (shouldCreateRunningToolBlock(tool) && !blocks.some(item => item.toolCallId === tool.id && item.type !== 'text')) {
    blocks.push(buildRunningToolBlock(tool));
  }
}

function applyToolResultBlock(block, tool) {
  block.blocks = Array.isArray(block.blocks) ? block.blocks : [];
  const existing = findNestedToolBlockByCallId(block, tool.id);
  const renderType = tool.renderType;

  if (!renderType) {
    if (existing) {
      existing.status = tool.isError ? 'error' : 'completed';
      existing.durationMs = tool.durationMs;
      if (tool.isError) existing.error = String(tool.output || 'Tool failed');
      collapseFinishedToolBlock(existing);
    } else if (tool.isError) {
      currentBlockTextBlock(block).content += `\n\n_Tool error: ${tool.name || 'tool'}_`;
    }
    return;
  }

  if (!tool.data && !tool.isError) return;

  const nextBlock = {
    type: renderType,
    ...(tool.data || {}),
    status: tool.isError ? 'error' : 'completed',
    toolCallId: tool.id,
  };
  applyBlockOptions(nextBlock);

  const target = existing
    ? (existing.type === 'tool-running' || existing.type !== renderType ? replaceToolBlock(existing, nextBlock) : Object.assign(existing, nextBlock))
    : nextBlock;

  if (!existing) block.blocks.push(target);
  if (!shouldKeepToolBlockExpanded(target)) collapseFinishedToolBlock(target);
}

function applySubagentEventBlocks(block, evt) {
  const eventType = streamAgentEventType(evt);
  if (eventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_TOOL_CALL) {
    applyToolCallBlock(block.blocks, {
      id: evt.toolCallId,
      name: evt.name,
      input: evt.input || {},
    });
    return;
  }
  if (eventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_TOOL_RESULT) {
    applyToolResultBlock(block, {
      id: evt.toolCallId,
      name: evt.name,
      isError: evt.isError,
      durationMs: evt.durationMs,
      output: evt.output,
      renderType: evt.renderType,
      data: evt.data,
    });
    return;
  }
  if (eventType === STREAM_AGENT_EVENT_TYPES.SUBAGENT_SERVER_TOOL) {
    const serverEvent = evt.event || {};
    if (serverEvent.phase === 'call') {
      applyToolCallBlock(block.blocks, {
        id: serverEvent.id,
        name: serverEvent.name || evt.name,
        input: serverEvent.input || {},
      });
      return;
    }
    if (serverEvent.phase === 'result') {
      applyToolResultBlock(block, {
        id: serverEvent.id,
        name: serverEvent.name || evt.name,
        isError: serverEvent.isError,
        output: serverEvent.data || serverEvent.errorCode || {},
        renderType: serverEvent.renderType,
        data: serverEvent.data,
      });
      return;
    }
  }
  block.blocks.push(...subagentEventToBlocks(evt));
}

function applyAskUserPending(evt, stream, effects) {
  dispatchAskUserPending(evt, stream, effects, streamModules());
}

function applyToolResult(evt, stream, effects) {
  const helpers = {
    findToolBlockByCallId,
    collapseFinishedToolBlock,
    ...streamHelpers(),
  };
  for (const tool of evt.tools) {
    if (dispatchToolResultTool(tool, stream, effects, streamModules(), helpers)) continue;

    const renderType = tool.renderType;
    const existing = findToolBlockByCallId(stream, tool.id);

    if (!renderType) {
      if (existing) {
        existing.status = tool.isError ? 'error' : 'completed';
        if (tool.isError) existing.error = String(tool.output || 'Tool failed');
        collapseFinishedToolBlock(existing);
      }
      continue;
    }

    if (!tool.data && !tool.isError) continue;

    if (renderType === 'subagent-run' && tool.data?.runId) {
      const subagent = stream.blocks.find(block => block.type === 'subagent-run' && block.runId === tool.data.runId) || existing;
      if (subagent) {
        Object.assign(subagent, { type: 'subagent-run', ...tool.data });
        if (tool.id) subagent.toolCallId = tool.id;
        collapseFinishedToolBlock(subagent);
        continue;
      }
    }

    const status = tool.isError ? 'error' : 'completed';
    const nextBlock = {
      type: renderType,
      ...(tool.data || {}),
      status,
      toolCallId: tool.id,
    };
    applyBlockOptions(nextBlock);

    if (existing) {
      if (existing.type === 'tool-running' || existing.type !== renderType) {
        replaceToolBlock(existing, nextBlock);
      } else {
        Object.assign(existing, nextBlock);
      }
      collapseFinishedToolBlock(existing);
      continue;
    }

    const block = { ...nextBlock };
    collapseFinishedToolBlock(block);
    stream.blocks.push(block);
  }
  const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
  if (errored) currentTextBlock(stream.blocks).content += `\n\n_Tool error: ${errored}_`;
  stream.blocks.push({ type: 'text', content: '' });
  effects.flushRender({ rememberCollapseState: false });
}

function applyToolCall(evt, stream, effects) {
  dispatchToolCall(evt, stream, effects, streamModules());
  for (const tool of evt.tools || []) {
    if (['browser_action', 'ask_user', 'shell_command'].includes(tool.name)) continue;

    if (shouldCreateRunningToolBlock(tool) && !findToolBlockByCallId(stream, tool.id)) {
      stream.blocks.push(buildRunningToolBlock(tool));
    }
  }
  effects.scheduleRender();
}

function applyToolDelta(evt, stream, effects) {
  if (dispatchToolDelta(evt, stream, effects, streamModules())) return;
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
        expertAgent: evt.expertAgent || null,
        text: '',
        events: [],
        timeline: [],
        blocks: [],
        collapsed: false,
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
      block.expertAgent = evt.expertAgent || evt.result?.expertAgent || block.expertAgent || null;
      pushSubagentEvent(block, evt);
      collapseFinishedToolBlock(block);
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
        if (!isTerminalSubagentBlock(block)) block.status = 'running';
        if (evt.isError) {
          block.lastToolError = {
            name: evt.name || '',
            toolCallId: evt.toolCallId || '',
            message: String(evt.output || evt.error || 'Tool failed'),
          };
        }
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

  if (evt.type === STREAM_EVENT_TYPES.ASSISTANT_RETRY) {
    if (effects.isActiveConversation()) effects.hideThinking();
    stream.blocks = [{ type: 'text', content: '' }];
    stream.retryReason = evt.reason || 'tool_call_missing';
    stream.retryMessage = evt.message || '';
    effects.flushRender({ rememberCollapseState: false });
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.TOOL_CALL) {
    applyToolCall(evt, stream, effects);
    return;
  }

  if (evt.type === STREAM_EVENT_TYPES.ASK_USER_PENDING) {
    applyAskUserPending(evt, stream, effects);
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
