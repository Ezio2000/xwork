import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appendAgentRunEvent, completeAgentRun, createAgentRun, getAgentRun } from '../lib/agents/runs.mjs';
import { runSubagent } from '../lib/agents/subagent-runtime.mjs';
import { buildSystemPrompt } from '../lib/anthropic/message-normalizer.mjs';
import { delegateTaskTool } from '../lib/tools/builtin/delegate-task.mjs';
import { webSearchTool } from '../lib/tools/builtin/web-search.mjs';

describe('subagent runtime', () => {
  it('delegate_task accepts shell_command in allowedTools', () => {
    assert.doesNotThrow(() => delegateTaskTool.validate({
      objective: 'Inspect files with shell',
      allowedTools: ['shell_command', 'read_file'],
    }));
  });

  it('delegate_task accepts workspace exploration tools in allowedTools', () => {
    assert.doesNotThrow(() => delegateTaskTool.validate({
      objective: 'Review repo structure and recent changes',
      allowedTools: ['list_dir', 'git', 'code_outline', 'grep', 'glob'],
    }));
  });

  it('omits delegate_task maxTurns when no call override is configured', async () => {
    let captured;
    const runSubagent = async (opts) => {
      captured = opts;
      return {
        runId: 'run_profile_default',
        status: 'completed',
        text: 'ok',
        label: '',
        task: opts.task,
        parentRunId: null,
        rootRunId: 'run_profile_default',
        reason: 'completed',
        durationMs: 1,
      };
    };

    await delegateTaskTool.handler(
      { objective: 'Profile default turns' },
      { config: {}, context: { runSubagent, agentDepth: 0 } },
    );

    assert.equal(captured.maxTurns, undefined);
  });

  it('passes delegate_task input maxTurns as a per-call expert override', async () => {
    let captured;
    const runSubagent = async (opts) => {
      captured = opts;
      return {
        runId: 'run_override',
        status: 'completed',
        text: 'ok',
        label: '',
        task: opts.task,
        parentRunId: null,
        rootRunId: 'run_override',
        reason: 'completed',
        durationMs: 1,
      };
    };

    await delegateTaskTool.handler(
      { objective: 'Override turns', maxTurns: 2 },
      { config: {}, context: { runSubagent, agentDepth: 0 } },
    );

    assert.equal(captured.maxTurns, 2);
  });

  it('accepts delegate_task maxTurns up to 100 and rejects above the hard cap', () => {
    assert.doesNotThrow(() => delegateTaskTool.validate({ objective: 'Hundred turns', maxTurns: 100 }));
    assert.throws(
      () => delegateTaskTool.validate({ objective: 'Too many turns', maxTurns: 101 }),
      /maxTurns must be between 1 and 100/,
    );
  });

  it('accepts delegate_task timeout up to five minutes and rejects above the hard cap', () => {
    assert.doesNotThrow(() => delegateTaskTool.validate({ objective: 'Long research', timeoutMs: 300000 }));
    assert.throws(
      () => delegateTaskTool.validate({ objective: 'Too long', timeoutMs: 300001 }),
      /timeoutMs must be between 1000 and 300000/,
    );
  });

  it('accepts delegate_task output up to eight thousand chars and rejects above the hard cap', () => {
    assert.doesNotThrow(() => delegateTaskTool.validate({ objective: 'Long answer', maxOutputChars: 8000 }));
    assert.throws(
      () => delegateTaskTool.validate({ objective: 'Too much output', maxOutputChars: 8001 }),
      /maxOutputChars must be between 500 and 8000/,
    );
  });

  it('does not block agent creation on run-store persistence', async () => {
    const run = await createAgentRun({
      role: 'subagent',
      task: 'Fast create',
      source: 'test',
      environment: 'test',
    });

    await appendAgentRunEvent(run.runId, { type: 'probe' });
    const completed = await completeAgentRun(run.runId, { status: 'completed', result: { ok: true } });

    assert.equal(run.status, 'running');
    assert.equal(completed.status, 'completed');
    assert.ok(completed.events.some(event => event.type === 'probe'));
  });

  it('creates an agent run, streams events, and completes with text', async () => {
    const events = [];
    let receivedMessages;
    const streamChat = async (_config, messages, onDelta, _onThink, onDone) => {
      receivedMessages = messages;
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
    assert.ok(!stored.events.some(event => event.type === 'subagent_delta'));
    assert.ok(!stored.events.some(event => event.type === 'subagent_thinking'));
    assert.ok(events.some(event => event.eventType === 'subagent_start'));
    assert.ok(events.some(event => event.eventType === 'subagent_delta'));
    assert.ok(events.some(event => event.eventType === 'subagent_done' && typeof event.durationMs === 'number'));
    assert.equal(receivedMessages[0].role, 'system');
    assert.match(receivedMessages[0].content, /fresh context/);
    assert.match(receivedMessages[0].content, /single delegated objective/);
    assert.match(receivedMessages[0].content, /3-6 bullets/);
    assert.match(receivedMessages[0].content, /Do not create subagents/);
    assert.match(receivedMessages[1].content, /Objective:\nInvestigate one thing/);
    assert.match(receivedMessages[1].content, /Output contract:/);
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
    });

    assert.equal(result.status, 'completed');
    assert.equal(toolRuns.length, 1);
    assert.equal(toolRuns[0].name, 'web_search');
    assert.deepEqual(toolRuns[0].input, { query: 'subagent search' });
    assert.equal(toolRuns[0].context.agentRunId, result.runId);
    assert.equal(toolRuns[0].context.rootRunId, 'root1');
    assert.equal(toolRuns[0].context.agentDepth, 1);
  });

  it('continues after subagent server-only web_search results and returns the summary text', async () => {
    let callCount = 0;
    let secondMessages;
    const streamChat = async (_config, messages, onDelta, _onThink, onDone, _onError, onServerToolEvent) => {
      callCount += 1;
      if (callCount === 1) {
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
          renderType: 'source-cards',
          data: { sources: [{ title: 'Result', url: 'https://example.test' }] },
        });
        onDone('', 'end_turn', null);
        return {
          text: '',
          content: [
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'subagent search' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv_1',
              content: [{ type: 'web_search_result', title: 'Result', url: 'https://example.test' }],
            },
          ],
          stopReason: 'end_turn',
          usage: { server_tool_use: { web_search_requests: 1 } },
          toolCalls: [],
          serverToolEvents: [],
        };
      }
      secondMessages = messages;
      onDelta('summary text');
      onDone('summary text', 'end_turn', null);
      return {
        text: 'summary text',
        content: [{ type: 'text', text: 'summary text' }],
        stopReason: 'end_turn',
        usage: null,
        toolCalls: [],
        serverToolEvents: [],
      };
    };

    const result = await runSubagent({
      task: 'Search and summarize one thing',
      config: {
        model: 'test-model',
        tools: [{ name: 'web_search' }],
        streamChat,
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 2,
    });

    assert.equal(callCount, 2);
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'summary text');
    assert.equal(secondMessages[2].role, 'assistant');
    assert.equal(secondMessages[2].content[0].type, 'server_tool_use');
    assert.equal(secondMessages[2].content[1].type, 'web_search_tool_result');
  });

  it('uses independent maxTurns budgets for separate subagent runs', async () => {
    let firstCalls = 0;
    let secondCalls = 0;

    const first = await runSubagent({
      task: 'Use both independent turns',
      config: {
        model: 'test-model',
        tools: [],
        streamChat: async (_config, _messages, onDelta, _onThink, onDone, _onError, onServerToolEvent) => {
          firstCalls += 1;
          if (firstCalls === 1) {
            onServerToolEvent?.({ phase: 'call', id: 'srv_independent', name: 'web_search', input: { query: 'independent' } });
            onServerToolEvent?.({ phase: 'result', id: 'srv_independent', name: 'web_search', isError: false, data: { resultCount: 1 } });
            onDone('', 'end_turn', null);
            return {
              text: '',
              content: [{ type: 'server_tool_use', id: 'srv_independent', name: 'web_search', input: { query: 'independent' } }],
              stopReason: 'end_turn',
              usage: null,
              toolCalls: [],
              serverToolEvents: [],
            };
          }
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
        },
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 2,
    });

    const second = await runSubagent({
      task: 'Has its own turns',
      config: {
        model: 'test-model',
        tools: [],
        streamChat: async (_config, _messages, onDelta, _onThink, onDone) => {
          secondCalls += 1;
          onDelta('should not run');
          onDone('should not run', 'end_turn', null);
          return {
            text: 'should not run',
            content: [{ type: 'text', text: 'should not run' }],
            stopReason: 'end_turn',
            usage: null,
            toolCalls: [],
            serverToolEvents: [],
          };
        },
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 2,
    });

    assert.equal(first.status, 'completed');
    assert.equal(firstCalls, 2);
    assert.equal(second.status, 'completed');
    assert.equal(secondCalls, 1);
    assert.equal(first.limits.maxTurns, 2);
    assert.equal(second.limits.maxTurns, 2);
  });

  it('stops executing subagent web_search from the configured tool maxUses', async () => {
    let callCount = 0;
    const executedSearches = [];
    let finalMessages;
    const streamChat = async (_config, messages, onDelta, _onThink, onDone) => {
      callCount += 1;
      if (callCount === 1) {
        onDelta('collecting ');
        onDone('collecting ', 'tool_use', null);
        const calls = Array.from({ length: 4 }, (_, index) => ({
          id: `search_${index + 1}`,
          name: 'web_search',
          input: { query: `query ${index + 1}` },
        }));
        return {
          text: 'collecting ',
          content: [
            { type: 'text', text: 'collecting ' },
            ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
          ],
          stopReason: 'tool_use',
          usage: null,
          toolCalls: calls,
          serverToolEvents: [],
        };
      }
      if (callCount === 2) {
        onDelta('checking one more ');
        onDone('checking one more ', 'tool_use', null);
        const call = { id: 'search_5', name: 'web_search', input: { query: 'query 5' } };
        return {
          text: 'checking one more ',
          content: [
            { type: 'text', text: 'checking one more ' },
            { type: 'tool_use', id: call.id, name: call.name, input: call.input },
          ],
          stopReason: 'tool_use',
          usage: null,
          toolCalls: [call],
          serverToolEvents: [],
        };
      }
      finalMessages = [...messages];
      onDelta('summary after budget');
      onDone('summary after budget', 'end_turn', null);
      return {
        text: 'summary after budget',
        content: [{ type: 'text', text: 'summary after budget' }],
        stopReason: 'end_turn',
        usage: null,
        toolCalls: [],
        serverToolEvents: [],
      };
    };

    const result = await runSubagent({
      task: 'Search with a bounded budget',
      config: {
        model: 'test-model',
        tools: [{ name: 'web_search', maxUses: 2 }],
        streamChat,
      },
      runTool: async (call) => {
        executedSearches.push(call.id);
        return {
          id: call.id,
          name: call.name,
          isError: false,
          output: { sources: [{ title: call.input.query, url: `https://example.test/${call.id}` }], searchCount: 1 },
          durationMs: 1,
          render: {
            renderType: 'source-cards',
            data: { sources: [{ title: call.input.query, url: `https://example.test/${call.id}` }], resultCount: 1, searchCount: 1 },
          },
        };
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 4,
    });

    const stored = await getAgentRun(result.runId);
    const budgetEvent = stored.events.find(event => event.type === 'subagent_tool_result' && event.toolCallId === 'search_5');

    assert.equal(callCount, 3);
    assert.deepEqual(executedSearches, ['search_1', 'search_2']);
    assert.equal(result.status, 'completed');
    assert.match(result.text, /summary after budget/);
    assert.equal(budgetEvent.isError, true);
    assert.match(budgetEvent.output, /Tool budget reached for web_search: maximum 2 uses per agent run/);
    assert.equal(finalMessages.at(-1).role, 'user');
    assert.match(finalMessages.at(-1).content[0].content, /Tool budget reached for web_search: maximum 2 uses per agent run/);
  });

  it('uses shared tool config with independent maxUses counters per subagent run', async () => {
    const runOnce = async (label) => {
      const executed = [];
      const streamChat = async (_config, _messages, onDelta, _onThink, onDone) => {
        onDelta(label);
        onDone(label, 'tool_use', null);
        const calls = [
          { id: `${label}_search_1`, name: 'web_search', input: { query: `${label} 1` } },
          { id: `${label}_search_2`, name: 'web_search', input: { query: `${label} 2` } },
        ];
        return {
          text: label,
          content: [
            { type: 'text', text: label },
            ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
          ],
          stopReason: 'tool_use',
          usage: null,
          toolCalls: calls,
          serverToolEvents: [],
        };
      };

      const result = await runSubagent({
        task: `Search ${label}`,
        config: {
          model: 'test-model',
          tools: [{ name: 'web_search', maxUses: 2 }],
          streamChat,
        },
        runTool: async (call) => {
          executed.push(call.id);
          return { id: call.id, name: call.name, isError: false, output: { ok: true }, durationMs: 1 };
        },
        context: { conversationId: 'conv1', source: 'test', environment: 'test' },
        maxTurns: 1,
      });
      return { result, executed };
    };

    const first = await runOnce('first');
    const second = await runOnce('second');

    assert.equal(first.result.status, 'max_turns');
    assert.equal(second.result.status, 'max_turns');
    assert.deepEqual(first.executed, ['first_search_1', 'first_search_2']);
    assert.deepEqual(second.executed, ['second_search_1', 'second_search_2']);
  });

  it('persists api_error details for failed subagent model calls', async () => {
    const events = [];
    const streamChat = async (_config, _messages, onDelta) => {
      onDelta('partial text');
      throw new Error('Provider rejected replay after web search');
    };

    const result = await runSubagent({
      task: 'Fail with API error',
      config: { model: 'test-model', tools: [], streamChat },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      emitEvent: event => events.push(event),
      maxTurns: 1,
    });

    const stored = await getAgentRun(result.runId);
    const doneEvent = events.find(event => event.eventType === 'subagent_done');

    assert.equal(result.status, 'api_error');
    assert.match(result.error, /Provider rejected replay/);
    assert.match(stored.error, /Provider rejected replay/);
    assert.match(stored.result.error, /Provider rejected replay/);
    assert.match(doneEvent.error, /Provider rejected replay/);
  });

  it('uses fresh-context brief and output limits', async () => {
    let receivedMessages;
    const streamChat = async (_config, messages, onDelta, _onThink, onDone) => {
      receivedMessages = messages;
      const longText = 'x'.repeat(900);
      onDelta(longText);
      onDone(longText, 'end_turn', null);
      return {
        text: longText,
        content: [{ type: 'text', text: longText }],
        stopReason: 'end_turn',
        usage: null,
        toolCalls: [],
        serverToolEvents: [],
      };
    };

    const result = await runSubagent({
      objective: 'Answer one narrow question',
      task: 'Answer one narrow question',
      brief: 'Only use this context.',
      expectedOutput: 'Return 3 bullets.',
      config: { model: 'test-model', tools: [], streamChat },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 1,
      maxOutputChars: 500,
    });

    assert.doesNotMatch(receivedMessages[0].content, /Brief from parent:\nOnly use this context/);
    assert.match(receivedMessages[1].content, /Objective:\nAnswer one narrow question/);
    assert.match(receivedMessages[1].content, /Relevant context:\nOnly use this context/);
    assert.match(receivedMessages[1].content, /Output contract:\nReturn 3 bullets/);
    assert.equal(result.text.length, 503);
    assert.equal(result.usage, null);

    const stored = await getAgentRun(result.runId);
    assert.equal(stored.result.truncated, true);
    assert.equal(stored.result.fullTextLength, 900);
    assert.equal(stored.result.limits.maxOutputChars, 500);
  });

  it('includes list_dir, git, and code_outline in the default subagent tool set', async () => {
    let receivedToolNames;
    let receivedMessages;
    const streamChat = async (config, messages, _onDelta, _onThink, onDone) => {
      receivedToolNames = config.tools.map(tool => tool.name);
      receivedMessages = messages;
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

    const result = await runSubagent({
      task: 'Default workspace exploration',
      config: {
        model: 'test-model',
        tools: [
          { name: 'web_search' },
          { name: 'list_dir' },
          { name: 'git' },
          { name: 'code_outline' },
          { name: 'grep' },
          { name: 'write_file' },
        ],
        streamChat,
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 1,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(receivedToolNames, ['web_search', 'list_dir', 'git', 'code_outline', 'grep']);
    assert.doesNotMatch(receivedMessages[0].content, /use web_search at most 4 times total/);
    assert.deepEqual(new Set(result.allowedTools), new Set([
      'web_search',
      'get_current_time',
      'calculator',
      'uuid_gen',
      'list_dir',
      'git',
      'code_outline',
      'grep',
      'glob',
      'read_file',
      'shell_command',
    ]));
  });

  it('filters tools and blocks nested delegate_task by default', async () => {
    let receivedToolNames;
    const streamChat = async (config, _messages, _onDelta, _onThink, onDone) => {
      receivedToolNames = config.tools.map(tool => tool.name);
      onDone('', 'tool_use', null);
      return {
        text: '',
        content: [
          { type: 'tool_use', id: 'tool_nested', name: 'delegate_task', input: { objective: 'Nested work' } },
        ],
        stopReason: 'tool_use',
        usage: null,
        toolCalls: [{ id: 'tool_nested', name: 'delegate_task', input: { objective: 'Nested work' } }],
        serverToolEvents: [],
      };
    };

    const result = await runSubagent({
      task: 'Try nested delegation',
      config: {
        model: 'test-model',
        tools: [
          { name: 'web_search' },
          { name: 'delegate_task' },
          { name: 'calculator' },
        ],
        streamChat,
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 1,
    });

    assert.deepEqual(receivedToolNames, ['web_search', 'calculator']);
    assert.equal(result.status, 'max_turns');
    const stored = await getAgentRun(result.runId);
    assert.ok(stored.events.some(event => event.type === 'subagent_tool_result' && event.isError));
    assert.match(stored.events.find(event => event.type === 'subagent_tool_result')?.output || '', /not available/);
  });

  it('honors an explicit empty allowedTools list', async () => {
    let receivedToolNames;
    let receivedSystem;
    const streamChat = async (config, messages, _onDelta, _onThink, onDone) => {
      receivedToolNames = config.tools.map(tool => tool.name);
      receivedSystem = messages[0].content;
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

    const result = await runSubagent({
      task: 'No tools task',
      allowedTools: [],
      allowSubagents: true,
      config: {
        model: 'test-model',
        tools: [
          { name: 'web_search' },
          { name: 'delegate_task' },
        ],
        streamChat,
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 1,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(receivedToolNames, []);
    assert.match(receivedSystem, /Available tools: none/);
    assert.match(receivedSystem, /Do not create subagents/);
  });

  it('allows list_dir, git, and code_outline when explicitly delegated to a subagent', async () => {
    let receivedToolNames;
    const streamChat = async (config, _messages, _onDelta, _onThink, onDone) => {
      receivedToolNames = config.tools.map(tool => tool.name);
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

    const result = await runSubagent({
      task: 'Explore workspace and git history',
      allowedTools: ['list_dir', 'git', 'code_outline', 'grep'],
      config: {
        model: 'test-model',
        tools: [
          { name: 'list_dir' },
          { name: 'git' },
          { name: 'code_outline' },
          { name: 'grep' },
          { name: 'write_file' },
        ],
        streamChat,
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 1,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(receivedToolNames, ['list_dir', 'git', 'code_outline', 'grep']);
    assert.deepEqual(new Set(result.allowedTools), new Set(['list_dir', 'git', 'code_outline', 'grep']));
  });

  it('allows shell_command when explicitly delegated to a subagent', async () => {
    let receivedToolNames;
    const streamChat = async (config, _messages, _onDelta, _onThink, onDone) => {
      receivedToolNames = config.tools.map(tool => tool.name);
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

    const result = await runSubagent({
      task: 'Use shell for one inspection',
      allowedTools: ['shell_command'],
      config: {
        model: 'test-model',
        tools: [
          { name: 'web_search' },
          { name: 'shell_command' },
          { name: 'read_file' },
        ],
        streamChat,
      },
      context: { conversationId: 'conv1', source: 'test', environment: 'test' },
      maxTurns: 1,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(receivedToolNames, ['shell_command']);
    assert.deepEqual(result.allowedTools, ['shell_command']);
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
      limits: { maxTurns: 3, timeoutMs: 90000, maxOutputChars: 2000 },
      allowedTools: ['web_search'],
      truncated: true,
      fullTextLength: 5000,
    });

    assert.equal(render.renderType, 'subagent-run');
    assert.equal(render.data.runId, 'run_1');
    assert.equal(render.data.status, 'completed');
    assert.equal(render.data.task, 'Do work');
    assert.equal(render.data.parentRunId, 'root_1');
    assert.equal(render.data.durationMs, 123);
    assert.deepEqual(render.data.usage, { input_tokens: 1 });
    assert.deepEqual(render.data.limits, { maxTurns: 3, timeoutMs: 90000, maxOutputChars: 2000 });
    assert.deepEqual(render.data.allowedTools, ['web_search']);
    assert.equal(render.data.truncated, true);
    assert.equal(render.data.fullTextLength, 5000);
  });

  it('adds delegation strategy guidance to the model system prompt', () => {
    const system = buildSystemPrompt([], {
      model: 'test-model',
      tools: [delegateTaskTool, webSearchTool],
    });

    assert.match(system, /# Expert Agent Delegation/);
    assert.match(system, /Strong delegation triggers/);
    assert.match(system, /3 or more independent topics/);
    assert.match(system, /launching multiple delegate_task calls in one assistant response/);
    assert.match(system, /standard execution path/);
    assert.match(system, /It is not a last resort/);
    assert.match(system, /consider delegate_task to split work and then synthesize/);
    assert.match(system, /exactly one concrete objective/);
    assert.match(system, /fresh-context/);
    assert.match(system, /concise result/);
  });
});
