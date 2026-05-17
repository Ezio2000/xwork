import { streamChat as defaultStreamChat } from './api.mjs';
import { runTool as defaultRunTool, formatToolOutput } from './tools/runner.mjs';

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

const DELEGATE_TASK_TOOL_NAME = 'delegate_task';

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
  onDelta,
  onThinkingDelta,
  onServerToolEvent,
}) {
  const streamChat = _streamChat || defaultStreamChat;
  const runTool = _runTool || defaultRunTool;

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

  while (true) {
    if (signal?.aborted) {
      return {
        reason: 'aborted',
        messages,
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
        messages,
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
        messages,
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

    // No tool calls — conversation complete
    if (!result.toolCalls?.length) {
      messages.push(buildAssistantMessage(result));
      return {
        reason: 'completed',
        messages,
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

    // Yield tool_call events
    for (const call of result.toolCalls) {
      yield { type: 'tool_call', id: call.id, name: call.name, input: call.input || {} };
    }

    // Execute tools. Most tools stay sequential. delegate_task is the only
    // intentionally parallelized tool because subagents are independent
    // short-lived workers and their internal events stream through agent_event.
    const toolResults = [];
    const executeCall = async (call) => {
      const toolRunContext = signal ? { ...toolContext, signal } : toolContext;
      const outcome = await runTool(call, toolRunContext);
      if (outcome.render) {
        allBuiltinToolResults.push({ callId: outcome.id, ...outcome.render });
      }
      return outcome;
    };
    const publishOutcome = function* (call, outcome) {
      toolResults.push(outcome);
      yield {
        type: 'tool_result',
        id: outcome.id,
        name: outcome.name,
        isError: outcome.isError,
        durationMs: outcome.durationMs,
        output: outcome.output,
        ...(outcome.render ? { renderType: outcome.render.renderType, data: outcome.render.data } : {}),
        input: call.input || {},
      };
    };

    for (let i = 0; i < result.toolCalls.length;) {
      if (signal?.aborted) {
        return {
          reason: 'aborted',
          messages,
          text: accumulatedText,
          content: allContent,
          serverToolEvents: allServerToolEvents,
          builtinToolResults: allBuiltinToolResults,
          stopReason: lastStopReason,
          usage: lastUsage,
          result: lastResult,
        };
      }

      const call = result.toolCalls[i];
      if (call.name === DELEGATE_TASK_TOOL_NAME) {
        const batch = [];
        while (i < result.toolCalls.length && result.toolCalls[i].name === DELEGATE_TASK_TOOL_NAME) {
          batch.push(result.toolCalls[i]);
          i++;
        }
        const outcomes = batch.length > 1
          ? await Promise.all(batch.map(executeCall))
          : [await executeCall(batch[0])];
        for (let j = 0; j < outcomes.length; j++) {
          yield* publishOutcome(batch[j], outcomes[j]);
        }
        continue;
      }

      const outcome = await executeCall(call);
      yield* publishOutcome(call, outcome);
      i++;
    }

    // Append tool results to messages for next API call
    messages.push(buildToolResultMessage(toolResults));

    // Max turns check
    if (turnCount >= maxTurns) {
      return {
        reason: 'max_turns',
        messages,
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
