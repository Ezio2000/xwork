import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createSqliteDocumentStore } from '../sqlite-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = join(__dirname, '..', '..', 'data', 'agent-runs.json');
const MAX_RUNS = 200;
const MAX_EVENTS_PER_RUN = 120;

const runsStore = createSqliteDocumentStore({
  key: 'agent-runs',
  legacyFilePath: RUNS_PATH,
  defaultValue: { runs: [] },
  normalize: data => ({ runs: Array.isArray(data?.runs) ? data.runs : [] }),
  serialize: data => ({ runs: Array.isArray(data?.runs) ? data.runs.slice(0, MAX_RUNS) : [] }),
});

async function readRuns() {
  const data = await runsStore.read();
  return data.runs;
}

function updateRuns(mutator) {
  return runsStore.update(async (data) => {
    const result = await mutator(data.runs);
    data.runs = data.runs.slice(0, MAX_RUNS);
    return result;
  });
}

function queueRunUpdate(mutator) {
  return runsStore.update(async (data) => {
    await mutator(data.runs);
    data.runs = data.runs.slice(0, MAX_RUNS);
  });
}

export async function createAgentRun({
  runId: requestedRunId = null,
  role = 'subagent',
  parentRunId = null,
  rootRunId = null,
  conversationId = null,
  channelId = null,
  model = null,
  task = '',
  label = '',
  depth = 0,
  parentToolCallId = null,
  source = 'runtime',
  environment = process.env.NODE_ENV || 'development',
}) {
  const now = new Date().toISOString();
  const runId = requestedRunId || randomUUID();
  const run = {
    runId,
    role,
    status: 'running',
    parentRunId,
    rootRunId: rootRunId || (role === 'root' ? runId : parentRunId || runId),
    conversationId,
    channelId,
    model,
    source,
    environment,
    task,
    label: label || task.slice(0, 80),
    depth,
    parentToolCallId,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    durationMs: null,
    result: null,
    error: null,
    events: [],
  };

  queueRunUpdate((runs) => {
    runs.unshift(run);
  }).catch(() => {});

  return run;
}

export async function appendAgentRunEvent(runId, event) {
  const storedEvent = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...event,
  };

  await updateRuns((runs) => {
    const run = runs.find(item => item.runId === runId);
    if (!run) return null;
    run.events = Array.isArray(run.events) ? run.events : [];
    run.events.push(storedEvent);
    if (run.events.length > MAX_EVENTS_PER_RUN) {
      run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
    }
    run.updatedAt = storedEvent.createdAt;
    return storedEvent;
  });

  return storedEvent;
}

export async function completeAgentRun(runId, { status = 'completed', result = null, error = null } = {}) {
  const completedAt = new Date().toISOString();
  return updateRuns((runs) => {
    const run = runs.find(item => item.runId === runId);
    if (!run) return null;
    run.status = status;
    run.result = result;
    run.error = error;
    run.completedAt = completedAt;
    run.updatedAt = completedAt;
    run.durationMs = Math.max(0, new Date(completedAt) - new Date(run.startedAt));
    return run;
  });
}

export async function getAgentRunsByIds(runIds = []) {
  const ids = new Set(runIds.filter(Boolean));
  if (!ids.size) return [];
  const runs = await readRuns();
  return runs.filter(run => ids.has(run.runId));
}

function isTestAgentRun(run) {
  return run.source === 'test'
    || run.environment === 'test'
    || run.conversationId === 'test'
    || run.conversationId === 'conv1';
}

export async function listAgentRuns({ limit = 50, conversationId, parentRunId, source, environment, includeTest = false } = {}) {
  const runs = await readRuns();
  return runs
    .filter(run => includeTest || !isTestAgentRun(run))
    .filter(run => !conversationId || run.conversationId === conversationId)
    .filter(run => parentRunId === undefined || run.parentRunId === parentRunId)
    .filter(run => !source || run.source === source)
    .filter(run => !environment || run.environment === environment)
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), MAX_RUNS));
}

export async function getAgentRun(runId) {
  const runs = await readRuns();
  return runs.find(run => run.runId === runId) || null;
}
