import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeServerToolEventHandler, serverToolOutput } from '../lib/server-tool-events.mjs';

describe('server tool event handling', () => {
  it('normalizes provider tool output with error codes', () => {
    assert.deepEqual(serverToolOutput({
      data: { resultCount: 0, errors: ['rate_limited'] },
      errorCode: 'rate_limited',
    }), {
      resultCount: 0,
      errors: ['rate_limited'],
      errorCode: 'rate_limited',
    });
  });

  it('emits call/result events and persists audit/run records', async () => {
    const emitted = [];
    const auditEvents = [];
    const toolRuns = [];
    const agentEvents = [];
    const handler = makeServerToolEventHandler({
      emit: event => emitted.push(event),
      conversationId: 'conv1',
      channelId: 'ch1',
      model: 'model1',
      rootRunId: 'root1',
      audit: {
        record(type, payload) {
          auditEvents.push({ type, payload });
        },
      },
      appendToolRun: async run => toolRuns.push(run),
      appendRunEvent: async (runId, event) => agentEvents.push({ runId, event }),
    });

    await handler({
      phase: 'call',
      id: 'srv_1',
      name: 'web_search',
      input: { query: 'xwork' },
    });
    await handler({
      phase: 'result',
      id: 'srv_1',
      name: 'web_search',
      isError: false,
      renderType: 'source-cards',
      data: { sources: [{ title: 'xwork', url: 'https://example.test' }], resultCount: 1 },
    });

    assert.deepEqual(emitted.map(event => event.type), ['tool_call', 'tool_result']);
    assert.deepEqual(emitted[0].tools[0], {
      id: 'srv_1',
      name: 'web_search',
      input: { query: 'xwork' },
    });
    assert.equal(emitted[1].tools[0].renderType, 'source-cards');
    assert.deepEqual(toolRuns[0].input, { query: 'xwork' });
    assert.equal(toolRuns[0].context.rootRunId, 'root1');
    assert.deepEqual(agentEvents.map(item => item.event.type), ['server_tool_call', 'server_tool_result']);
    assert.deepEqual(auditEvents.map(item => item.type), ['server_tool_call', 'server_tool_result']);
  });
});
