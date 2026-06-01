import { streamChat as defaultStreamChat } from './api.mjs';
import { runTool as defaultRunTool, formatToolOutput } from './tools/runner.mjs';
import { createToolEventQueue, defaultToolScheduler, executeToolCalls } from './tools/scheduler.mjs';
import { RUN_EVENT_TYPES } from './run-events.mjs';

function buildAssistantMessage(result) {
  const content = Array.isArray(result.content) && result.content.length
    ? result.content
    : [{ type: 'text', text: result.text || '' }];
  return { role: 'assistant', content };
}

function buildToolResultMessage(results) {
  return {
    role: 'user',
    content: results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: formatToolOutput(r.output),
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}

function serverEventKey(event) {
  return `${event.phase || ''}:${event.id || ''}:${event.name || ''}:${event.renderType || ''}`;
}

function hasServerToolActivity(result, turnServerToolEvents) {
  if (turnServerToolEvents.length || result.serverToolEvents?.length) return true;
  return (result.content || []).some(block => block?.type === 'server_tool_use' || block?.type === 'web_search_tool_result');
}

function hasSubstantiveText(result) {
  const text = String(result?.text || '').trim();
  if (!text) return false;
  const prefixOnly = /^(let me search( for)?|let me look( for)?|i'?ll search|i will search|searching now)[^.?!\n]*[.?!\n]*$/i;
  return !prefixOnly.test(text);
}

const ASSERTED_TOOL_ACTION_PATTERNS = [
  /(?:我|让我|现在|重新|再|先|已|已经|好的|好，|接下来|下一步)[^。！？\n]*(?:打开|进入|点击|切换|输入|填入|填写|发送|截图|截个图|重新打开|查找|检查|定位|刷新|等待|尝试登录|触发|操作|执行|运行|读取|搜索|访问|下载|上传|创建|写入|修改|删除|保存|查看页面|看一下页面|看看页面)/,
  /(?:已|已经)[^。！？\n]*(?:打开|点击|切换|输入|填入|填写|发送|截图|保存|完成|触发|重新打开)/,
  /(?:I'll|I will|Let me|Now I|Next I|First I)[^.!?\n]*\b(?:open|click|type|fill|send|screenshot|capture|search|fetch|read|write|run|execute|inspect|check|download|upload|save|delete|modify|navigate|refresh|wait)\b/i,
  /(?:I've|I have|already|just|done|completed)[^.!?\n]*\b(?:opened|clicked|typed|filled|sent|screenshotted|captured|searched|fetched|read|wrote|ran|executed|inspected|checked|downloaded|uploaded|saved|deleted|modified|navigated|refreshed)\b/i,
];

function toolNames(config) {
  return (config?.tools || [])
    .map(tool => tool?.name || tool?.id)
    .filter(Boolean);
}

function claimsExternalToolAction(result, config) {
  const text = String(result?.text || '').trim();
  if (!text) return false;
  return ASSERTED_TOOL_ACTION_PATTERNS.some(pattern => pattern.test(text));
}

function missingToolCallCorrection(toolNameList) {
  const names = toolNameList.length ? ` Available tools include: ${toolNameList.join(', ')}.` : '';
  return [
    'The previous assistant message described actions that affect external state, but it did not include any structured tool_use or server tool call.',
    'Do not claim those actions were done.',
    'If the user request requires action, call the appropriate tool now; otherwise explain that you cannot perform the action.',
    names,
  ].join(' ').trim();
}

function publicMessages(messages) {
  return messages.filter(message => !message?.__internal);
}

/**
 * Multi-turn tool-calling loop engine.
 *
 * Uses a while(true) + state-machine pattern (inspired by Claude Code's query.ts)
 * to drive multi-turn conversations with tool execution. Yields turn-level events
 * so callers can stream progress; streaming deltas flow through callbacks.
 *
 * @param {Object} opts
 * @param {Object} opts.config        - Channel config (baseUrl, apiKey, model, maxTokens, tools, extraHeaders)
 * @param {Array}  opts.history       - Initial message array (Anthropic format)
 * @param {number} [opts.maxTurns=5]  - Maximum tool-calling rounds
 * @param {AbortSignal} [opts.signal] - Abort signal to cancel mid-turn
 * @param {Object} [opts.toolContext] - Extra context passed to runTool (conversationId, etc.)
 * @param {Function} [opts.streamChat] - Injectable streamChat (default: lib/api.mjs)
 * @param {Function} [opts.runTool]    - Injectable runTool (default: lib/tools/runner.mjs)
 * @param {Function} [opts.beforeToolCall] - Optional guard hook before local tool execution
 * @param {Function} [opts.onDelta]          - Called with each text delta
 * @param {Function} [opts.onThinkingDelta]  - Called with each thinking delta
 * @param {Function} [opts.onServerToolEvent]- Called for server-side tool events (web_search results, etc.)
 *
 * @yields {{ type: 'tool_call', id: string, name: string, input: Object }}
 * @yields {{ type: 'tool_result', id: string, name: string, isError: boolean, durationMs: number, output: any }}
 *
 * @returns {{ reason: string, messages: Array, text: string, content: Array, serverToolEvents: Array, stopReason: string|null, usage: Object|null, result: Object|null }}
 */
export async function* queryLoop({
  config,
  history,
  maxTurns = 5,
  signal,
  toolContext = {},
  streamChat: _streamChat,
  runTool: _runTool,
  toolScheduler = null,
  beforeToolCall = null,
  onDelta,
  onThinkingDelta,
  onServerToolEvent,
}) {
  const streamChat = _streamChat || defaultStreamChat;
  const runTool = _runTool || defaultRunTool;
  const scheduler = toolScheduler || defaultToolScheduler({ tools: config?.tools || [] });

  // Mutable state — rebuilt each iteration at the "continue" site
  let messages = [...history];
  let turnCount = 0;
  let accumulatedText = '';
  let allContent = [];
  let allServerToolEvents = [];
  const serverToolEventKeys = new Set();
  let allBuiltinToolResults = [];
  let lastUsage = null;
  let lastStopReason = null;
  let lastResult = null;
  let missingToolCallCorrections = 0;
  let localToolResultCount = 0;

  while (true) {
    if (signal?.aborted) {
      return {
        reason: 'aborted',
        messages: publicMessages(messages),
        text: accumulatedText,
        content: allContent,
        serverToolEvents: allServerToolEvents,
        builtinToolResults: allBuiltinToolResults,
        stopReason: lastStopReason,
        usage: lastUsage,
        result: lastResult,
      };
    }

    turnCount++;

    const textCheckpoint = accumulatedText.length;
    const contentCheckpoint = allContent.length;
    const serverToolEventCheckpoint = allServerToolEvents.length;
    const serverToolKeyCheckpoint = new Set(serverToolEventKeys);
    let turnFullText = '';
    const turnServerToolEvents = [];
    let turnError = null;

    let result;
    const appendServerToolEvent = (event) => {
      const key = serverEventKey(event);
      if (serverToolEventKeys.has(key)) return;
      serverToolEventKeys.add(key);
      allServerToolEvents.push(event);
    };
    try {
      result = await streamChat(
        config,
        messages,
        (delta) => {
          turnFullText += delta;
          accumulatedText += delta;
          onDelta?.(delta);
        },
        (thinkingText) => {
          onThinkingDelta?.(thinkingText);
        },
        (_fullText, stopReason, usage) => {
          lastStopReason = stopReason;
          lastUsage = usage;
        },
        (err) => {
          turnError = err;
        },
        (event) => {
          turnServerToolEvents.push(event);
          appendServerToolEvent(event);
          onServerToolEvent?.(event);
        },
        { signal },
      );
    } catch (err) {
      const aborted = signal?.aborted;
      return {
        reason: aborted ? 'aborted' : 'api_error',
        messages: publicMessages(messages),
        text: accumulatedText,
        content: allContent,
        serverToolEvents: allServerToolEvents,
        builtinToolResults: allBuiltinToolResults,
        stopReason: lastStopReason,
        usage: lastUsage,
        ...(aborted ? {} : { error: err.message || String(err) }),
        result: lastResult,
      };
    }

    // If streamChat called onError, surface it
    if (turnError) {
      const aborted = signal?.aborted;
      return {
        reason: aborted ? 'aborted' : 'api_error',
        messages: publicMessages(messages),
        text: accumulatedText,
        content: allContent,
        serverToolEvents: allServerToolEvents,
        builtinToolResults: allBuiltinToolResults,
        stopReason: lastStopReason,
        usage: lastUsage,
        ...(aborted ? {} : { error: turnError.message || String(turnError) }),
        result: lastResult,
      };
    }

    lastStopReason = result.stopReason || lastStopReason;
    lastUsage = result.usage || lastUsage;
    lastResult = result;
    if (result.content) allContent.push(...result.content);
    for (const event of result.serverToolEvents || []) {
      appendServerToolEvent(event);
    }

    if (!result.toolCalls?.length) {
      const assistantMessage = buildAssistantMessage(result);
      messages.push(assistantMessage);
      if (!hasServerToolActivity(result, turnServerToolEvents) && localToolResultCount === 0 && claimsExternalToolAction(result, config)) {
        assistantMessage.__internal = true;
        missingToolCallCorrections += 1;
        if (missingToolCallCorrections > 1 || turnCount >= maxTurns) {
          return {
            reason: 'api_error',
            messages: publicMessages(messages),
            text: accumulatedText,
            content: allContent,
            serverToolEvents: allServerToolEvents,
            builtinToolResults: allBuiltinToolResults,
            stopReason: lastStopReason,
            usage: lastUsage,
            error: 'The model described external tool actions but did not issue a structured tool call.',
            result: lastResult,
          };
        }
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: missingToolCallCorrection(toolNames(config)) }],
          __internal: true,
        });
        accumulatedText = accumulatedText.slice(0, textCheckpoint);
        allContent = allContent.slice(0, contentCheckpoint);
        allServerToolEvents = allServerToolEvents.slice(0, serverToolEventCheckpoint);
        serverToolEventKeys.clear();
        for (const key of serverToolKeyCheckpoint) serverToolEventKeys.add(key);
        yield {
          type: RUN_EVENT_TYPES.ASSISTANT_RETRY,
          reason: 'tool_call_missing',
          message: 'The assistant described tool actions without a structured tool call, so the turn is being retried.',
        };
        continue;
      }
      if (!hasSubstantiveText(result) && hasServerToolActivity(result, turnServerToolEvents)) {
        if (turnCount >= maxTurns) {
          return {
            reason: 'max_turns',
            messages: publicMessages(messages),
            text: accumulatedText,
            content: allContent,
            serverToolEvents: allServerToolEvents,
            builtinToolResults: allBuiltinToolResults,
            stopReason: lastStopReason,
            usage: lastUsage,
            result: lastResult,
          };
        }
        continue;
      }
      return {
        reason: 'completed',
        messages: publicMessages(messages),
        text: accumulatedText,
        content: allContent,
        serverToolEvents: allServerToolEvents,
        builtinToolResults: allBuiltinToolResults,
        stopReason: lastStopReason,
        usage: lastUsage,
        result,
      };
    }

    // Append assistant message for this turn (will send to API next round)
    messages.push(buildAssistantMessage(result));

    // Execute tools through a scheduling strategy so concurrency rules stay
    // outside the loop state machine.
    const toolResults = [];
    const toolEventQueue = createToolEventQueue();
    const executeCall = async (call) => {
      if (typeof beforeToolCall === 'function') {
        const guard = await beforeToolCall(call, {
          turnCount,
          messages,
          text: accumulatedText,
        });
        if (guard && guard.skip) {
          return {
            id: call.id,
            name: call.name,
            isError: true,
            output: guard.output || `Tool call skipped: ${call.name}`,
            durationMs: 0,
          };
        }
      }
      const toolRunContext = {
        ...toolContext,
        ...(signal ? { signal } : {}),
        emitToolEvent: (event) => {
          const base = {
            id: call.id,
            name: call.name,
            input: call.input || {},
            ...event,
          };
          if (call.name === 'ask_user' && event?.phase === 'pending') {
            toolEventQueue.push({
              type: RUN_EVENT_TYPES.ASK_USER_PENDING,
              ...base,
            });
          } else {
            toolEventQueue.push({
              type: RUN_EVENT_TYPES.TOOL_DELTA,
              ...base,
            });
          }
        },
      };
      const outcome = await runTool(call, toolRunContext);
      if (outcome.render) {
        allBuiltinToolResults.push({ callId: outcome.id, ...outcome.render });
      }
      return outcome;
    };
    const publishOutcome = (call, outcome) => {
      toolResults.push(outcome);
      return {
        type: RUN_EVENT_TYPES.TOOL_RESULT,
        id: outcome.id,
        name: outcome.name,
        isError: outcome.isError,
        durationMs: outcome.durationMs,
        output: outcome.output,
        ...(outcome.render ? { renderType: outcome.render.renderType, data: outcome.render.data } : {}),
        input: call.input || {},
      };
    };

    const toolIterator = executeToolCalls({
      calls: result.toolCalls,
      signal,
      executeCall,
      publishOutcome,
      scheduler,
      eventQueue: toolEventQueue,
    });
    let toolIterResult = await toolIterator.next();
    while (!toolIterResult.done) {
      yield toolIterResult.value;
      toolIterResult = await toolIterator.next();
    }
    if (toolIterResult.value?.aborted) {
      return {
        reason: 'aborted',
        messages: publicMessages(messages),
        text: accumulatedText,
        content: allContent,
        serverToolEvents: allServerToolEvents,
        builtinToolResults: allBuiltinToolResults,
        stopReason: lastStopReason,
        usage: lastUsage,
        result: lastResult,
      };
    }

    // Append tool results to messages for next API call
    messages.push(buildToolResultMessage(toolResults));
    localToolResultCount += toolResults.length;

    // Max turns check
    if (turnCount >= maxTurns) {
      return {
        reason: 'max_turns',
        messages: publicMessages(messages),
        text: accumulatedText,
        content: allContent,
        serverToolEvents: allServerToolEvents,
        builtinToolResults: allBuiltinToolResults,
        stopReason: lastStopReason,
        usage: lastUsage,
        result: lastResult,
      };
    }

    // Loop continues — while(true) re-enters with updated messages
  }
}
