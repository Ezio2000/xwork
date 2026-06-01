import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { streamChat } from '../lib/api.mjs';
import { buildAuditTrace } from '../lib/audit-trace.mjs';
import { assistantMessage } from '../lib/anthropic/assistant-message.mjs';
import { anthropicTools, buildSystemPrompt, normalizeMessages } from '../lib/anthropic/message-normalizer.mjs';
import { CHAT_SERVICE_TEST_HOOKS, getChatRunSnapshot, handleChatRequest, handleChatRunStream } from '../lib/chat-service.mjs';
import { buildReplayHistory } from '../lib/chat/conversation-turn.mjs';
import { projectImagesForModel } from '../lib/chat/image-policy.mjs';
import { appendAgentRunBlocks } from '../lib/message-rendering.mjs';
import { publicActiveState } from '../lib/channels.mjs';
import { defaultConfig } from '../lib/config-store.mjs';
import { createImageAsset } from '../lib/image-assets.mjs';
import {
  SchemaValidationError,
  minimaxTokenPlanVisionProvider,
  validateChannelPayload,
  validateChatRequest,
  validateToolConfigPatch,
  validateVisionConfig,
  validateVisionProviderPayload,
} from '../lib/schema.mjs';
import { withConversationQueue } from '../lib/storage.mjs';
import { summarizeRunsForUsage } from '../lib/usage-report.mjs';
import { calculateUsageCost, findEffectiveModelPricing } from '../lib/model-pricing.mjs';
import { CONVERSATION_CONTRACT_VERSION } from '../lib/conversations/contracts.mjs';
import { PROVIDER_CONTRACT_VERSION } from '../lib/providers/provider-contract.mjs';
import { RUN_EVENT_TYPES, AGENT_EVENT_TYPES } from '../lib/run-events.mjs';
import { defaultToolScheduler, executeToolCalls } from '../lib/tools/scheduler.mjs';
import { tool as currentTimeTool } from '../lib/tools/current-time/index.mjs';
import { tool as delegateTaskTool } from '../lib/tools/delegate-task/index.mjs';
import { workspaceExplorationSystemPrompt } from '../lib/tools/_shared/workspace-exploration-prompt.mjs';
import { getWorkspaceInfo } from '../lib/workspace-root.mjs';

describe('architecture safety contracts', () => {
  it('publishes stable architecture contract versions and event names', () => {
    assert.equal(CONVERSATION_CONTRACT_VERSION, 1);
    assert.equal(PROVIDER_CONTRACT_VERSION, 1);
    assert.equal(RUN_EVENT_TYPES.TOOL_CALL, 'tool_call');
    assert.equal(RUN_EVENT_TYPES.TOOL_RESULT, 'tool_result');
    assert.equal(RUN_EVENT_TYPES.ASK_USER_PENDING, 'ask_user_pending');
    assert.equal(AGENT_EVENT_TYPES.SUBAGENT_DONE, 'subagent_done');
  });

  it('requires a brief progress sentence before tool calls unless silent mode is requested', () => {
    const system = buildSystemPrompt([], {});
    assert.match(system, /MUST write one brief progress sentence before any tool call/);
    assert.match(system, /Unless the user explicitly asks you to run silently or avoid commentary/);
  });

  it('forbids claiming external tool actions without structured tool calls', () => {
    const system = buildSystemPrompt([], {});
    assert.match(system, /Never claim that you opened, clicked, typed/);
    assert.match(system, /corresponding structured tool call/);
    assert.match(system, /do not narrate or simulate the action as completed/);
  });

  it('includes current workspace context in the model system prompt', () => {
    const info = getWorkspaceInfo();
    const system = buildSystemPrompt([], { model: 'test-model' });
    assert.match(system, /# Workspace/);
    assert.match(system, new RegExp(info.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(system, /Workspace file tools resolve relative paths from the current workspace root/);
    assert.match(system, /You are currently running as: test-model/);
  });

  it('tells models to grep known files before reading broad content', () => {
    const prompt = workspaceExplorationSystemPrompt();
    assert.match(prompt, /Known file but unknown line\/section/);
    assert.match(prompt, /grep with path set to that file before read_file/);
    assert.match(prompt, /grep is not only for broad repo search/);
  });

  it('requires current time lookup before other work when exact time is needed', () => {
    const system = buildSystemPrompt([], { tools: [currentTimeTool] });
    assert.match(system, /Use the system prompt date\/time for ordinary relative-date interpretation/);
    assert.match(system, /call it before any other tool or substantive work/);
    assert.match(system, /Do not search, browse, inspect files, or delegate until the current time has been established/);
  });

  it('asks models to prefer Mermaid for diagrams', () => {
    const system = buildSystemPrompt([], {});
    assert.match(system, /prefer Mermaid diagrams/);
    assert.match(system, /```mermaid code blocks/);
    assert.match(system, /flowcharts, sequence diagrams, state diagrams/);
    assert.match(system, /quote labels that contain brackets/);
    assert.match(system, /Do not HTML-escape operators inside Mermaid code fences/);
  });

  it('keeps tool scheduling strategy outside queryLoop', async () => {
    const calls = [
      { id: 'a1', name: 'delegate_task', input: {} },
      { id: 'a2', name: 'delegate_task', input: {} },
      { id: 'b1', name: 'calculator', input: {} },
    ];
    const marks = [];
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const iterator = executeToolCalls({
      calls,
      scheduler: defaultToolScheduler({
        tools: [{ name: 'delegate_task', capabilities: { executionMode: 'parallel_batch' } }],
      }),
      executeCall: async (call) => {
        marks.push(`${call.id}:start`);
        await wait(call.id === 'a1' ? 20 : 1);
        marks.push(`${call.id}:end`);
        return { id: call.id, name: call.name, isError: false, output: call.id, durationMs: 1 };
      },
      publishOutcome: (call, outcome) => ({
        type: RUN_EVENT_TYPES.TOOL_RESULT,
        id: call.id,
        name: call.name,
        isError: outcome.isError,
        output: outcome.output,
      }),
    });

    const events = [];
    let result = await iterator.next();
    while (!result.done) {
      events.push(result.value);
      result = await iterator.next();
    }

    assert.deepEqual(events.map(event => event.type), [
      RUN_EVENT_TYPES.TOOL_CALL,
      RUN_EVENT_TYPES.TOOL_CALL,
      RUN_EVENT_TYPES.TOOL_RESULT,
      RUN_EVENT_TYPES.TOOL_RESULT,
      RUN_EVENT_TYPES.TOOL_CALL,
      RUN_EVENT_TYPES.TOOL_RESULT,
    ]);
    assert.ok(marks.indexOf('a2:start') < marks.indexOf('a1:end'));
    assert.ok(marks.indexOf('b1:start') > marks.indexOf('a1:end'));
    assert.equal(result.value.aborted, false);
  });

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
    const originalResolve = CHAT_SERVICE_TEST_HOOKS.resolveRuntimeChannelConfig;
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let sawAbortedSignal = false;

    CHAT_SERVICE_TEST_HOOKS.resolveRuntimeChannelConfig = async () => ({
      channel: { id: 'test_channel' },
      requestModel: 'test-model',
      modelConfig: { id: 'test-model', capabilities: { imageInput: false }, unsupportedImagePolicy: { action: 'reject' } },
      cfg: { channels: [], vision: { defaultChannelId: null, defaultModelId: null } },
      channelConfig: {
        baseUrl: 'https://example.test/anthropic',
        apiKey: 'sk-test',
        model: 'test-model',
        maxTokens: 1024,
        maxTurns: 5,
        extraHeaders: {},
        tools: [],
      },
    });
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
      CHAT_SERVICE_TEST_HOOKS.resolveRuntimeChannelConfig = originalResolve;
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

  it('emits an error event when the provider turn fails', async () => {
    const originalStreamChat = CHAT_SERVICE_TEST_HOOKS.streamChat;
    const originalResolve = CHAT_SERVICE_TEST_HOOKS.resolveRuntimeChannelConfig;
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    CHAT_SERVICE_TEST_HOOKS.resolveRuntimeChannelConfig = async () => ({
      channel: { id: 'test_channel' },
      requestModel: 'test-model',
      modelConfig: { id: 'test-model', capabilities: { imageInput: false }, unsupportedImagePolicy: { action: 'reject' } },
      cfg: { channels: [], vision: { defaultChannelId: null, defaultModelId: null } },
      channelConfig: {
        baseUrl: 'https://example.test/anthropic',
        apiKey: 'sk-test',
        model: 'test-model',
        maxTokens: 1024,
        maxTurns: 5,
        extraHeaders: {},
        tools: [],
      },
    });
    CHAT_SERVICE_TEST_HOOKS.streamChat = async () => {
      throw new Error('The model emitted DSML tool-call markup as visible text');
    };

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

    try {
      await handleChatRequest({
        body: {
          runId: 'run_provider_error_event',
          message: 'hi',
        },
      }, res);
      await wait(30);

      const snapshot = getChatRunSnapshot('run_provider_error_event');
      assert.equal(snapshot.status, 'error');
      assert.match(snapshot.error, /DSML tool-call markup/);
      assert.ok(writes.some(chunk => chunk.includes('"type":"error"')));
    } finally {
      CHAT_SERVICE_TEST_HOOKS.streamChat = originalStreamChat;
      CHAT_SERVICE_TEST_HOOKS.resolveRuntimeChannelConfig = originalResolve;
    }
  });

  it('validates tool config patches', () => {
    assert.deepEqual(validateToolConfigPatch({ enabled: 1, timeoutMs: 3000 }), {
      enabled: true,
      timeoutMs: 3000,
    });
    assert.equal(validateToolConfigPatch({ timeoutMs: 310000 }).timeoutMs, 310000);
    assert.throws(
      () => validateToolConfigPatch({ timeoutMs: -1 }),
      SchemaValidationError,
    );
    assert.throws(
      () => validateToolConfigPatch({ timeoutMs: 310001 }),
      SchemaValidationError,
    );
  });

  it('validates configurable channel model objects and max turns', () => {
    const channel = validateChannelPayload({
      name: 'Test',
      baseUrl: 'https://example.test/anthropic',
      apiKey: 'sk-test',
      models: [{
        id: 'm',
        name: 'Model M',
        capabilities: { imageInput: true },
        unsupportedImagePolicy: { action: 'reject' },
      }],
      maxTokens: 1024,
      maxTurns: 12,
      extraHeaders: {},
      pricing: { models: {} },
    });

    assert.equal(channel.maxTurns, 12);
    assert.equal(channel.models[0].id, 'm');
    assert.equal(channel.models[0].capabilities.imageInput, true);
    assert.equal(channel.models[0].unsupportedImagePolicy.action, 'reject');
    assert.equal(channel.models[0].unsupportedImagePolicy.onVisionFailure, 'reject');
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
    assert.throws(
      () => validateChannelPayload({
        name: 'Bad Model',
        baseUrl: 'https://example.test/anthropic',
        models: ['m'],
      }),
      SchemaValidationError,
    );
  });

  it('validates generic vision providers and the MiniMax preset', () => {
    const provider = minimaxTokenPlanVisionProvider({
      apiKey: 'sk-cp-test',
      baseUrl: 'https://api.minimaxi.com/',
      timeoutMs: 120000,
    });
    const validated = validateVisionProviderPayload(provider);
    const vision = validateVisionConfig({
      defaultProviderId: provider.id,
      defaultFailureAction: 'remove_images',
    });

    assert.equal(validated.adapter, 'http_json');
    assert.equal(validated.config.url, 'https://api.minimaxi.com/v1/coding_plan/vlm');
    assert.equal(validated.config.timeoutMs, 120000);
    assert.equal(validated.config.response.successPath, 'base_resp.status_code');
    assert.equal(vision.defaultProviderId, 'minimax-token-plan-vlm');
    assert.equal(vision.defaultFailureAction, 'remove_images');
    assert.throws(
      () => validateVisionProviderPayload({ name: 'Bad', adapter: 'unknown', config: {} }),
      SchemaValidationError,
    );
  });

  it('seeds a usable DeepSeek channel and MiniMax vision provider for fresh installs', () => {
    const cfg = defaultConfig();

    assert.equal(cfg.activeChannelId, '911c406a');
    assert.equal(cfg.activeModel, 'deepseek-v4-flash');
    assert.equal(cfg.workspace.label, 'xwork');
    assert.equal(cfg.channels[0].id, '911c406a');
    assert.equal(cfg.channels[0].name, 'deepseek');
    assert.equal(cfg.channels[0].baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(cfg.channels[0].apiKey, '');
    assert.equal(cfg.channels[0].models[0].unsupportedImagePolicy.action, 'vision_to_text');
    assert.equal(cfg.vision.defaultProviderId, 'minimax-token-plan-vlm');
    assert.equal(cfg.vision.defaultFailureAction, 'ask_user');
    assert.equal(cfg.visionProviders[0].id, 'minimax-token-plan-vlm');
    assert.equal(cfg.visionProviders[0].adapter, 'http_json');
    assert.equal(cfg.visionProviders[0].config.auth.apiKey, '');
  });

  it('returns API keys in active state without masking', () => {
    const provider = minimaxTokenPlanVisionProvider({ apiKey: 'sk-minimax-plain' });
    const state = publicActiveState({
      activeChannelId: 'deepseek',
      activeModel: 'deepseek-v4-flash',
      channels: [{
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-deepseek-plain',
        models: [{ id: 'deepseek-v4-flash' }],
        pricing: { models: {} },
      }],
      visionProviders: [provider],
      vision: {
        defaultProviderId: provider.id,
        defaultFailureAction: 'reject',
      },
    });

    assert.equal(state.channels[0].apiKey, 'sk-deepseek-plain');
    assert.equal(state.visionProviders[0].config.auth.apiKey, 'sk-minimax-plain');
  });

  it('summarizes images through MiniMax VLM and turns API status failures into policy failures', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = null;
    const asset = await createImageAsset({
      filename: 'red.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAHl6u2QAAAABJRU5ErkJggg==',
    });

    globalThis.fetch = async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        content: '图片内容摘要：红色小图\n\n图片 OCR 文本：无',
        base_resp: { status_code: 0, status_msg: 'success' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'trace-id': 'trace_ok' },
      });
    };

    try {
      const projected = await projectImagesForModel([{
        role: 'user',
        content: [{ type: 'image', imageId: asset.id }],
      }], {
        modelConfig: {
          id: 'text-model',
          capabilities: { imageInput: false },
          unsupportedImagePolicy: { action: 'vision_to_text', onVisionFailure: 'reject' },
        },
        appConfig: {
          channels: [],
          visionProviders: [
            minimaxTokenPlanVisionProvider({
              apiKey: 'sk-cp-test',
              baseUrl: 'https://api.minimaxi.com',
              timeoutMs: 90000,
            }),
          ],
          vision: {
            defaultProviderId: 'minimax-token-plan-vlm',
            defaultFailureAction: 'reject',
          },
        },
        emit: () => {},
      });

      assert.match(requestBody.image_url, /^data:image\/png;base64,/);
      assert.match(projected[0].content[0].text, /红色小图/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('can remove images when MiniMax VLM returns a base_resp failure', async () => {
    const originalFetch = globalThis.fetch;
    const asset = await createImageAsset({
      filename: 'red-fail.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAHl6u2QAAAABJRU5ErkJggg==',
    });

    globalThis.fetch = async () => new Response(JSON.stringify({
      content: '',
      base_resp: { status_code: 1026, status_msg: 'input image sensitive' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'trace-id': 'trace_fail' },
    });

    try {
      const projected = await projectImagesForModel([{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', imageId: asset.id },
        ],
      }], {
        modelConfig: {
          id: 'text-model',
          capabilities: { imageInput: false },
          unsupportedImagePolicy: { action: 'vision_to_text', onVisionFailure: 'remove_images' },
        },
        appConfig: {
          channels: [],
          visionProviders: [
            minimaxTokenPlanVisionProvider({
              apiKey: 'sk-cp-test',
              baseUrl: 'https://api.minimaxi.com',
              timeoutMs: 90000,
            }),
          ],
          vision: {
            defaultProviderId: 'minimax-token-plan-vlm',
            defaultFailureAction: 'reject',
          },
        },
        emit: () => {},
      });

      assert.deepEqual(projected[0].content, [{ type: 'text', text: '看图' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('preserves projected user image blocks for Anthropic requests', () => {
    const messages = normalizeMessages([{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc',
          },
        },
        { type: 'text', text: '识别这张图' },
      ],
    }]);

    assert.equal(messages[0].content[0].type, 'image');
    assert.equal(messages[0].content[0].source.media_type, 'image/png');
    assert.equal(messages[0].content[1].text, '识别这张图');
  });

  it('turns leaked DSML web_search markup inside text into an explicit provider error', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const chunks = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before <||DSM' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'L||tool_calls>\n<||DSML||invoke name="web_search">' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hidden query</||DSML||invoke>\n</||DSML||tool_calls> after' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    globalThis.fetch = async () => ({
      ok: true,
      body: {
        getReader() {
          let index = 0;
          return {
            async read() {
              if (index >= chunks.length) return { done: true };
              return { done: false, value: encoder.encode(chunks[index++]) };
            },
          };
        },
      },
    });

    const deltas = [];
    let error = null;
    let result;
    try {
      result = await streamChat(
        { baseUrl: 'https://example.test', apiKey: 'sk-test', model: 'm', maxTokens: 1, tools: [] },
        [{ role: 'user', content: 'hi' }],
        (delta) => deltas.push(delta),
        () => {},
        () => {},
        (err) => { error = err; },
        () => {},
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(deltas.join(''), 'before  after');
    assert.match(error?.message || '', /DSML tool-call markup/);
    assert.equal(result.stopReason, 'error');
    assert.doesNotMatch(deltas.join(''), /DSML|tool_calls|web_search/);
  });

  it('turns an unexecuted full-width DSML-only tool call into an explicit provider error', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const chunks = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="web_search"><｜｜DSML｜｜parameter name="query" string="true">黄仁勋 台北 2026</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    globalThis.fetch = async () => ({
      ok: true,
      body: {
        getReader() {
          let index = 0;
          return {
            async read() {
              if (index >= chunks.length) return { done: true };
              return { done: false, value: encoder.encode(chunks[index++]) };
            },
          };
        },
      },
    });

    const deltas = [];
    let error = null;
    let result;
    try {
      result = await streamChat(
        { baseUrl: 'https://example.test', apiKey: 'sk-test', model: 'm', maxTokens: 1, tools: [] },
        [{ role: 'user', content: 'hi' }],
        (delta) => deltas.push(delta),
        () => {},
        () => {},
        (err) => { error = err; },
        () => {},
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(deltas.join(''), '');
    assert.match(error?.message || '', /DSML tool-call markup/);
    assert.match(error?.message || '', /web_search/);
    assert.equal(result.stopReason, 'error');
  });

  it('flushes normal streamed text when no DSML marker appears', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const chunks = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'short' } },
      { type: 'content_block_stop', index: 0 },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    globalThis.fetch = async () => ({
      ok: true,
      body: {
        getReader() {
          let index = 0;
          return {
            async read() {
              if (index >= chunks.length) return { done: true };
              return { done: false, value: encoder.encode(chunks[index++]) };
            },
          };
        },
      },
    });

    const deltas = [];
    let result;
    try {
      result = await streamChat(
        { baseUrl: 'https://example.test', apiKey: 'sk-test', model: 'm', maxTokens: 1, tools: [] },
        [{ role: 'user', content: 'hi' }],
        (delta) => deltas.push(delta),
        () => {},
        () => {},
        () => {},
        () => {},
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(deltas.join(''), 'short');
    assert.equal(result.text, 'short');
    assert.equal(result.content[0].text, 'short');
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

  it('replays stored assistant trace messages instead of display-only text history', () => {
    const stored = [
      { role: 'user', content: '打开页面并截图' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '已完成截图。' }],
        trace: {
          messages: [
            { role: 'user', content: '打开页面并截图' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: '我来截图。' },
                { type: 'tool_use', id: 'toolu_1', name: 'get_current_time', input: { timezone: 'local' } },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"screenshotUrl":"/shot.png"}' }],
            },
            { role: 'assistant', content: [{ type: 'text', text: '已完成截图。' }] },
          ],
        },
      },
      { role: 'user', content: '继续操作' },
    ];

    const replay = buildReplayHistory(stored);

    assert.equal(replay.length, 5);
    assert.equal(replay[1].content[1].type, 'tool_use');
    assert.equal(replay[2].content[0].type, 'tool_result');
    assert.equal(replay[3].content[0].text, '已完成截图。');
    assert.equal(replay[4].content, '继续操作');
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

describe('tool runtime-definition plugin contract', () => {
  const experts = [
    { id: 'xwork_backend', title: 'Backend Expert', selectionPrompt: 'backend risk', description: '' },
    { id: 'general_task_agent', title: 'General Task Agent', selectionPrompt: '', description: 'default expert' },
  ];

  it('delegate_task injects the expert catalog via its own resolveDefinition hook', () => {
    assert.deepEqual(delegateTaskTool.runtimeContext, ['expertAgents']);
    assert.equal(typeof delegateTaskTool.resolveDefinition, 'function');

    const base = {
      name: delegateTaskTool.name,
      description: delegateTaskTool.description,
      inputSchema: delegateTaskTool.inputSchema,
    };
    const resolved = delegateTaskTool.resolveDefinition(base, { expertAgents: experts });

    // catalog appended to description
    assert.ok(resolved.description.includes('\n\nAvailable expert agents:\n- xwork_backend: Backend Expert — backend risk'));
    // expertAgentId enum injected from live expert ids
    assert.deepEqual(resolved.inputSchema.properties.expertAgentId.enum, ['xwork_backend', 'general_task_agent']);
    // expertAgents carried through for systemPrompt(tool) to render the catalog
    assert.deepEqual(resolved.expertAgents, experts);
    // the tool's own static inputSchema must not be mutated (deep-copied)
    assert.equal(delegateTaskTool.inputSchema.properties.expertAgentId.enum, undefined);
  });

  it('resolved definition is byte-stable through anthropicTools (preserves prefix cache)', () => {
    // Replicate the previously-hardcoded registry logic byte-for-byte and assert
    // the API-facing tool definition serializes identically after the refactor.
    const oldDescription = (() => {
      const lines = experts.map(a => {
        const p = a.selectionPrompt || a.description || '';
        return `- ${a.id}: ${a.title}${p ? ` — ${p}` : ''}`;
      });
      return `${delegateTaskTool.description}\n\nAvailable expert agents:\n${lines.join('\n')}`;
    })();
    const oldSchema = (() => {
      const i = JSON.parse(JSON.stringify(delegateTaskTool.inputSchema));
      i.properties = i.properties || {};
      i.properties.expertAgentId = {
        type: 'string',
        description: 'Expert agent profile to use for this delegated objective. Choose the best id from the available expert agents listed in the system prompt. Omit only when the default general expert is the best fit.',
        enum: experts.map(a => a.id),
      };
      return i;
    })();
    const oldDef = { name: delegateTaskTool.name, description: oldDescription, inputSchema: oldSchema, adapter: delegateTaskTool.adapter };

    const newDef = delegateTaskTool.resolveDefinition({
      name: delegateTaskTool.name,
      description: delegateTaskTool.description,
      inputSchema: delegateTaskTool.inputSchema,
      adapter: delegateTaskTool.adapter,
    }, { expertAgents: experts });

    assert.equal(
      JSON.stringify(anthropicTools([newDef])),
      JSON.stringify(anthropicTools([oldDef])),
    );
  });

  it('tools without resolveDefinition keep their definition unchanged', () => {
    assert.equal(currentTimeTool.resolveDefinition, undefined);
    assert.equal(currentTimeTool.runtimeContext, undefined);
  });
});
