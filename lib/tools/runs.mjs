import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createSqliteDocumentStore } from '../sqlite-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = join(__dirname, '..', '..', 'data', 'tool-runs.json');
const MAX_RUNS = 200;

const runsStore = createSqliteDocumentStore({
  key: 'tool-runs',
  legacyFilePath: RUNS_PATH,
  defaultValue: { runs: [] },
  normalize: data => ({ runs: Array.isArray(data?.runs) ? data.runs : [] }),
  serialize: data => ({ runs: Array.isArray(data?.runs) ? data.runs.slice(0, MAX_RUNS) : [] }),
});

async function readRuns() {
  const data = await runsStore.read();
  return data.runs;
}

export async function appendToolRun(run) {
  await runsStore.update((data) => {
    const runs = data.runs;
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
    data.runs = runs.slice(0, MAX_RUNS);
  });
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
