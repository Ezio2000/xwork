import { subagentEventToBlocks } from './message-blocks.js';
import { STREAM_AGENT_EVENT_TYPES, STREAM_EVENT_TYPES, streamAgentEventType } from './stream-events.js';
import {
  buildRunningToolBlock,
  collapseFinishedToolBlock,
  isTerminalSubagentBlock,
  shouldCreateRunningToolBlock,
} from './tool-block-collapse.js';
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
  existing.collapsed = true;
  return true;
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

function applyAskUserPending(evt, stream, effects) {
  const toolCallId = evt.id;
  if (!toolCallId) return;
  const block = {
    type: 'ask-user',
    toolCallId,
    status: 'waiting',
    kind: evt.kind || 'text',
    question: evt.question || '',
    context: evt.context || '',
    options: evt.options,
    fields: evt.fields,
    allowSkip: evt.allowSkip !== false,
    allowCustom: evt.allowCustom === true,
    recommended: evt.recommended,
    default: evt.default,
    multiline: evt.multiline !== false,
    placeholder: evt.placeholder || '',
    min: evt.min,
    max: evt.max,
    minSelections: evt.minSelections,
    maxSelections: evt.maxSelections,
    collapsed: false,
  };
  const existing = stream.blocks.find(item => item.type === 'ask-user' && item.toolCallId === toolCallId);
  if (existing) Object.assign(existing, block);
  else stream.blocks.push(block);
  effects.scheduleRender();
}

function applyToolResult(evt, stream, effects) {
  for (const tool of evt.tools) {
    if (markExistingBrowserActionErrored(tool, stream)) continue;
    if (markExistingShellCommandErrored(tool, stream)) continue;

    const renderType = tool.renderType;
    const existing = findToolBlockByCallId(stream, tool.id);

    if (renderType === 'ask-user' && tool.id) {
      const block = existing || { type: 'ask-user', toolCallId: tool.id };
      Object.assign(block, {
        status: tool.isError ? 'error' : (tool.data?.status || 'answered'),
        ...tool.data,
      });
      if (!existing) stream.blocks.push(block);
      collapseFinishedToolBlock(block);
      continue;
    }

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
    if (renderType === 'feishu-media') {
      nextBlock.collapsed = false;
      nextBlock.fixedOpen = true;
    }

    if (existing) {
      if (existing.type === 'tool-running' || existing.type !== renderType) {
        replaceToolBlock(existing, nextBlock);
      } else {
        Object.assign(existing, nextBlock);
      }
      if (renderType === 'feishu-media') {
        existing.collapsed = false;
        existing.fixedOpen = true;
        continue;
      }
      collapseFinishedToolBlock(existing);
      continue;
    }

    const block = { ...nextBlock };
    if (renderType !== 'feishu-media') collapseFinishedToolBlock(block);
    stream.blocks.push(block);
  }
  const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
  if (errored) currentTextBlock(stream.blocks).content += `\n\n_Tool error: ${errored}_`;
  stream.blocks.push({ type: 'text', content: '' });
  effects.flushRender({ rememberCollapseState: false });
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
    if (tool.name === 'ask_user' && tool.id) {
      const existing = stream.blocks.find(block => block.type === 'ask-user' && block.toolCallId === tool.id);
      if (!existing) {
        stream.blocks.push({
          type: 'ask-user',
          toolCallId: tool.id,
          status: 'waiting',
          kind: tool.input?.kind || 'text',
          question: tool.input?.question || 'Waiting for your answer…',
          context: tool.input?.context || '',
          options: tool.input?.options,
          fields: tool.input?.fields,
          allowSkip: tool.input?.allowSkip !== false,
          allowCustom: tool.input?.allowCustom === true,
          collapsed: false,
        });
      }
      continue;
    }
    if (tool.name === 'shell_command' && tool.id) {
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
      continue;
    }

    if (shouldCreateRunningToolBlock(tool) && !findToolBlockByCallId(stream, tool.id)) {
      stream.blocks.push(buildRunningToolBlock(tool));
    }
  }
  effects.scheduleRender();
}

function applyToolDelta(evt, stream, effects) {
  if ((evt.name === 'feishu_read' || evt.name === 'feishu_auth') && evt.id) {
    const existing = stream.blocks.find(item => item.type === 'feishu-auth' && item.toolCallId === evt.id);
    if (evt.phase === 'feishu_auth_pending') {
      const url = evt.verificationUrl || evt.authorizationUrl || '';
      const block = existing || {
        type: 'feishu-auth',
        toolCallId: evt.id,
        status: 'waiting',
        collapsed: false,
      };
      Object.assign(block, {
        status: 'waiting',
        verificationUrl: url,
        authorizationUrl: url,
        deviceCode: evt.deviceCode || block.deviceCode || '',
        expiresAt: evt.expiresAt || block.expiresAt || '',
        popupBlocked: block.popupBlocked === true,
        popupOpened: block.popupOpened === true,
      });
      if (!existing) stream.blocks.push(block);
      if (url && !block.popupAttempted && typeof window !== 'undefined') {
        block.popupAttempted = true;
        try {
          const popup = window.open(url, `xwork-feishu-auth-${evt.id}`, 'popup,width=960,height=760,noopener,noreferrer');
          block.popupOpened = Boolean(popup);
          block.popupBlocked = !popup;
        } catch {
          block.popupBlocked = true;
        }
      }
      effects.scheduleRender();
      return;
    }
    if (evt.phase === 'feishu_auth_complete') {
      const block = existing || {
        type: 'feishu-auth',
        toolCallId: evt.id,
      };
      Object.assign(block, {
        status: 'completed',
        collapsed: true,
        popupBlocked: false,
      });
      if (!existing) stream.blocks.push(block);
      effects.scheduleRender();
      return;
    }
  }

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
