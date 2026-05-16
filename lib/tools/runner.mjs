import { appendToolRun } from './runs.mjs';
import { getToolRuntime } from './registry.mjs';

function timeoutAfter(ms, name) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms: ${name}`)), ms);
  });
}

function abortAfter(signal) {
  if (!signal) return null;
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Tool execution aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('Tool execution aborted')), { once: true });
  });
}

export function formatToolOutput(output) {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

const identity = (result) => result;
const passThrough = (_input, output) => output;
const noop = () => {};

/**
 * Run a tool call with lifecycle hooks.
 *
 * Hook order: validate → before → handler → after → onComplete
 * On error:  validate/before/handler/after throw → onError → onComplete(always)
 *
 * Hooks available on a tool definition (all optional):
 *   validate(input, {config, context})        — throw to reject; called before before
 *   before(input, {config, context})          — return {skipHandler:true, result} to skip handler
 *   after(input, output, {config, context})   — transform the handler result; return new result
 *   onError(err, input, {config, context})    — handle errors gracefully; can return fallback or re-throw
 *   onComplete(outcome, durationMs)           — fire-and-forget callback for metrics/logging
 *       outcome: {id, name, isError, input, output, error}
 */
export async function runTool(call, context = {}) {
  const startedAt = Date.now();
  const runtime = await getToolRuntime(call.name);
  const { signal, ...runtimeContext } = context;

  if (!runtime) {
    const result = {
      id: call.id,
      name: call.name,
      isError: true,
      output: `Unknown or disabled tool: ${call.name}`,
      durationMs: Date.now() - startedAt,
    };
    await appendToolRun({ ...result, input: call.input || {}, context: runtimeContext }).catch(() => {});
    return result;
  }

  const { tool, config } = runtime;
  const timeoutMs = config.timeoutMs || tool.timeoutMs || 10000;
  const input = call.input || {};
  const hookCtx = { config: config.config || {}, context: runtimeContext, signal };

  const validate = tool.validate || noop;
  const before = tool.before || identity;
  const after = tool.after || passThrough;
  const onError = tool.onError || null;

  let output, isError;
  let error;
  let handlerInput;

  try {
    if (signal?.aborted) throw new Error('Tool execution aborted');

    await validate(input, hookCtx);

    const beforeResult = await before(input, hookCtx);
    handlerInput = input;

    if (beforeResult && beforeResult.skipHandler) {
      output = beforeResult.result;
    } else {
      if (beforeResult !== undefined) handlerInput = beforeResult;
      output = await Promise.race([
        tool.handler(handlerInput, hookCtx),
        timeoutAfter(timeoutMs, tool.name),
        abortAfter(signal),
      ].filter(Boolean));
    }

    output = await after(handlerInput, output, hookCtx);
    isError = false;
  } catch (err) {
    error = err;
    if (onError) {
      try {
        output = await onError(err, input, hookCtx);
        isError = false;
      } catch (onErrErr) {
        output = onErrErr.message || String(onErrErr);
        isError = true;
      }
    } else {
      output = error.message || String(error);
      isError = true;
    }
  }

  const durationMs = Date.now() - startedAt;
  const result = { id: call.id, name: call.name, isError, output, durationMs };

  // parseResult — convert handler output to frontend render metadata
  let render;
  if (!isError && typeof tool.parseResult === 'function') {
    try {
      render = tool.parseResult(output, handlerInput);
    } catch {}
  }
  if (render) result.render = render;

  // onComplete — fire-and-forget, never throws into caller
  try {
    const outcome = { ...result, input, ...(error && { error }) };
    const onComplete = tool.onComplete || noop;
    onComplete(outcome, durationMs);
  } catch {}

  await appendToolRun({ ...result, input, context: runtimeContext }).catch(() => {});
  return result;
}
