import { escHtml, formatDateTime } from './renderers.js';

export function fmtNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function fmtPercent(value) {
  return value === null || value === undefined ? '-' : `${Math.round(Number(value) * 1000) / 10}%`;
}

export function fmtDuration(value) {
  if (value === null || value === undefined) return '-';
  const n = Number(value || 0);
  return n >= 1000 ? `${Math.round(n / 100) / 10}s` : `${Math.round(n)}ms`;
}

export function fmtDate(value) {
  return formatDateTime(value) || '-';
}

export function fmtCost(cost = {}) {
  if (cost.totalCost === null || cost.totalCost === undefined) return 'Missing';
  const currency = cost.currency || 'USD';
  return `${currency} ${Number(cost.totalCost || 0).toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  })}`;
}

function metricCard(label, value, hint = '') {
  return `
    <div class="usage-metric">
      <div class="usage-metric-label">${escHtml(label)}</div>
      <div class="usage-metric-value">${escHtml(value)}</div>
      ${hint ? `<div class="usage-metric-hint">${escHtml(hint)}</div>` : ''}
    </div>
  `;
}

function usageBar(ratio) {
  const pct = Math.max(0, Math.min(100, Number(ratio || 0) * 100));
  const hue = Math.round((pct / 100) * 120);
  return `
    <div class="usage-cache-bar">
      <span style="width:${pct}%;background-color:hsl(${hue} 65% 42%)"></span>
    </div>
  `;
}

function metricBadges(metrics = {}, extras = {}) {
  return [
    `${fmtNumber(metrics.totalInputTokens)} in`,
    `${fmtNumber(metrics.cacheReadInputTokens)} cached`,
    `${fmtNumber(metrics.uncachedInputTokens)} uncached`,
    `${fmtNumber(metrics.outputTokens)} out`,
    `${fmtNumber(metrics.webSearchRequests)} web`,
    extras.cost ? `cost ${fmtCost(extras.cost)}` : '',
    extras.toolCalls !== undefined ? `${fmtNumber(extras.toolCalls)} tools` : '',
    extras.subagents ? `${fmtNumber(extras.subagents)} subagents` : '',
  ].filter(Boolean).map(item => `<span>${escHtml(item)}</span>`).join('');
}

function renderUsageRunLine(run) {
  return `
    <div class="usage-run-line" data-run-id="${escHtml(run.runId)}">
      <div class="usage-run-line-main">
        <div class="usage-run-title">
          <span class="usage-role ${escHtml(run.role)}">${escHtml(run.role)}</span>
          <span>${escHtml(run.label || run.task || run.runId)}</span>
        </div>
        <div class="usage-run-cache">${fmtPercent(run.metrics?.cacheHitRatio)}</div>
      </div>
      <div class="usage-run-meta">
        <span>${escHtml(run.model || 'unknown')}</span>
        <span>${fmtDuration(run.durationMs)}</span>
        ${metricBadges(run.metrics, { toolCalls: run.toolCounts?.totalToolCalls, cost: run.cost })}
      </div>
      ${usageBar(run.metrics?.cacheHitRatio)}
    </div>
  `;
}

function renderUsageTask(task, index) {
  const metrics = task.metrics || {};
  const expanded = Boolean(task.expanded);
  return `
    <div class="usage-task${expanded ? ' expanded' : ''}" data-task-index="${index}">
      <div class="usage-task-summary" data-action="toggle-usage-task">
        <div class="usage-run-main">
          <div class="usage-run-title">
            <span class="usage-task-arrow">${expanded ? '▾' : '▸'}</span>
            <span class="usage-role root">task</span>
            <span>${escHtml(task.label || task.task || task.rootRunId)}</span>
          </div>
          <div class="usage-run-cache">${fmtPercent(metrics.cacheHitRatio)}</div>
        </div>
        <div class="usage-run-meta">
          <span>${escHtml(task.model || 'unknown')}</span>
          <span>${fmtDate(task.startedAt)}</span>
          <span>${fmtDuration(task.durationMs)}</span>
          <span>${fmtNumber(task.runCount)} runs</span>
          ${metricBadges(metrics, {
            toolCalls: task.toolCounts?.totalToolCalls,
            subagents: task.subagentCount,
            cost: task.cost,
          })}
        </div>
        ${usageBar(metrics.cacheHitRatio)}
      </div>
      ${expanded ? `
        <div class="usage-task-detail">
          ${(task.runs || []).map(renderUsageRunLine).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderUsageGroup(title, rows = []) {
  if (!rows.length) return '';
  return `
    <div class="usage-group-card">
      <h3>${escHtml(title)}</h3>
      <div class="usage-group-table">
        ${rows.map(row => `
          <div class="usage-group-row">
            <span class="usage-group-key">${escHtml(row.key)}</span>
            <span>${fmtNumber(row.requestCount)} req</span>
            <span>${fmtCost(row.cost)}</span>
            <span>${fmtPercent(row.weightedCacheHitRatio)}</span>
            <span>${fmtDuration(row.averageDurationMs)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

export function buildUsageReportView(report) {
  if (!report) {
    return {
      summaryHtml: '<div class="empty-panel">No usage data loaded.</div>',
      groupsHtml: '',
      runListHtml: '',
      generatedAtText: '',
    };
  }

  const s = report.summary || {};
  const tasks = report.tasks || [];
  return {
    summaryHtml: [
      metricCard('Tasks', fmtNumber(tasks.length), `${fmtNumber(s.requestCount)} runs`),
      metricCard('Cache Hit', fmtPercent(s.weightedCacheHitRatio), `${fmtNumber(s.cacheReadInputTokens)} cached tokens`),
      metricCard('Input', fmtNumber(s.totalInputTokens), `${fmtNumber(s.uncachedInputTokens)} uncached`),
      metricCard('Output', fmtNumber(s.outputTokens), 'generated tokens'),
      metricCard('Cost', fmtCost(s.cost), `${fmtNumber(s.cost?.unpricedRunCount)} partial/missing`),
      metricCard('Latency', fmtDuration(s.averageDurationMs), 'average duration'),
      metricCard('Web Search', fmtNumber(s.webSearchRequests), 'requests'),
    ].join(''),
    groupsHtml: [
      renderUsageGroup('By Role', report.groups?.byRole || []),
      renderUsageGroup('By Model', report.groups?.byModel || []),
      renderUsageGroup('By Status', report.groups?.byStatus || []),
    ].join(''),
    runListHtml: tasks.length
      ? tasks.map(renderUsageTask).join('')
      : '<div class="empty-panel">No agent tasks found.</div>',
    generatedAtText: `Generated ${fmtDate(report.generatedAt)}`,
  };
}

export function buildUsageRunDetailView(run) {
  if (!run) return null;
  const parts = [];
  parts.push(`
    <div class="detail-section">
      <div class="detail-meta-grid">
        <div class="detail-meta-item"><div class="dm-label">Role</div><div class="dm-value">${escHtml(run.role)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Status</div><div class="dm-value">${escHtml(run.status)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Cache Hit</div><div class="dm-value">${fmtPercent(run.metrics?.cacheHitRatio)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Cost</div><div class="dm-value">${escHtml(fmtCost(run.cost))}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Duration</div><div class="dm-value">${fmtDuration(run.durationMs)}</div></div>
      </div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Cost</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.cost || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Token Metrics</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.metrics || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Tool Counts</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify({ ...(run.toolCounts || {}), subagentCount: run.subagentCount }, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Raw Usage</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.usage || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Run</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify({
        runId: run.runId,
        rootRunId: run.rootRunId,
        parentRunId: run.parentRunId,
        conversationId: run.conversationId,
        model: run.model,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        task: run.task,
      }, null, 2))}</pre></div>
    </div>
  `);

  return {
    title: run.label || run.task || run.runId,
    bodyHtml: parts.join(''),
  };
}
