import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRootRunContext, isTransientSubagentEvent } from '../lib/root-run-context.mjs';

function fakeRunStore() {
  const appended = [];
  const completed = [];
  const rootRun = {
    runId: 'root1',
    role: 'root',
    status: 'running',
    startedAt: '2026-05-18T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
  };
  return {
    rootRun,
    appended,
    completed,
    createRun: async payload => ({ ...rootRun, ...payload, runId: payload.runId || rootRun.runId }),
    appendRunEvent: async (runId, event) => appended.push({ runId, event }),
    completeRun: async (runId, patch) => {
      const run = {
        ...rootRun,
        runId,
        ...patch,
        completedAt: '2026-05-18T00:00:01.000Z',
        durationMs: 1000,
      };
      completed.push(run);
      return run;
    },
    getRunsByIds: async ids => ids.map(runId => ({
      runId,
      parentRunId: 'root1',
      rootRunId: 'root1',
      status: 'completed',
      label: 'Stored worker',
      task: 'Stored task',
      result: { text: 'stored result' },
      events: [{ type: 'subagent_tool_call', name: 'calculator' }],
    })),
  };
}

describe('root run context', () => {
  it('identifies transient subagent events', () => {
    assert.equal(isTransientSubagentEvent({ eventType: 'subagent_delta' }), true);
    assert.equal(isTransientSubagentEvent({ type: 'subagent_thinking' }), true);
    assert.equal(isTransientSubagentEvent({ eventType: 'subagent_done' }), false);
  });

  it('records root, tool, and subagent events into emitted events and trace', async () => {
    const emitted = [];
    const store = fakeRunStore();
    const context = await createRootRunContext({
      runId: 'root1',
      conversationId: 'conv1',
      channelId: 'ch1',
      model: 'model1',
      task: 'Do root work',
      label: 'Do root work',
      emit: event => emitted.push(event),
      createRun: store.createRun,
      appendRunEvent: store.appendRunEvent,
      completeRun: store.completeRun,
      getRunsByIds: store.getRunsByIds,
    });

    context.recordRootStart();
    context.recordToolCall({ id: 'tool_1', name: 'calculator', input: { expression: '2+2' } });
    context.recordToolResult({
      id: 'tool_1',
      name: 'calculator',
      input: { expression: '2+2' },
      output: { result: 4 },
      isError: false,
      durationMs: 3,
    });
    context.emitAgentEvent({
      eventType: 'subagent_delta',
      runId: 'sub1',
      text: 'hidden from audit',
    });
    context.emitAgentEvent({
      eventType: 'subagent_tool_result',
      runId: 'sub1',
      name: 'calculator',
      isError: false,
      output: 4,
    });
    context.emitAgentEvent({
      eventType: 'subagent_done',
      runId: 'sub1',
      parentRunId: 'root1',
      status: 'completed',
      label: 'Worker',
      task: 'Calculate',
      result: { text: 'done' },
      durationMs: 10,
    });

    const finalState = {
      reason: 'completed',
      stopReason: 'end_turn',
      usage: { input_tokens: 1 },
      text: 'final',
      content: [{ type: 'text', text: 'final' }],
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
      ],
      serverToolEvents: [],
    };
    const { agentRuns, trace } = await context.completeAndBuildTrace(finalState, { turnStartIndex: 1 });

    assert.deepEqual(emitted.map(event => event.type), [
      'agent_event',
      'tool_call',
      'tool_result',
      'agent_event',
      'agent_event',
      'agent_event',
    ]);
    assert.deepEqual(store.appended.map(item => item.event.type), [
      'root_start',
      'tool_call',
      'tool_result',
      'root_done',
    ]);
    assert.equal(store.completed[0].status, 'completed');
    assert.equal(agentRuns.length, 1);
    assert.equal(agentRuns[0].runId, 'sub1');
    assert.equal(agentRuns[0].label, 'Stored worker');
    assert.ok(agentRuns[0].events.some(event => event.type === 'subagent_tool_result'));
    assert.equal(trace.rootRunId, 'root1');
    assert.equal(trace.status, 'completed');
    assert.equal(trace.messages.length, 1);
    assert.equal(trace.toolCalls[0].toolCallId, 'tool_1');
    assert.equal(trace.toolResults[0].output.result, 4);
    assert.ok(!trace.events.some(event => event.type === 'subagent_delta'));
  });
});
