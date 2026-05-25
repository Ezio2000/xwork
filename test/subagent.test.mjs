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

  it('uses delegate_task tool config defaultMaxTurns when input omits maxTurns', async () => {
    let captured;
    const runSubagent = async (opts) => {
      captured = opts;
      return {
        runId: 'run_cfg',
        status: 'completed',
        text: 'ok',
        label: '',
        task: opts.task,
        parentRunId: null,
        rootRunId: 'run_cfg',
        reason: 'completed',
        durationMs: 1,
      };
    };

    await delegateTaskTool.handler(
      { objective: 'Configured default turns' },
      { config: { defaultMaxTurns: 5 }, context: { runSubagent, agentDepth: 0 } },
    );

    assert.equal(captured.maxTurns, 5);
  });

  it('prefers delegate_task input maxTurns over tool config defaultMaxTurns', async () => {
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
      { config: { defaultMaxTurns: 5 }, context: { runSubagent, agentDepth: 0 } },
    );

    assert.equal(captured.maxTurns, 2);
  });

  it('accepts maxTurns up to 10 and rejects above the hard cap', () => {
    assert.doesNotThrow(() => delegateTaskTool.validate({
      objective: 'Six turns',
      maxTurns: 6,
    }));
    assert.doesNotThrow(() => delegateTaskTool.validate({
      objective: 'Ten turns',
      maxTurns: 10,
    }));
    assert.throws(
      () => delegateTaskTool.validate({ objective: 'Too many turns', maxTurns: 11 }),
      /maxTurns must be between 1 and 10/,
    );
  });

  it('clamps tool config defaultMaxTurns to the hard cap of 10', async () => {
    let captured;
    const runSubagent = async (opts) => {
      captured = opts;
      return {
        runId: 'run_cap',
        status: 'completed',
        text: 'ok',
        label: '',
        task: opts.task,
        parentRunId: null,
        rootRunId: 'run_cap',
        reason: 'completed',
        durationMs: 1,
      };
    };

    await delegateTaskTool.handler(
      { objective: 'Use configured cap' },
      { config: { defaultMaxTurns: 100 }, context: { runSubagent, agentDepth: 0 } },
    );

    assert.equal(captured.maxTurns, 10);
  });

  it('falls back to runtime default when tool config defaultMaxTurns is invalid', async () => {
    let captured;
    const runSubagent = async (opts) => {
      captured = opts;
      return {
        runId: 'run_fallback',
        status: 'completed',
        text: 'ok',
        label: '',
        task: opts.task,
        parentRunId: null,
        rootRunId: 'run_fallback',
        reason: 'completed',
        durationMs: 1,
      };
    };

    await delegateTaskTool.handler(
      { objective: 'Invalid config default' },
      { config: { defaultMaxTurns: 'bad' }, context: { runSubagent, agentDepth: 0 } },
    );

    assert.equal(captured.maxTurns, undefined);
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
    assert.deepEqual(receivedMessages[1], { role: 'user', content: 'Objective:\nInvestigate one thing' });
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
    assert.deepEqual(receivedToolNames, ['web_search', 'list_dir', 'git', 'code_outline']);
    assert.deepEqual(result.allowedTools, [
      'web_search',
      'get_current_time',
      'calculator',
      'uuid_gen',
      'list_dir',
      'git',
      'code_outline',
      'shell_command',
    ]);
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
    assert.deepEqual(result.allowedTools, ['list_dir', 'git', 'code_outline', 'grep']);
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

    assert.match(system, /# Subagent Delegation/);
    assert.match(system, /Strong delegation triggers/);
    assert.match(system, /3 or more independent topics/);
    assert.match(system, /launching multiple delegate_task calls in one assistant response/);
    assert.match(system, /standard execution path/);
    assert.match(system, /It is not a last resort/);
    assert.match(system, /Do not let web_search replace task decomposition/);
    assert.match(system, /exactly one concrete objective/);
    assert.match(system, /fresh-context/);
    assert.match(system, /concise result/);
  });
});
