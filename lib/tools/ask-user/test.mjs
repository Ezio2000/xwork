import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTool } from '../runner.mjs';
import { listTools } from '../registry.mjs';
import { tool, normalizeAskUserInput } from './index.mjs';
import { createUserInputRegistry } from '../../user-input-registry.mjs';
import { buildSystemPrompt } from '../../anthropic/message-normalizer.mjs';
import { RUN_EVENT_TYPES } from '../../run-events.mjs';
import { queryLoop } from '../../query-loop.mjs';

function ctx(overrides = {}) {
  return {
    conversationId: 'test',
    source: 'test',
    environment: 'test',
    persistToolRun: false,
    runId: 'run_test',
    rootRunId: 'run_test',
    agentDepth: 0,
    ...overrides,
  };
}

describe('ask_user tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const registered = tools.find(t => t.id === 'ask_user');
    assert.ok(registered);
    assert.equal(registered.enabled, true);
    assert.equal(tool.defaultEnabled, true);
  });

  it('normalizes confirm/single/multi/text/number/form kinds', () => {
    const confirm = normalizeAskUserInput({ question: 'Proceed?', kind: 'confirm' });
    assert.equal(confirm.kind, 'confirm');
    assert.equal(confirm.options.length, 2);

    const single = normalizeAskUserInput({
      question: 'Env?',
      kind: 'single',
      options: ['dev', 'test'],
      recommended: 'dev',
    });
    assert.equal(single.recommended, 'dev');

    const form = normalizeAskUserInput({
      question: 'Deploy params',
      kind: 'form',
      fields: [
        { name: 'env', type: 'select', options: ['dev', 'uat'], required: true },
        { name: 'confirm', type: 'boolean', label: 'Go now' },
      ],
    });
    assert.equal(form.fields.length, 2);
  });

  it('includes aggressive ask_user guidance in system prompt', () => {
    const system = buildSystemPrompt([], { tools: [tool] });
    assert.match(system, /ask_user — Human-in-the-Loop \(use aggressively\)/);
    assert.match(system, /ask instead of guessing/);
    assert.match(system, /Prefer asking the human over guessing/);
  });

  it('blocks ask_user inside subagents', async () => {
    const registry = createUserInputRegistry();
    const result = await runTool(
      {
        id: 'toolu_sub',
        name: 'ask_user',
        input: { question: 'Allowed?', kind: 'confirm' },
      },
      {
        ...ctx({ agentDepth: 1, userInputRegistry: registry }),
      },
    );
    assert.equal(result.isError, true);
    assert.match(String(result.output), /main conversation/i);
  });

  it('waits for registry answer and returns ask-user render block', async () => {
    const registry = createUserInputRegistry();
    const toolCallId = 'toolu_wait';
    const runPromise = runTool(
      {
        id: toolCallId,
        name: 'ask_user',
        input: { question: 'Continue?', kind: 'confirm' },
      },
      {
        ...ctx({ userInputRegistry: registry, toolCallId }),
      },
    );

    await new Promise(r => setTimeout(r, 10));
    registry.submitAnswer({
      runId: 'run_test',
      toolCallId,
      response: { status: 'answered', answer: 'yes' },
    });

    const result = await runPromise;
    assert.equal(result.isError, false);
    assert.equal(result.render.renderType, 'ask-user');
    assert.equal(result.render.data.status, 'answered');
    assert.equal(result.render.data.answer, 'yes');
  });

  it('emits ask_user_pending through queryLoop before resolving', async () => {
    const registry = createUserInputRegistry();
    let streamCalls = 0;
    const events = [];

    const iterator = queryLoop({
      config: { tools: [], maxTurns: 3 },
      history: [{ role: 'user', content: 'hi' }],
      toolContext: {
        ...ctx({ userInputRegistry: registry }),
      },
      streamChat: async () => {
        streamCalls += 1;
        if (streamCalls === 1) {
          return {
            text: 'Let me ask',
            content: [
              { type: 'text', text: 'Let me ask' },
              {
                type: 'tool_use',
                id: 'toolu_loop',
                name: 'ask_user',
                input: { question: 'Pick env', kind: 'single', options: ['dev', 'test'] },
              },
            ],
            toolCalls: [{
              id: 'toolu_loop',
              name: 'ask_user',
              input: { question: 'Pick env', kind: 'single', options: ['dev', 'test'] },
            }],
            stopReason: 'tool_use',
          };
        }
        return {
          text: 'done',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
        };
      },
    });

    const finalState = await Promise.race([
      (async () => {
        let iter = await iterator.next();
        while (!iter.done) {
          events.push(iter.value);
          if (iter.value?.type === RUN_EVENT_TYPES.ASK_USER_PENDING) {
            registry.submitAnswer({
              runId: 'run_test',
              toolCallId: 'toolu_loop',
              response: { status: 'answered', answer: 'dev' },
            });
          }
          iter = await iterator.next();
        }
        return iter.value;
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queryLoop ask_user test timed out')), 8000)),
    ]);

    assert.ok(events.some(e => e.type === RUN_EVENT_TYPES.ASK_USER_PENDING));
    assert.ok(events.some(e => e.type === RUN_EVENT_TYPES.TOOL_RESULT && e.renderType === 'ask-user'));
    assert.equal(finalState.reason, 'completed');
  });
});
