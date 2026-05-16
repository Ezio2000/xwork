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
      context: { conversationId: 'conv1', channelId: 'ch1', model: 'test-model' },
      emitEvent: (event) => events.push(event),
      maxTurns: 1,
    });

    const stored = await getAgentRun(result.runId);

    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'sub result');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.role, 'subagent');
    assert.ok(events.some(event => event.eventType === 'subagent_start'));
    assert.ok(events.some(event => event.eventType === 'subagent_delta'));
    assert.ok(events.some(event => event.eventType === 'subagent_done'));
  });

  it('delegate_task exposes a subagent render block', () => {
    const render = delegateTaskTool.parseResult({
      runId: 'run_1',
      status: 'completed',
      label: 'Worker',
      text: 'done',
      reason: 'completed',
    });

    assert.equal(render.renderType, 'subagent-run');
    assert.equal(render.data.runId, 'run_1');
    assert.equal(render.data.status, 'completed');
  });
});
