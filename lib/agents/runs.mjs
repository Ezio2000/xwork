import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = join(__dirname, '..', '..', 'data', 'agent-runs.json');
const MAX_RUNS = 200;
const MAX_EVENTS_PER_RUN = 120;
let writeQueue = Promise.resolve();

async function ensureRunsFile() {
  const dir = dirname(RUNS_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  if (!existsSync(RUNS_PATH)) {
    await writeFile(RUNS_PATH, JSON.stringify({ runs: [] }, null, 2));
  }
}

async function readRuns() {
  await ensureRunsFile();
  try {
    const data = JSON.parse(await readFile(RUNS_PATH, 'utf-8'));
    return Array.isArray(data.runs) ? data.runs : [];
  } catch {
    return [];
  }
}

async function writeRuns(runs) {
  await ensureRunsFile();
  await writeFile(RUNS_PATH, JSON.stringify({ runs: runs.slice(0, MAX_RUNS) }, null, 2));
}

function updateRuns(mutator) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const runs = await readRuns();
    const result = await mutator(runs);
    await writeRuns(runs);
    return result;
  });
  return writeQueue;
}

export async function createAgentRun({
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
}) {
  const now = new Date().toISOString();
  const run = {
    runId: randomUUID(),
    role,
    status: 'running',
    parentRunId,
    rootRunId,
    conversationId,
    channelId,
    model,
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

  await updateRuns((runs) => {
    runs.unshift(run);
    return run;
  });

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

export async function listAgentRuns({ limit = 50, conversationId, parentRunId } = {}) {
  const runs = await readRuns();
  return runs
    .filter(run => !conversationId || run.conversationId === conversationId)
    .filter(run => parentRunId === undefined || run.parentRunId === parentRunId)
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), MAX_RUNS));
}

export async function getAgentRun(runId) {
  const runs = await readRuns();
  return runs.find(run => run.runId === runId) || null;
}
