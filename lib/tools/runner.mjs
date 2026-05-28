import { appendToolRun } from './runs.mjs';
import { getToolRuntime } from './registry.mjs';

function createTimeout(ms, name) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms: ${name}`)), ms);
  });
  return {
    promise,
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function abortAfter(signal) {
  if (!signal) return null;
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error(abortMessage(signal)));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error(abortMessage(signal))), { once: true });
  });
}

function abortMessage(signal) {
  const reason = signal?.reason;
  const detail = typeof reason === 'string' ? reason : reason?.message || '';
  return detail ? `Tool execution aborted: ${detail}` : 'Tool execution aborted';
}

const LARGE_TEXT_LIMIT = 50_000;

function sanitizeToolOutputValue(value) {
  if (value?.resourceType === 'media') {
    return {
      action: value.action,
      resourceType: value.resourceType,
      fileToken: value.fileToken,
      contentType: value.contentType,
      sizeBytes: value.size,
      filename: value.filename,
      previewUrl: value.previewUrl || value.url,
      displayedInUi: true,
      note: 'Media was saved as a local tool asset and rendered in the UI. Binary bytes are not included in model context.',
      nextStep: 'Do not call browser_action, shell_command, write_file, or read_file to display this media again; summarize briefly to the user.',
    };
  }
  if (typeof value === 'string') {
    if (/^data:image\/[^;]+;base64,/i.test(value) || value.length > LARGE_TEXT_LIMIT) {
      return `[large content omitted: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeToolOutputValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(contentBase64|base64|dataUrl|dataURL)$/i.test(key)) {
        out[key] = '[binary content omitted]';
      } else {
        out[key] = sanitizeToolOutputValue(item);
      }
    }
    return out;
  }
  return value;
}

export function formatToolOutput(output) {
  const sanitized = sanitizeToolOutputValue(output);
  return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
}

const identity = (result) => result;
const passThrough = (_input, output) => output;
const noop = () => {};

function logContextFrom(context) {
  const keys = [
    'source',
    'environment',
    'conversationId',
    'channelId',
    'model',
    'agentRunId',
    'rootRunId',
    'parentRunId',
    'agentDepth',
    'expertAgentId',
    'expertAgentTitle',
    'toolCallId',
  ];
  const out = {};
  for (const key of keys) {
    if (context[key] !== undefined) out[key] = context[key];
  }
  return out;
}

function shouldPersistToolRun(context) {
  return context.persistToolRun !== false;
}

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
  const callContext = { ...runtimeContext, toolCallId: call.id };
  const logContext = logContextFrom(callContext);
  const persistRun = shouldPersistToolRun(callContext);

  if (runtime?.unavailable) {
    const result = {
      id: call.id,
      name: call.name,
      isError: true,
      output: `Tool failed to load: ${runtime.tool.loadError || call.name}`,
      durationMs: Date.now() - startedAt,
    };
    if (persistRun) {
      await appendToolRun({ ...result, input: call.input || {}, context: logContext }).catch(() => {});
    }
    return result;
  }

  if (!runtime) {
    const result = {
      id: call.id,
      name: call.name,
      isError: true,
      output: `Unknown or disabled tool: ${call.name}`,
      durationMs: Date.now() - startedAt,
    };
    if (persistRun) {
      await appendToolRun({ ...result, input: call.input || {}, context: logContext }).catch(() => {});
    }
    return result;
  }

  const { tool, config } = runtime;
  const timeoutMs = config.timeoutMs || tool.timeoutMs || 10000;
  const input = call.input || {};
  const hookCtx = {
    config: config.config || {},
    context: callContext,
    signal,
    emit: typeof context.emitToolEvent === 'function' ? context.emitToolEvent : null,
  };

  const validate = tool.validate || noop;
  const before = tool.before || identity;
  const after = tool.after || passThrough;
  const onError = tool.onError || null;

  let output, isError;
  let error;
  let handlerInput;

  try {
    if (signal?.aborted) throw new Error(abortMessage(signal));

    await validate(input, hookCtx);

    const beforeResult = await before(input, hookCtx);
    handlerInput = input;

    if (beforeResult && beforeResult.skipHandler) {
      output = beforeResult.result;
    } else {
      if (beforeResult !== undefined) handlerInput = beforeResult;
      const timeout = createTimeout(timeoutMs, tool.name);
      try {
        output = await Promise.race([
          tool.handler(handlerInput, hookCtx),
          timeout.promise,
          abortAfter(signal),
        ].filter(Boolean));
      } finally {
        timeout.clear();
      }
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

  if (persistRun) {
    const record = typeof tool.scrubRunRecord === 'function'
      ? tool.scrubRunRecord({ ...result, input, context: logContext })
      : { ...result, input, context: logContext };
    await appendToolRun(record).catch(() => {});
  }
  return result;
}
