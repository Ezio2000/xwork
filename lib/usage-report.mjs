import { listAgentRuns } from './agents/runs.mjs';
import { readConfig } from './config-store.mjs';
import { calculateUsageCost, findEffectiveModelPricing } from './model-pricing.mjs';
import { getBasePricingEntries } from './pricing-store.mjs';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function usageFromRun(run) {
  return run?.result?.usage || run?.usage || null;
}

function metricsFromUsage(usage) {
  const inputTokens = num(usage?.input_tokens);
  const cacheReadInputTokens = num(usage?.cache_read_input_tokens);
  const cacheCreationInputTokens = num(usage?.cache_creation_input_tokens);
  const outputTokens = num(usage?.output_tokens);
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalInputTokens,
    uncachedInputTokens: inputTokens + cacheCreationInputTokens,
    cacheHitRatio: totalInputTokens > 0 ? cacheReadInputTokens / totalInputTokens : null,
    webSearchRequests: num(usage?.server_tool_use?.web_search_requests),
  };
}

function toolCounts(run) {
  const counts = {
    localToolCalls: 0,
    serverToolCalls: 0,
    toolResults: 0,
  };

  for (const event of run?.events || []) {
    const type = event.type || event.eventType || event.event;
    if (type === 'tool_call' || type === 'subagent_tool_call') counts.localToolCalls++;
    if (type === 'server_tool_call') counts.serverToolCalls++;
    if (type === 'subagent_server_tool' && event.event?.phase === 'call') counts.serverToolCalls++;
    if (type === 'tool_result' || type === 'subagent_tool_result' || type === 'server_tool_result') counts.toolResults++;
    if (type === 'subagent_server_tool' && event.event?.phase === 'result') counts.toolResults++;
  }

  return {
    ...counts,
    totalToolCalls: counts.localToolCalls + counts.serverToolCalls,
  };
}

function emptyGroup(key) {
  return {
    key: key || 'unknown',
    requestCount: 0,
    completedCount: 0,
    errorCount: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalInputTokens: 0,
    uncachedInputTokens: 0,
    durationMsTotal: 0,
    durationCount: 0,
    cacheRatioTotal: 0,
    cacheRatioCount: 0,
    webSearchRequests: 0,
    toolCalls: 0,
    subagentCount: 0,
    cost: emptyCostSummary(),
  };
}

function emptyCostSummary() {
  return {
    totalCost: 0,
    inputCost: 0,
    cacheReadInputCost: 0,
    cacheCreationInputCost: 0,
    outputCost: 0,
    webSearchCost: 0,
    currency: null,
    estimatedCount: 0,
    partialCount: 0,
    missingCount: 0,
    unpricedRunCount: 0,
    missingFields: [],
    pricingSources: {},
  };
}

function addOptionalCost(cost, field, value) {
  if (Number.isFinite(Number(value))) cost[field] += Number(value);
}

function addCostSummary(target, itemCost) {
  if (!itemCost) return;
  if (itemCost.currency && !target.currency) target.currency = itemCost.currency;
  addOptionalCost(target, 'totalCost', itemCost.totalCost);
  addOptionalCost(target, 'inputCost', itemCost.inputCost);
  addOptionalCost(target, 'cacheReadInputCost', itemCost.cacheReadInputCost);
  addOptionalCost(target, 'cacheCreationInputCost', itemCost.cacheCreationInputCost);
  addOptionalCost(target, 'outputCost', itemCost.outputCost);
  addOptionalCost(target, 'webSearchCost', itemCost.webSearchCost);

  if (itemCost.pricingStatus === 'estimated') target.estimatedCount++;
  if (itemCost.pricingStatus === 'partial') target.partialCount++;
  if (itemCost.pricingStatus === 'missing') target.missingCount++;
  if (itemCost.pricingStatus === 'partial' || itemCost.pricingStatus === 'missing') target.unpricedRunCount++;

  if (itemCost.pricingStatus === 'not_applicable') return;

  for (const field of itemCost.missingFields || []) {
    if (!target.missingFields.includes(field)) target.missingFields.push(field);
  }
  const source = itemCost.pricingSource || 'missing';
  target.pricingSources[source] = (target.pricingSources[source] || 0) + 1;
}

function addToGroup(group, item) {
  group.requestCount++;
  if (item.status === 'completed') group.completedCount++;
  if (item.status === 'error' || item.status === 'api_error') group.errorCount++;
  group.inputTokens += item.metrics.inputTokens;
  group.cacheReadInputTokens += item.metrics.cacheReadInputTokens;
  group.cacheCreationInputTokens += item.metrics.cacheCreationInputTokens;
  group.outputTokens += item.metrics.outputTokens;
  group.totalInputTokens += item.metrics.totalInputTokens;
  group.uncachedInputTokens += item.metrics.uncachedInputTokens;
  group.webSearchRequests += item.metrics.webSearchRequests;
  group.toolCalls += item.toolCounts.totalToolCalls;
  group.subagentCount += item.subagentCount;
  addCostSummary(group.cost, item.cost);

  if (Number.isFinite(item.durationMs)) {
    group.durationMsTotal += item.durationMs;
    group.durationCount++;
  }
  if (item.metrics.cacheHitRatio !== null) {
    group.cacheRatioTotal += item.metrics.cacheHitRatio;
    group.cacheRatioCount++;
  }
}

function finishGroup(group) {
  return {
    ...group,
    weightedCacheHitRatio: group.totalInputTokens > 0 ? group.cacheReadInputTokens / group.totalInputTokens : null,
    averageCacheHitRatio: group.cacheRatioCount > 0 ? group.cacheRatioTotal / group.cacheRatioCount : null,
    averageDurationMs: group.durationCount > 0 ? group.durationMsTotal / group.durationCount : null,
  };
}

function emptyTask(rootRun) {
  return {
    taskId: rootRun.runId,
    rootRunId: rootRun.runId,
    conversationId: rootRun.conversationId || null,
    label: rootRun.label || rootRun.task || rootRun.runId,
    task: rootRun.task || '',
    status: rootRun.status || 'unknown',
    model: rootRun.model || 'unknown',
    startedAt: rootRun.startedAt || null,
    completedAt: rootRun.completedAt || null,
    durationMs: rootRun.durationMs,
    runCount: 0,
    subagentCount: 0,
    childRunCount: 0,
    metrics: {
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      totalInputTokens: 0,
      uncachedInputTokens: 0,
      cacheHitRatio: null,
      webSearchRequests: 0,
    },
    toolCounts: {
      localToolCalls: 0,
      serverToolCalls: 0,
      toolResults: 0,
      totalToolCalls: 0,
    },
    cost: emptyCostSummary(),
    runs: [],
  };
}

function addRunToTask(task, run) {
  task.runCount++;
  if (run.runId !== task.rootRunId) task.childRunCount++;
  task.metrics.inputTokens += run.metrics.inputTokens;
  task.metrics.cacheReadInputTokens += run.metrics.cacheReadInputTokens;
  task.metrics.cacheCreationInputTokens += run.metrics.cacheCreationInputTokens;
  task.metrics.outputTokens += run.metrics.outputTokens;
  task.metrics.totalInputTokens += run.metrics.totalInputTokens;
  task.metrics.uncachedInputTokens += run.metrics.uncachedInputTokens;
  task.metrics.webSearchRequests += run.metrics.webSearchRequests;
  task.toolCounts.localToolCalls += run.toolCounts.localToolCalls;
  task.toolCounts.serverToolCalls += run.toolCounts.serverToolCalls;
  task.toolCounts.toolResults += run.toolCounts.toolResults;
  task.toolCounts.totalToolCalls += run.toolCounts.totalToolCalls;
  addCostSummary(task.cost, run.cost);
  task.runs.push(run);
}

function finishTask(task) {
  task.subagentCount = task.runs.filter(run => run.role === 'subagent').length;
  task.metrics.cacheHitRatio = task.metrics.totalInputTokens > 0
    ? task.metrics.cacheReadInputTokens / task.metrics.totalInputTokens
    : null;
  task.runs.sort((a, b) => {
    if (a.runId === task.rootRunId) return -1;
    if (b.runId === task.rootRunId) return 1;
    return new Date(a.startedAt || 0) - new Date(b.startedAt || 0);
  });
  return task;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item) || 'unknown';
    const group = groups.get(key) || emptyGroup(key);
    addToGroup(group, item);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map(finishGroup);
}

function buildTaskGroups(items) {
  const byRunId = new Map(items.map(item => [item.runId, item]));
  const rootItems = items.filter(item => item.role === 'root' || !item.parentRunId);
  const tasks = new Map(rootItems.map(root => [root.runId, emptyTask(root)]));

  for (const item of items) {
    const root = byRunId.get(item.rootRunId) || (item.role === 'root' ? item : null);
    if (!root) continue;
    const task = tasks.get(root.runId) || emptyTask(root);
    addRunToTask(task, item);
    tasks.set(root.runId, task);
  }

  return Array.from(tasks.values())
    .map(finishTask)
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
}

export function summarizeRunsForUsage(runs = [], { channels = [], basePricing = [] } = {}) {
  const childCountByParent = new Map();
  const channelsById = new Map((channels || []).map(channel => [channel.id, channel]));
  for (const run of runs) {
    if (!run?.parentRunId) continue;
    childCountByParent.set(run.parentRunId, (childCountByParent.get(run.parentRunId) || 0) + 1);
  }

  const items = runs.map(run => {
    const usage = usageFromRun(run);
    const metrics = metricsFromUsage(usage);
    const counts = toolCounts(run);
    const channel = channelsById.get(run.channelId) || null;
    const effectivePricing = findEffectiveModelPricing({ channel, model: run.model, basePricing });
    const cost = calculateUsageCost(usage, effectivePricing);
    return {
      runId: run.runId,
      role: run.role || 'unknown',
      status: run.status || 'unknown',
      label: run.label || run.task || '',
      task: run.task || '',
      model: run.model || 'unknown',
      conversationId: run.conversationId || null,
      parentRunId: run.parentRunId || null,
      rootRunId: run.rootRunId || null,
      depth: num(run.depth),
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
      durationMs: run.durationMs,
      usage,
      metrics,
      cost,
      toolCounts: counts,
      subagentCount: childCountByParent.get(run.runId) || 0,
    };
  });

  const summary = finishGroup(items.reduce((group, item) => {
    addToGroup(group, item);
    return group;
  }, emptyGroup('all')));

  return {
    generatedAt: new Date().toISOString(),
    summary,
    groups: {
      byRole: groupBy(items, item => item.role),
      byModel: groupBy(items, item => item.model),
      byStatus: groupBy(items, item => item.status),
    },
    tasks: buildTaskGroups(items),
    runs: items,
  };
}

export async function buildUsageReport({ limit = 100, includeTest = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const runs = await listAgentRuns({ limit: safeLimit, includeTest });
  const cfg = await readConfig();
  const basePricing = await getBasePricingEntries();
  return {
    limit: safeLimit,
    ...summarizeRunsForUsage(runs, { channels: cfg.channels, basePricing }),
  };
}
