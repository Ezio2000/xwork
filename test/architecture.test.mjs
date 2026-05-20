import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { streamChat } from '../lib/api.mjs';
import { buildAuditTrace } from '../lib/audit-trace.mjs';
import { assistantMessage } from '../lib/anthropic/assistant-message.mjs';
import { CHAT_SERVICE_TEST_HOOKS, getChatRunSnapshot, handleChatRequest, handleChatRunStream } from '../lib/chat-service.mjs';
import { appendAgentRunBlocks } from '../lib/message-rendering.mjs';
import { SchemaValidationError, validateChannelPayload, validateChatRequest, validateToolConfigPatch } from '../lib/schema.mjs';
import { withConversationQueue } from '../lib/storage.mjs';
import { summarizeRunsForUsage } from '../lib/usage-report.mjs';
import { calculateUsageCost, findEffectiveModelPricing } from '../lib/model-pricing.mjs';

describe('architecture safety contracts', () => {
  it('serializes work for the same conversation id', async () => {
    const events = [];
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const first = withConversationQueue('queue-test', async () => {
      events.push('first:start');
      await wait(20);
      events.push('first:end');
    });

    const second = withConversationQueue('queue-test', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    assert.deepEqual(events, [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('rejects unsafe chat request ids and empty messages', () => {
    assert.throws(
      () => validateChatRequest({ conversationId: '../data/config', message: 'hi' }),
      SchemaValidationError,
    );
    assert.throws(
      () => validateChatRequest({ message: '   ' }),
      SchemaValidationError,
    );
  });

  it('accepts an optional safe client chat run id', () => {
    assert.equal(validateChatRequest({ runId: 'run_123', message: 'hi' }).runId, 'run_123');
    assert.throws(
      () => validateChatRequest({ runId: '../bad', message: 'hi' }),
      SchemaValidationError,
    );
  });

  it('keeps a background chat run alive after the SSE client closes', async () => {
    const originalStreamChat = CHAT_SERVICE_TEST_HOOKS.streamChat;
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let sawAbortedSignal = false;

    CHAT_SERVICE_TEST_HOOKS.streamChat = async (_config, _messages, onDelta, _onThinking, onDone, _onError, _onServerTool, { signal } = {}) => {
      await wait(20);
      sawAbortedSignal = signal?.aborted === true;
      onDelta('done');
      onDone('done', 'end_turn', null);
      return {
        text: 'done',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: null,
        toolCalls: [],
        serverToolEvents: [],
      };
    };

    const req = {
      body: {
        runId: 'run_bg_disconnect',
        message: 'hi',
      },
    };
    const writes = [];
    const closeHandlers = [];
    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      write(chunk) {
        writes.push(chunk);
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      on(event, handler) {
        if (event === 'close') closeHandlers.push(handler);
      },
    };

    try {
      await handleChatRequest(req, res);
      assert.equal(res.status, 200);
      res.destroyed = true;
      for (const handler of closeHandlers) handler();

      await wait(80);
      const snapshot = getChatRunSnapshot('run_bg_disconnect');
      assert.equal(snapshot.status, 'completed');
      assert.equal(sawAbortedSignal, false);
      assert.ok(writes.some(chunk => String(chunk).includes('chat_run_start')));
    } finally {
      CHAT_SERVICE_TEST_HOOKS.streamChat = originalStreamChat;
    }
  });

  it('replays chat run events from the requested sequence', async () => {
    const writes = [];
    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      write(chunk) {
        writes.push(String(chunk));
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      on() {},
    };

    handleChatRunStream({
      params: { id: 'run_bg_disconnect' },
      query: { afterSeq: '1' },
    }, res);

    assert.equal(res.status, 200);
    assert.ok(res.writableEnded);
    assert.ok(writes.some(chunk => chunk.includes('"type":"delta"')));
    assert.ok(writes.some(chunk => chunk.includes('"type":"done"')));
    assert.ok(!writes.some(chunk => chunk.includes('"type":"chat_run_start"')));
  });

  it('validates tool config patches', () => {
    assert.deepEqual(validateToolConfigPatch({ enabled: 1, timeoutMs: 3000 }), {
      enabled: true,
      timeoutMs: 3000,
    });
    assert.throws(
      () => validateToolConfigPatch({ timeoutMs: -1 }),
      SchemaValidationError,
    );
  });

  it('validates configurable channel max turns', () => {
    const channel = validateChannelPayload({
      name: 'Test',
      baseUrl: 'https://example.test/anthropic',
      apiKey: 'sk-test',
      models: ['m'],
      maxTokens: 1024,
      maxTurns: 12,
      extraHeaders: {},
      pricing: { models: {} },
    });

    assert.equal(channel.maxTurns, 12);
    assert.equal(validateChannelPayload({
      name: 'Default',
      baseUrl: 'https://example.test/anthropic',
      models: [],
      maxTokens: 1024,
    }).maxTurns, 5);
    assert.throws(
      () => validateChannelPayload({
        name: 'Bad',
        baseUrl: 'https://example.test/anthropic',
        models: [],
        maxTokens: 1024,
        maxTurns: 0,
      }),
      SchemaValidationError,
    );
  });

  it('passes AbortSignal through to provider fetch', async () => {
    const originalFetch = globalThis.fetch;
    const ac = new AbortController();
    let receivedSignal;

    globalThis.fetch = async (_url, opts) => {
      receivedSignal = opts.signal;
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                return { done: true };
              },
            };
          },
        },
      };
    };

    try {
      await streamChat(
        { baseUrl: 'https://example.test', apiKey: 'sk-test', model: 'm', maxTokens: 1, tools: [] },
        [{ role: 'user', content: 'hi' }],
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        { signal: ac.signal },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(receivedSignal, ac.signal);
  });

  it('keeps audit trace with internal tool messages on assistant messages', () => {
    const finalState = {
      reason: 'completed',
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'delegate_task', input: { task: 'work' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    };
    const trace = buildAuditTrace({
      conversationId: 'conv1',
      channelId: 'ch1',
      model: 'model1',
      rootRun: { runId: 'root1', startedAt: '2026-05-16T00:00:00.000Z', durationMs: 10 },
      status: 'completed',
      finalState,
      turnStartIndex: 0,
      events: [{ type: 'tool_call', toolCallId: 'toolu_1' }],
      toolCalls: [{ toolCallId: 'toolu_1', name: 'delegate_task' }],
      toolResults: [{ toolCallId: 'toolu_1', name: 'delegate_task', isError: false }],
      agentRuns: [{ runId: 'sub1', parentRunId: 'root1', status: 'completed' }],
    });
    const message = assistantMessage({ ...finalState, trace }, 'model1');

    assert.equal(message.trace.rootRunId, 'root1');
    assert.equal(message.trace.messages[1].content[1].type, 'tool_use');
    assert.equal(message.trace.messages[2].content[0].type, 'tool_result');
    assert.equal(message.trace.toolCalls[0].toolCallId, 'toolu_1');
  });

  it('merges complete subagent metadata into existing render blocks', () => {
    const blocks = appendAgentRunBlocks(
      [{ type: 'subagent-run', runId: 'sub1', status: 'completed', text: 'done' }],
      [{
        runId: 'sub1',
        parentRunId: 'root1',
        rootRunId: 'root1',
        status: 'completed',
        label: 'Worker',
        task: 'Do work',
        durationMs: 42,
        result: { text: 'done', usage: { output_tokens: 3 } },
        events: [
          { type: 'subagent_thinking', text: 'too much' },
          { type: 'subagent_delta', text: 'before tool' },
          { type: 'subagent_tool_call', name: 'calculator' },
          { type: 'subagent_tool_result', name: 'calculator', output: 4 },
          { type: 'subagent_delta', text: 'after tool' },
        ],
      }],
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].label, 'Worker');
    assert.equal(blocks[0].task, 'Do work');
    assert.equal(blocks[0].parentRunId, 'root1');
    assert.equal(blocks[0].durationMs, 42);
    assert.deepEqual(blocks[0].usage, { output_tokens: 3 });
    assert.equal(blocks[0].events.length, 2);
    assert.equal(blocks[0].events[0].type, 'subagent_tool_call');
    assert.deepEqual(blocks[0].timeline.map(item => item.kind), ['text', 'event', 'event', 'text']);
  });

  it('summarizes token usage and cache efficiency for the usage dashboard', () => {
    const report = summarizeRunsForUsage([
      {
        runId: 'root1',
        role: 'root',
        status: 'completed',
        label: 'Root task',
        model: 'model-a',
        startedAt: '2026-05-16T00:00:00.000Z',
        durationMs: 1000,
        result: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
            output_tokens: 50,
            server_tool_use: { web_search_requests: 2 },
          },
        },
        events: [
          { type: 'tool_call' },
          { type: 'server_tool_call' },
          { type: 'server_tool_result' },
        ],
      },
      {
        runId: 'sub1',
        parentRunId: 'root1',
        rootRunId: 'root1',
        role: 'subagent',
        status: 'completed',
        label: 'Worker',
        model: 'model-a',
        durationMs: 500,
        result: {
          usage: {
            input_tokens: 80,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 0,
            output_tokens: 30,
          },
        },
        events: [
          { type: 'subagent_tool_call' },
          { type: 'subagent_tool_result' },
        ],
      },
    ]);

    assert.equal(report.summary.requestCount, 2);
    assert.equal(report.summary.totalInputTokens, 600);
    assert.equal(report.summary.cacheReadInputTokens, 320);
    assert.equal(report.summary.uncachedInputTokens, 280);
    assert.equal(report.summary.outputTokens, 80);
    assert.equal(report.summary.webSearchRequests, 2);
    assert.equal(report.summary.toolCalls, 3);
    assert.equal(report.summary.weightedCacheHitRatio, 320 / 600);
    assert.equal(report.summary.averageDurationMs, 750);
    assert.equal(report.runs[0].subagentCount, 1);
    assert.equal(report.runs[0].metrics.cacheHitRatio, 300 / 500);
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].runCount, 2);
    assert.equal(report.tasks[0].subagentCount, 1);
    assert.equal(report.tasks[0].metrics.totalInputTokens, 600);
    assert.equal(report.tasks[0].metrics.cacheReadInputTokens, 320);
    assert.equal(report.tasks[0].metrics.outputTokens, 80);
    assert.equal(report.tasks[0].metrics.cacheHitRatio, 320 / 600);
    assert.deepEqual(report.tasks[0].runs.map(run => run.runId), ['root1', 'sub1']);
    assert.deepEqual(report.groups.byRole.map(group => group.key), ['root', 'subagent']);
    assert.equal(report.groups.byModel[0].requestCount, 2);
  });

  it('applies base and channel model pricing to usage reports', () => {
    const channels = [
      {
        id: 'ch1',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        pricing: {
          models: {
            'model-a': {
              currency: 'USD',
              unit: 'per_1m_tokens',
              inputTokenPrice: 1,
              cacheReadInputTokenPrice: 0.1,
              cacheCreationInputTokenPrice: 1,
              outputTokenPrice: 2,
              webSearchRequestPrice: 0.01,
              requestPrice: 0.25,
              sourceUrl: '',
              updatedAt: '2026-05-17',
            },
          },
        },
      },
      {
        id: 'ch2',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        pricing: { models: {} },
      },
    ];
    const basePricing = [
      {
        id: 'base-model-b',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'model-b',
        currency: 'USD',
        unit: 'per_1m_tokens',
        inputTokenPrice: 0.5,
        cacheReadInputTokenPrice: 0.05,
        cacheCreationInputTokenPrice: 0.5,
        outputTokenPrice: 1,
        webSearchRequestPrice: null,
        requestPrice: 0.05,
        sourceUrl: '',
        updatedAt: '2026-05-17',
      },
    ];

    const report = summarizeRunsForUsage([
      {
        runId: 'run1',
        role: 'root',
        status: 'completed',
        channelId: 'ch1',
        model: 'model-a',
        result: {
          usage: {
            input_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
            output_tokens: 500_000,
            server_tool_use: { web_search_requests: 2 },
          },
        },
        events: [],
      },
      {
        runId: 'run2',
        role: 'root',
        status: 'completed',
        channelId: 'ch2',
        model: 'model-b',
        result: {
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
          },
        },
        events: [],
      },
    ], { channels, basePricing });

    assert.equal(report.runs[0].cost.pricingSource, 'channel_override');
    assert.equal(report.runs[0].cost.pricingStatus, 'estimated');
    assert.equal(report.runs[0].cost.requestCost, 0.25);
    assert.equal(report.runs[0].cost.totalCost, 2.37);
    assert.equal(report.runs[1].cost.pricingSource, 'base_default');
    assert.equal(report.runs[1].cost.pricingStatus, 'estimated');
    assert.equal(report.runs[1].cost.requestCost, 0.05);
    assert.equal(report.runs[1].cost.totalCost, 1.55);
    assert.equal(report.summary.cost.requestCost, 0.3);
    assert.equal(report.summary.cost.totalCost, 3.92);
    assert.equal(report.summary.cost.pricingSources.channel_override, 1);
    assert.equal(report.summary.cost.pricingSources.base_default, 1);
  });

  it('reports partial pricing when priced token usage has no rate', () => {
    const effective = findEffectiveModelPricing({
      channel: { id: 'ch1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', pricing: { models: {} } },
      model: 'model-a',
      basePricing: [{
        id: 'model-a',
        provider: 'deepseek',
        baseUrl: '',
        model: 'model-a',
        currency: 'USD',
        unit: 'per_1m_tokens',
        inputTokenPrice: 1,
        cacheReadInputTokenPrice: 0.1,
        cacheCreationInputTokenPrice: 1,
        outputTokenPrice: 2,
        webSearchRequestPrice: null,
        sourceUrl: '',
        updatedAt: '2026-05-17',
      }],
    });
    const cost = calculateUsageCost({
      input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 1 },
    }, effective);

    assert.equal(cost.pricingStatus, 'partial');
    assert.equal(cost.requestCost, 0);
    assert.equal(cost.totalCost, 1);
    assert.deepEqual(cost.missingFields, ['webSearchRequestPrice']);
    assert.deepEqual(cost.unpricedUsage, ['webSearchRequests']);
  });
});
