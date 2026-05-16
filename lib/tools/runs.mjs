import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = join(__dirname, '..', '..', 'data', 'tool-runs.json');
const MAX_RUNS = 200;
let writeQueue = Promise.resolve();

async function readRuns() {
  if (!existsSync(RUNS_PATH)) return [];
  try {
    const data = JSON.parse(await readFile(RUNS_PATH, 'utf-8'));
    return Array.isArray(data.runs) ? data.runs : [];
  } catch {
    return [];
  }
}

async function writeRuns(runs) {
  const dir = dirname(RUNS_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(RUNS_PATH, JSON.stringify({ runs }, null, 2));
}

export async function appendToolRun(run) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const runs = await readRuns();
    const nextRun = {
      runId: randomUUID(),
      toolCallId: run.id,
      name: run.name,
      isError: run.isError,
      input: run.input,
      output: run.output,
      durationMs: run.durationMs,
      context: run.context || {},
      source: run.source || run.context?.source || 'runtime',
      environment: run.environment || run.context?.environment || process.env.NODE_ENV || 'development',
      createdAt: new Date().toISOString(),
    };
    runs.unshift(nextRun);
    await writeRuns(runs.slice(0, MAX_RUNS));
  });
  await writeQueue;
}

function isTestToolRun(run) {
  return run.source === 'test'
    || run.environment === 'test'
    || run.context?.source === 'test'
    || run.context?.environment === 'test'
    || run.context?.conversationId === 'test';
}

export async function listToolRuns({ limit = 50, source, environment, includeTest = false } = {}) {
  const runs = await readRuns();
  return runs
    .filter(run => includeTest || !isTestToolRun(run))
    .filter(run => !source || run.source === source || run.context?.source === source)
    .filter(run => !environment || run.environment === environment || run.context?.environment === environment)
    .slice(0, limit);
}
