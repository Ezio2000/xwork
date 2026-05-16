import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getAgentRun } from '../lib/agents/runs.mjs';
import { runSubagent } from '../lib/agents/subagent-runtime.mjs';
import { delegateTaskTool } from '../lib/tools/builtin/delegate-task.mjs';

describe('subagent runtime', () => {
  it('creates an agent run, streams events, and completes with text', async () => {
    const events = [];
    const streamChat = async (_config, _messages, onDelta, _onThink, onDone) => {
      onDelta('sub ');
      onDelta('result');
      onDone('sub result', 'end_turn', null);
      return {
        text: 'sub result',
        content: [{ type: 'text', text: 'sub result' }],
        stopReason: 'end_turn',
        usage: null,
        toolCalls: [],
        serverToolEvents: [],
      };
    };

    const result = await runSubagent({
      task: 'Investigate one thing',
      label: 'Investigate',
      config: { model: 'test-model', tools: [], streamChat },
      context: { conversationId: 'conv1', channelId: 'ch1', model: 'test-model', source: 'test', environment: 'test' },
      emitEvent: (event) => events.push(event),
      maxTurns: 1,
    });

    const stored = await getAgentRun(result.runId);

    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'sub result');
    assert.equal(result.label, 'Investigate');
    assert.equal(result.task, 'Investigate one thing');
    assert.equal(result.parentRunId, null);
    assert.ok(result.rootRunId);
    assert.equal(typeof result.durationMs, 'number');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.role, 'subagent');
    assert.equal(stored.rootRunId, result.rootRunId);
    assert.equal(stored.source, 'test');
    assert.equal(stored.environment, 'test');
    assert.ok(events.some(event => event.eventType === 'subagent_start'));
    assert.ok(events.some(event => event.eventType === 'subagent_delta'));
    assert.ok(events.some(event => event.eventType === 'subagent_done' && typeof event.durationMs === 'number'));
  });

  it('records subagent server tool results in tool runs context', async () => {
    const toolRuns = [];
    const streamChat = async (_config, _messages, onDelta, _onThink, onDone, _onError, onServerToolEvent) => {
      onServerToolEvent({
        phase: 'call',
        id: 'srv_1',
        name: 'web_search',
        input: { query: 'subagent search' },
      });
      onServerToolEvent({
        phase: 'result',
        id: 'srv_1',
        name: 'web_search',
        isError: false,
        data: { resultCount: 1 },
      });
      onDelta('searched');
      onDone('searched', 'end_turn', null);
      return {
        text: 'searched',
        content: [{ type: 'text', text: 'searched' }],
        stopReason: 'end_turn',
        usage: null,
        toolCalls: [],
        serverToolEvents: [],
      };
    };

    const result = await runSubagent({
      task: 'Search one thing',
      config: {
        model: 'test-model',
        tools: [],
        streamChat,
        appendToolRun: (run) => toolRuns.push(run),
      },
      context: {
        conversationId: 'conv1',
        channelId: 'ch1',
        model: 'test-model',
        rootRunId: 'root1',
        source: 'test',
        environment: 'test',
      },
      maxTurns: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(toolRuns.length, 1);
    assert.equal(toolRuns[0].name, 'web_search');
    assert.deepEqual(toolRuns[0].input, { query: 'subagent search' });
    assert.equal(toolRuns[0].context.agentRunId, result.runId);
    assert.equal(toolRuns[0].context.rootRunId, 'root1');
    assert.equal(toolRuns[0].context.agentDepth, 1);
  });

  it('delegate_task exposes a subagent render block', () => {
    const render = delegateTaskTool.parseResult({
      runId: 'run_1',
      status: 'completed',
      label: 'Worker',
      task: 'Do work',
      parentRunId: 'root_1',
      rootRunId: 'root_1',
      text: 'done',
      reason: 'completed',
      durationMs: 123,
      usage: { input_tokens: 1 },
    });

    assert.equal(render.renderType, 'subagent-run');
    assert.equal(render.data.runId, 'run_1');
    assert.equal(render.data.status, 'completed');
    assert.equal(render.data.task, 'Do work');
    assert.equal(render.data.parentRunId, 'root_1');
    assert.equal(render.data.durationMs, 123);
    assert.deepEqual(render.data.usage, { input_tokens: 1 });
  });
});
