import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.marked = { setOptions() {}, parse(value) { return String(value); } };
globalThis.katex = { renderToString(value) { return String(value); } };

const { buildUsageReportView, buildUsageRunDetailView, fmtCost, fmtDuration, fmtPercent } = await import('../public/js/usage-view.js');

describe('usage view rendering', () => {
  it('formats usage display values', () => {
    assert.equal(fmtPercent(0.1234), '12.3%');
    assert.equal(fmtPercent(null), '-');
    assert.equal(fmtDuration(1234), '1.2s');
    assert.equal(fmtDuration(42), '42ms');
    assert.equal(fmtCost({ currency: 'USD', totalCost: 1.2345678 }), 'USD 1.234568');
  });

  it('builds empty usage report view state', () => {
    const view = buildUsageReportView(null);
    assert.match(view.summaryHtml, /No usage data loaded/);
    assert.equal(view.groupsHtml, '');
    assert.equal(view.runListHtml, '');
    assert.equal(view.generatedAtText, '');
  });

  it('builds report summary, groups, and task rows', () => {
    const view = buildUsageReportView({
      generatedAt: '2026-05-18T00:00:00.000Z',
      summary: {
        requestCount: 2,
        weightedCacheHitRatio: 0.5,
        cacheReadInputTokens: 100,
        totalInputTokens: 200,
        uncachedInputTokens: 100,
        outputTokens: 50,
        averageDurationMs: 1500,
        webSearchRequests: 1,
        cost: { currency: 'USD', totalCost: 0.25, unpricedRunCount: 0 },
      },
      groups: {
        byRole: [{ key: 'root', requestCount: 1, cost: { currency: 'USD', totalCost: 0.1 }, weightedCacheHitRatio: 0.5, averageDurationMs: 1000 }],
        byModel: [],
        byStatus: [],
      },
      tasks: [{
        label: 'Root task',
        model: 'model-a',
        runCount: 1,
        durationMs: 1000,
        metrics: { cacheHitRatio: 0.5, totalInputTokens: 200, cacheReadInputTokens: 100, uncachedInputTokens: 100, outputTokens: 50, webSearchRequests: 1 },
        toolCounts: { totalToolCalls: 2 },
        cost: { currency: 'USD', totalCost: 0.25 },
        runs: [],
      }],
    });

    assert.match(view.summaryHtml, /Cache Hit/);
    assert.match(view.groupsHtml, /By Role/);
    assert.match(view.runListHtml, /Root task/);
    assert.match(view.generatedAtText, /Generated/);
  });

  it('builds usage run detail content', () => {
    const view = buildUsageRunDetailView({
      runId: 'run1',
      rootRunId: 'root1',
      parentRunId: null,
      conversationId: 'conv1',
      role: 'root',
      status: 'completed',
      label: 'Root task',
      model: 'model-a',
      durationMs: 100,
      startedAt: '2026-05-18T00:00:00.000Z',
      completedAt: '2026-05-18T00:00:01.000Z',
      task: 'Do work',
      metrics: { cacheHitRatio: 0.25 },
      cost: { currency: 'USD', totalCost: 0.5 },
      toolCounts: { totalToolCalls: 1 },
      usage: { input_tokens: 10 },
      subagentCount: 0,
    });

    assert.equal(view.title, 'Root task');
    assert.match(view.bodyHtml, /Token Metrics/);
    assert.match(view.bodyHtml, /run1/);
  });
});
