import { appendToolRun } from './runs.mjs';
import { getToolRuntime } from './registry.mjs';

function timeoutAfter(ms, name) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms: ${name}`)), ms);
  });
}

export function formatToolOutput(output) {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

export async function runTool(call, context = {}) {
  const startedAt = Date.now();
  const runtime = await getToolRuntime(call.name);

  if (!runtime) {
    const result = {
      id: call.id,
      name: call.name,
      isError: true,
      output: `Unknown or disabled tool: ${call.name}`,
      durationMs: Date.now() - startedAt,
    };
    await appendToolRun({ ...result, input: call.input || {}, context }).catch(() => {});
    return result;
  }

  const { tool, config } = runtime;
  const timeoutMs = config.timeoutMs || tool.timeoutMs || 10000;

  try {
    const output = await Promise.race([
      tool.handler(call.input || {}, { config: config.config || {}, context }),
      timeoutAfter(timeoutMs, tool.name),
    ]);
    const result = {
      id: call.id,
      name: call.name,
      isError: false,
      output,
      durationMs: Date.now() - startedAt,
    };
    await appendToolRun({ ...result, input: call.input || {}, context }).catch(() => {});
    return result;
  } catch (err) {
    const result = {
      id: call.id,
      name: call.name,
      isError: true,
      output: err.message || String(err),
      durationMs: Date.now() - startedAt,
    };
    await appendToolRun({ ...result, input: call.input || {}, context }).catch(() => {});
    return result;
  }
}
