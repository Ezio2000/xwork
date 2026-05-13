import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { queryLoop } from '../lib/query-loop.mjs';

// ---------------------------------------------------------------------------
// Test helpers — mock factories
// ---------------------------------------------------------------------------

function fakeStreamChatThatReturns(result) {
  return async (_config, _messages, onDelta, onThinkingDelta, onDone, onError, onServerToolEvent) => {
    // Simulate streaming: flush accumulated text as deltas
    const text = result.text || '';
    const reasoning = result.reasoningContent || '';

    if (text) {
      // Emit word-by-word for realism
      const words = text.split(/(?<=\s)/);
      for (const word of words) {
        onDelta(word);
      }
    }
    if (reasoning) {
      onThinkingDelta(reasoning);
    }

    // Simulate server tool events
    for (const evt of result.serverToolEvents || []) {
      onServerToolEvent(evt);
    }

    onDone(text, result.stopReason || 'end_turn', result.usage || null);
    return {
      text,
      reasoningContent: reasoning,
      content: result.content || (text ? [{ type: 'text', text }] : []),
      stopReason: result.stopReason || 'end_turn',
      usage: result.usage || null,
      toolCalls: result.toolCalls || [],
      serverToolEvents: result.serverToolEvents || [],
    };
  };
}

function fakeStreamChatThatErrors(msg) {
  return async (_config, _messages, _onDelta, _onThinkingDelta, _onDone, onError, _onServerToolEvent) => {
    throw new Error(msg);
  };
}

function fakeRunTool(results) {
  let idx = 0;
  return async (_call, _context) => {
    const r = results[idx++] || {
      id: _call.id,
      name: _call.name,
      isError: true,
      output: 'no mock result configured',
      durationMs: 1,
    };
    return { ...r, id: _call.id, name: _call.name, durationMs: r.durationMs ?? 5 };
  };
}

function fakeRunToolThatErrors(msg) {
  return async (_call, _context) => {
    throw new Error(msg);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queryLoop', () => {
  let events;
  let returnValue;
  let onDeltaCalls;
  let onThinkingCalls;
  let onServerToolCalls;

  const baseConfig = { baseUrl: 'https://test.api', apiKey: 'sk-test', model: 'test-model', maxTokens: 1024, tools: [] };
  const baseHistory = [{ role: 'user', content: 'hello' }];

  // Helper: drain the generator and collect results
  async function drain(iterator) {
    events = [];
    onDeltaCalls = [];
    onThinkingCalls = [];
    onServerToolCalls = [];
    let r = await iterator.next();
    while (!r.done) {
      events.push(r.value);
      r = await iterator.next();
    }
    returnValue = r.value;
  }

  // =========================================================================
  // 1. 纯文本响应 — 无工具调用
  // =========================================================================
  describe('纯文本响应 (no tools)', () => {
    it('should complete with reason=completed and accumulate text', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: '你好，我是 AI 助手。',
        content: [{ type: 'text', text: '你好，我是 AI 助手。' }],
      });

      const iterator = queryLoop({
        config: baseConfig,
        history: baseHistory,
        streamChat,
        runTool: fakeRunTool([]),
        onDelta: (d) => onDeltaCalls.push(d),
      });

      await drain(iterator);

      assert.equal(returnValue.reason, 'completed');
      assert.ok(returnValue.text.includes('你好，我是 AI 助手。'));
      assert.equal(returnValue.messages.length, 2); // user + assistant
      assert.equal(events.length, 0); // no tool events yielded
      assert.ok(onDeltaCalls.length > 0, 'onDelta should have been called');
    });

    it('should produce correct final messages (user + assistant)', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'OK',
        content: [{ type: 'text', text: 'OK' }],
      });

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      const msgs = returnValue.messages;
      assert.equal(msgs[0].role, 'user');
      assert.equal(msgs[1].role, 'assistant');
      assert.equal(msgs[1].content[0].type, 'text');
    });
  });

  // =========================================================================
  // 2. 单工具调用 — 仅一轮工具
  // =========================================================================
  describe('单工具调用 (one round)', () => {
    it('should yield tool_call then tool_result, then complete', async () => {
      let callCount = 0;
      const streamChat = async (...args) => {
        callCount++;
        if (callCount === 1) {
          return (fakeStreamChatThatReturns({
            text: '让我查一下时间。',
            content: [
              { type: 'text', text: '让我查一下时间。' },
              { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'Asia/Shanghai' } },
            ],
            toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'Asia/Shanghai' } }],
          }))(...args);
        }
        return (fakeStreamChatThatReturns({
          text: '现在是 2026-05-14 15:30:00。',
          content: [{ type: 'text', text: '现在是 2026-05-14 15:30:00。' }],
          toolCalls: [],
        }))(...args);
      };

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: '2026-05-14 15:30:00', durationMs: 5 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool });
      await drain(iterator);

      assert.equal(callCount, 2, 'should make 2 API calls');
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'tool_call');
      assert.equal(events[0].name, 'get_current_time');
      assert.deepEqual(events[0].input, { timezone: 'Asia/Shanghai' });
      assert.equal(events[1].type, 'tool_result');
      assert.equal(events[1].id, 'toolu_01');
      assert.equal(events[1].isError, false);

      assert.equal(returnValue.reason, 'completed');
      // Messages: user, assistant (with text + tool_use), user (tool_result), assistant (final)
      assert.equal(returnValue.messages.length, 4);
    });
  });

  // =========================================================================
  // 3. 同一轮多个工具调用
  // =========================================================================
  describe('同一轮多个工具调用 (multiple tools in one turn)', () => {
    it('should execute each tool sequentially and yield all results', async () => {
      let callCount = 0;
      const streamChat = async (...args) => {
        callCount++;
        if (callCount === 1) {
          return (fakeStreamChatThatReturns({
            text: '查两个时区。',
            content: [
              { type: 'text', text: '查两个时区。' },
              { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'Asia/Shanghai' } },
              { type: 'tool_use', id: 'toolu_02', name: 'get_current_time', input: { timezone: 'America/New_York' } },
            ],
            toolCalls: [
              { id: 'toolu_01', name: 'get_current_time', input: { timezone: 'Asia/Shanghai' } },
              { id: 'toolu_02', name: 'get_current_time', input: { timezone: 'America/New_York' } },
            ],
          }))(...args);
        }
        return (fakeStreamChatThatReturns({
          text: 'Done',
          content: [{ type: 'text', text: 'Done' }],
          toolCalls: [],
        }))(...args);
      };

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: '15:30 CST', durationMs: 3 },
        { id: 'toolu_02', name: 'get_current_time', isError: false, output: '03:30 EST', durationMs: 4 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool });
      await drain(iterator);

      assert.equal(events.length, 4); // 2 calls + 2 results
      // All tool_calls yielded first, then all tool_results (matches stream order)
      assert.equal(events[0].type, 'tool_call');
      assert.equal(events[0].name, 'get_current_time');
      assert.equal(events[1].type, 'tool_call');
      assert.equal(events[1].name, 'get_current_time');
      assert.equal(events[2].type, 'tool_result');
      assert.equal(events[3].type, 'tool_result');
      assert.equal(returnValue.reason, 'completed');
    });
  });

  // =========================================================================
  // 4. 多轮对话 — 工具结果触发第二轮 AI 调用
  // =========================================================================
  describe('多轮对话 (multi-turn)', () => {
    it('should loop again when tool results trigger follow-up tool calls', async () => {
      let callCount = 0;
      const multiTurnStreamChat = async (_config, messages, onDelta, onThinkingDelta, onDone, onError, onServerToolEvent) => {
        callCount++;
        if (callCount === 1) {
          // Round 1: call tool
          const result = {
            text: 'Round 1 text.',
            content: [
              { type: 'text', text: 'Round 1 text.' },
              { type: 'tool_use', id: 'toolu_r1', name: 'get_current_time', input: { timezone: 'UTC' } },
            ],
            toolCalls: [{ id: 'toolu_r1', name: 'get_current_time', input: { timezone: 'UTC' } }],
          };
          onDelta('Round 1 text.');
          onDone('Round 1 text.', 'tool_use', null);
          return result;
        }
        // Round 2: final text response (no more tools)
        const result = {
          text: '最终答案。',
          content: [{ type: 'text', text: '最终答案。' }],
          toolCalls: [],
        };
        onDelta('最终答案。');
        onDone('最终答案。', 'end_turn', null);
        return result;
      };

      const runTool = fakeRunTool([
        { id: 'toolu_r1', name: 'get_current_time', isError: false, output: '2026-05-14 12:00 UTC', durationMs: 3 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat: multiTurnStreamChat, runTool });
      await drain(iterator);

      assert.equal(callCount, 2, 'should have made 2 API calls');
      assert.equal(events.length, 2); // 1 tool_call + 1 tool_result
      assert.equal(returnValue.reason, 'completed');
      assert.ok(returnValue.text.includes('最终答案'));
    });

    it('should handle 3 rounds of tool calls', async () => {
      let callCount = 0;
      const multiTurnStreamChat = async (_config, _messages, onDelta, _onThinkingDelta, onDone, _onError, _onServerToolEvent) => {
        callCount++;
        if (callCount <= 2) {
          onDelta(`Round ${callCount} text.`);
          const result = {
            text: `Round ${callCount} text.`,
            content: [
              { type: 'text', text: `Round ${callCount} text.` },
              { type: 'tool_use', id: `toolu_r${callCount}`, name: 'get_current_time', input: { timezone: 'UTC' } },
            ],
            toolCalls: [{ id: `toolu_r${callCount}`, name: 'get_current_time', input: { timezone: 'UTC' } }],
          };
          onDone(`Round ${callCount} text.`, 'tool_use', null);
          return result;
        }
        onDelta('Done.');
        onDone('Done.', 'end_turn', null);
        return { text: 'Done.', content: [{ type: 'text', text: 'Done.' }], toolCalls: [] };
      };

      const runTool = fakeRunTool([
        { id: 'toolu_r1', name: 'get_current_time', isError: false, output: 't1', durationMs: 1 },
        { id: 'toolu_r2', name: 'get_current_time', isError: false, output: 't2', durationMs: 1 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat: multiTurnStreamChat, runTool });
      await drain(iterator);

      assert.equal(callCount, 3);
      assert.equal(events.length, 4); // 2 calls + 2 results
      assert.equal(returnValue.reason, 'completed');
    });
  });

  // =========================================================================
  // 5. maxTurns 限制
  // =========================================================================
  describe('maxTurns 限制', () => {
    it('should stop with reason=max_turns when limit is reached', async () => {
      let callCount = 0;
      const alwaysToolStreamChat = async (_config, _messages, onDelta, _onThinking, onDone) => {
        callCount++;
        onDelta('calling...');
        const result = {
          text: 'calling...',
          content: [
            { type: 'text', text: 'calling...' },
            { type: 'tool_use', id: `toolu_${callCount}`, name: 'get_current_time', input: { timezone: 'UTC' } },
          ],
          toolCalls: [{ id: `toolu_${callCount}`, name: 'get_current_time', input: { timezone: 'UTC' } }],
        };
        onDone('calling...', 'tool_use', null);
        return result;
      };

      const outputs = ['t1', 't2', 't3'];
      const runTool = fakeRunTool(outputs.map((o, i) => ({ id: `toolu_${i + 1}`, name: 'get_current_time', isError: false, output: o, durationMs: 1 })));

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, maxTurns: 2, streamChat: alwaysToolStreamChat, runTool });
      await drain(iterator);

      assert.equal(callCount, 2, 'should stop after 2 API calls');
      assert.equal(returnValue.reason, 'max_turns');
    });

    it('should respect custom maxTurns=1 (no tool execution)', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: '你好',
        content: [{ type: 'text', text: '你好' }],
        toolCalls: [
          { id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
        ],
      });

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: 'time', durationMs: 1 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, maxTurns: 1, streamChat, runTool });
      await drain(iterator);

      assert.equal(returnValue.reason, 'max_turns');
    });
  });

  // =========================================================================
  // 6. Abort 中断
  // =========================================================================
  describe('Abort 中断', () => {
    it('should stop with reason=aborted when signal fires during tool execution', async () => {
      const ac = new AbortController();
      let toolExecuted = false;

      const streamChat = fakeStreamChatThatReturns({
        text: 'calling...',
        content: [
          { type: 'text', text: 'calling...' },
          { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
        ],
        toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } }],
      });

      const runTool = async (call, _ctx) => {
        toolExecuted = true;
        ac.abort(); // abort during first tool
        return { id: call.id, name: call.name, isError: false, output: 'time', durationMs: 5 };
      };

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, signal: ac.signal, streamChat, runTool });
      await drain(iterator);

      assert.equal(toolExecuted, true);
      assert.equal(returnValue.reason, 'aborted');
    });

    it('should abort before first API call if signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();

      let apiCalled = false;
      const streamChat = async (...args) => {
        apiCalled = true;
        return fakeStreamChatThatReturns({ text: 'x', content: [{ type: 'text', text: 'x' }] })(...args);
      };

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, signal: ac.signal, streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      assert.equal(apiCalled, false);
      assert.equal(returnValue.reason, 'aborted');
    });
  });

  // =========================================================================
  // 7. 工具执行错误
  // =========================================================================
  describe('工具执行错误 (tool error)', () => {
    it('should yield tool_result with isError=true and continue', async () => {
      let apiCallCount = 0;
      const streamChat = async (_config, _messages, onDelta, _onThink, onDone) => {
        apiCallCount++;
        if (apiCallCount === 1) {
          onDelta('calling...');
          onDone('calling...', 'tool_use', null);
          return {
            text: 'calling...',
            content: [
              { type: 'text', text: 'calling...' },
              { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
            ],
            toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } }],
          };
        }
        onDelta('all done');
        onDone('all done', 'end_turn', null);
        return { text: 'all done', content: [{ type: 'text', text: 'all done' }], toolCalls: [] };
      };

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: true, output: 'Invalid timezone: bad/timezone', durationMs: 2 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool });
      await drain(iterator);

      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'tool_call');
      assert.equal(events[1].type, 'tool_result');
      assert.equal(events[1].isError, true);
      assert.ok(events[1].output.includes('Invalid timezone'));

      // Should have continued to round 2 (error doesn't stop the loop)
      assert.equal(apiCallCount, 2);
      assert.equal(returnValue.reason, 'completed');
    });
  });

  // =========================================================================
  // 8. API 错误
  // =========================================================================
  describe('API 错误 (API error)', () => {
    it('should return reason=api_error with error message', async () => {
      const streamChat = fakeStreamChatThatErrors('Network timeout');

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      assert.equal(returnValue.reason, 'api_error');
      assert.ok(returnValue.error.includes('Network timeout'));
    });

    it('should handle API returning 4xx with useful message', async () => {
      const streamChat = fakeStreamChatThatErrors('API error 401: Invalid API key');

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      assert.equal(returnValue.reason, 'api_error');
    });
  });

  // =========================================================================
  // 9. 混合 server 工具和本地工具
  // =========================================================================
  describe('混合 server 工具 + 本地工具 (web_search + get_current_time)', () => {
    it('should handle server tool events via callback and local tool calls via yield', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: '先搜一下。',
        content: [
          { type: 'text', text: '先搜一下。' },
          { type: 'server_tool_use', id: 'stu_01', name: 'web_search', input: { query: 'test' } },
        ],
        toolCalls: [], // web_search is server-side, no local tool call needed
        serverToolEvents: [
          { phase: 'call', id: 'stu_01', name: 'web_search', input: { query: 'test' } },
          { phase: 'result', id: 'stu_01', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: 'Test', url: 'https://test.com' }] } },
        ],
      });

      const iterator = queryLoop({
        config: baseConfig,
        history: baseHistory,
        streamChat,
        runTool: fakeRunTool([]),
        onServerToolEvent: (evt) => onServerToolCalls.push(evt),
      });
      await drain(iterator);

      assert.equal(onServerToolCalls.length, 2);
      assert.equal(onServerToolCalls[0].phase, 'call');
      assert.equal(onServerToolCalls[1].phase, 'result');
      assert.equal(events.length, 0); // no local tool events yielded
      assert.equal(returnValue.reason, 'completed');
    });

    it('should handle mixed: server tool first, then local tool in same turn', async () => {
      let callCount = 0;
      const streamChat = async (...args) => {
        callCount++;
        if (callCount === 1) {
          return (fakeStreamChatThatReturns({
            text: '搜索后检查时间。',
            content: [
              { type: 'text', text: '搜索后检查时间。' },
              { type: 'server_tool_use', id: 'stu_01', name: 'web_search', input: { query: 'today' } },
              { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
            ],
            toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } }],
            serverToolEvents: [
              { phase: 'call', id: 'stu_01', name: 'web_search', input: { query: 'today' } },
              { phase: 'result', id: 'stu_01', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [] } },
            ],
          }))(...args);
        }
        return (fakeStreamChatThatReturns({
          text: 'Done',
          content: [{ type: 'text', text: 'Done' }],
          toolCalls: [],
        }))(...args);
      };

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: '12:00 UTC', durationMs: 2 },
      ]);

      const iterator = queryLoop({
        config: baseConfig,
        history: baseHistory,
        streamChat,
        runTool,
        onServerToolEvent: (evt) => onServerToolCalls.push(evt),
      });
      await drain(iterator);

      // Server events go to callback
      assert.equal(onServerToolCalls.length, 2);
      // Local tool events are yielded
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'tool_call');
      assert.equal(events[1].type, 'tool_result');
    });
  });

  // =========================================================================
  // 10. onDelta / onThinkingDelta 回调覆盖
  // =========================================================================
  describe('流式回调 (streaming callbacks)', () => {
    it('should call onDelta for each chunk of text', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'Hello world! How are you?',
        content: [{ type: 'text', text: 'Hello world! How are you?' }],
      });

      const iterator = queryLoop({
        config: baseConfig,
        history: baseHistory,
        streamChat,
        runTool: fakeRunTool([]),
        onDelta: (d) => onDeltaCalls.push(d),
      });
      await drain(iterator);

      assert.ok(onDeltaCalls.length > 0);
      assert.equal(onDeltaCalls.join(''), 'Hello world! How are you?');
    });

    it('should call onThinkingDelta for reasoning content', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'Answer',
        reasoningContent: 'I need to think about this carefully.',
        content: [{ type: 'text', text: 'Answer' }],
      });

      const iterator = queryLoop({
        config: baseConfig,
        history: baseHistory,
        streamChat,
        runTool: fakeRunTool([]),
        onThinkingDelta: (t) => onThinkingCalls.push(t),
      });
      await drain(iterator);

      assert.equal(onThinkingCalls.length, 1);
      assert.ok(onThinkingCalls[0].includes('I need to think'));
    });

    it('should work without any streaming callbacks (graceful no-op)', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'Hello',
        content: [{ type: 'text', text: 'Hello' }],
      });

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      assert.equal(returnValue.reason, 'completed');
    });
  });

  // =========================================================================
  // 11. toolContext 传递
  // =========================================================================
  describe('toolContext 传递', () => {
    it('should pass toolContext to every runTool invocation', async () => {
      const ctx = { conversationId: 'abc', channelId: 'ch1', model: 'm1' };
      const receivedCtxs = [];

      let callCount = 0;
      const streamChat = async (...args) => {
        callCount++;
        if (callCount === 1) {
          return (fakeStreamChatThatReturns({
            text: 'call',
            content: [
              { type: 'text', text: 'call' },
              { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
            ],
            toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } }],
          }))(...args);
        }
        return (fakeStreamChatThatReturns({
          text: 'Done',
          content: [{ type: 'text', text: 'Done' }],
          toolCalls: [],
        }))(...args);
      };

      const runTool = async (call, context) => {
        receivedCtxs.push({ ...context });
        return { id: call.id, name: call.name, isError: false, output: 'ok', durationMs: 1 };
      };

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool, toolContext: ctx });
      await drain(iterator);

      assert.equal(receivedCtxs.length, 1);
      assert.deepEqual(receivedCtxs[0], ctx);
    });
  });

  // =========================================================================
  // 12. 空消息历史 / 边界情况
  // =========================================================================
  describe('边界情况', () => {
    it('should work with empty history (only new user message)', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'Hi there',
        content: [{ type: 'text', text: 'Hi there' }],
      });

      const iterator = queryLoop({ config: baseConfig, history: [{ role: 'user', content: 'Hi' }], streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      assert.equal(returnValue.messages[0].role, 'user');
      assert.equal(returnValue.reason, 'completed');
    });

    it('should handle tool with no input', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: '',
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: {} },
        ],
        toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: {} }],
      });

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: 'now', durationMs: 1 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool });
      await drain(iterator);

      assert.equal(events[0].type, 'tool_call');
      assert.deepEqual(events[0].input, {});
    });

    it('should handle streamChat returning undefined content gracefully', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'ok',
      });

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool: fakeRunTool([]) });
      await drain(iterator);

      assert.equal(returnValue.reason, 'completed');
      // Assistant message should have been built from text fallback
      const assistant = returnValue.messages.at(-1);
      assert.equal(assistant.role, 'assistant');
    });

    it('should accumulate text across multiple rounds', async () => {
      let round = 0;
      const streamChat = async (_c, _m, onDelta, _td, onDone) => {
        round++;
        if (round === 1) {
          onDelta('First ');
          onDone('First ', 'tool_use', null);
          return {
            text: 'First ',
            content: [
              { type: 'text', text: 'First ' },
              { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
            ],
            toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } }],
          };
        }
        onDelta('Second');
        onDone('Second', 'end_turn', null);
        return { text: 'Second', content: [{ type: 'text', text: 'Second' }], toolCalls: [] };
      };

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: 'time', durationMs: 1 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool });
      await drain(iterator);

      assert.ok(returnValue.text.includes('First'));
      assert.ok(returnValue.text.includes('Second'));
    });
  });

  // =========================================================================
  // 13. 复杂真实对话模拟
  // =========================================================================
  describe('复杂真实对话模拟', () => {
    it('模拟: 用户问天气 → 搜索 → 查询时间 → 综合回答', async () => {
      const initialHistory = [
        { role: 'user', content: '今天上海天气怎么样？' },
      ];
      let turn = 0;

      const realChat = async (_config, messages, onDelta, _onThink, onDone, _onErr, onServerEvt) => {
        turn++;
        // The system message for date/time is prepended by streamChat's buildSystemPrompt
        if (turn === 1) {
          // Round 1: AI decides to search and check time
          onDelta('让我查一下今天的天气和当前时间。');
          onServerEvt?.({ phase: 'call', id: 'stu_01', name: 'web_search', input: { query: '上海天气 2026-05-14' } });
          onServerEvt?.({ phase: 'result', id: 'stu_01', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: '上海天气', url: 'https://weather.com/sh', snippet: '上海今日多云, 20-28°C' }] } });
          onDone('让我查一下今天的天气和当前时间。', 'tool_use', null);
          return {
            text: '让我查一下今天的天气和当前时间。',
            content: [
              { type: 'text', text: '让我查一下今天的天气和当前时间。' },
              { type: 'server_tool_use', id: 'stu_01', name: 'web_search', input: { query: '上海天气 2026-05-14' } },
              { type: 'tool_use', id: 'toolu_t1', name: 'get_current_time', input: { timezone: 'Asia/Shanghai' } },
            ],
            toolCalls: [{ id: 'toolu_t1', name: 'get_current_time', input: { timezone: 'Asia/Shanghai' } }],
            serverToolEvents: [
              { phase: 'call', id: 'stu_01', name: 'web_search', input: { query: '上海天气 2026-05-14' } },
              { phase: 'result', id: 'stu_01', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: '上海天气', url: 'https://weather.com/sh', snippet: '上海今日多云, 20-28°C' }] } },
            ],
          };
        }
        // Round 2: Final answer
        onDelta('根据搜索结果和当前时间，上海今天（2026年5月14日）多云，气温20-28°C。');
        onDone('根据搜索结果和当前时间，上海今天多云，气温20-28°C。', 'end_turn', { input_tokens: 500, output_tokens: 100 });
        return {
          text: '根据搜索结果和当前时间，上海今天（2026年5月14日）多云，气温20-28°C。',
          content: [{ type: 'text', text: '根据搜索结果和当前时间，上海今天多云，气温20-28°C。' }],
          toolCalls: [],
          usage: { input_tokens: 500, output_tokens: 100 },
        };
      };

      const runTool = fakeRunTool([
        { id: 'toolu_t1', name: 'get_current_time', isError: false, output: JSON.stringify({ timezone: 'Asia/Shanghai', currentTime: '2026/5/14 15:30:00' }), durationMs: 3 },
      ]);

      const serverToolEvents = [];
      const iterator = queryLoop({
        config: baseConfig,
        history: initialHistory,
        maxTurns: 5,
        streamChat: realChat,
        runTool,
        onServerToolEvent: (e) => serverToolEvents.push(e),
      });
      await drain(iterator);

      // Verify full flow
      assert.equal(turn, 2, '应该有 2 轮 API 调用');
      assert.equal(serverToolEvents.length, 2, '有 2 个 server tool 事件');
      assert.equal(events.length, 2, '有 2 个 local tool 事件'); // tool_call + tool_result
      assert.equal(events[0].type, 'tool_call');
      assert.equal(events[0].name, 'get_current_time');
      assert.equal(events[1].type, 'tool_result');
      assert.equal(returnValue.reason, 'completed');
      assert.ok(returnValue.text.includes('多云'));
      assert.ok(returnValue.text.includes('20-28°C'));
      assert.equal(returnValue.usage?.input_tokens, 500);

      // Final messages structure:
      // 1. user: "今天上海天气怎么样？"
      // 2. assistant: 第一轮 text + server_tool_use + tool_use
      // 3. user: tool_result (get_current_time)
      // 4. assistant: 最终回答
      assert.equal(returnValue.messages.length, 4);
    });

    it('模拟: 代码调试 → 查文档 → 多次搜索', async () => {
      let turn = 0;
      const chat = async (_c, _m, onDelta, _td, onDone, _err, onServerEvt) => {
        turn++;
        if (turn === 1) {
          onDelta('让我搜索一下这个错误信息。');
          onServerEvt?.({ phase: 'call', id: 'stu_01', name: 'web_search', input: { query: 'TypeError: Cannot read properties of undefined' } });
          onServerEvt?.({ phase: 'result', id: 'stu_01', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: 'StackOverflow', url: 'https://so.com/q', snippet: 'Check if variable is defined...' }] } });
          onDone('让我搜索一下这个错误信息。', 'tool_use', null);
          return {
            text: '让我搜索一下这个错误信息。',
            content: [
              { type: 'text', text: '让我搜索一下这个错误信息。' },
              { type: 'server_tool_use', id: 'stu_01', name: 'web_search', input: { query: 'TypeError: Cannot read properties of undefined' } },
            ],
            toolCalls: [], // Only server-side tools in round 1
            serverToolEvents: [
              { phase: 'call', id: 'stu_01', name: 'web_search', input: { query: 'TypeError: Cannot read properties of undefined' } },
              { phase: 'result', id: 'stu_01', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: 'StackOverflow', url: 'https://so.com/q', snippet: 'Check...' }] } },
            ],
          };
        }
        // Round 2: Refined search
        onDelta('让我搜索更具体的解决方案。');
        onServerEvt?.({ phase: 'call', id: 'stu_02', name: 'web_search', input: { query: 'JavaScript optional chaining undefined fix' } });
        onServerEvt?.({ phase: 'result', id: 'stu_02', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: 'MDN', url: 'https://mdn.io', snippet: 'Optional chaining ?.' }] } });
        onDone('让我搜索更具体的解决方案。', 'tool_use', null);
        return {
          text: '让我搜索更具体的解决方案。',
          content: [
            { type: 'text', text: '让我搜索更具体的解决方案。' },
            { type: 'server_tool_use', id: 'stu_02', name: 'web_search', input: { query: 'JavaScript optional chaining undefined fix' } },
          ],
          toolCalls: [],
          serverToolEvents: [
            { phase: 'call', id: 'stu_02', name: 'web_search', input: { query: 'JavaScript optional chaining undefined fix' } },
            { phase: 'result', id: 'stu_02', name: 'web_search', isError: false, renderType: 'source-cards', data: { sources: [{ title: 'MDN', url: 'https://mdn.io', snippet: 'Optional chaining ?.' }] } },
          ],
        };

        // Note: because round 1 has no local toolCalls, the loop would return after round 1.
        // So this test scenario only has local tools OR server tools in each round.
        // If there are no local toolCalls at all, the loop returns immediately.
      };

      const serverToolEvents = [];
      const iterator = queryLoop({
        config: baseConfig,
        history: [{ role: 'user', content: '我的代码报 TypeError: Cannot read properties of undefined' }],
        streamChat: chat,
        runTool: fakeRunTool([]),
        onServerToolEvent: (e) => serverToolEvents.push(e),
      });
      await drain(iterator);

      // No local tool calls means single round
      assert.equal(turn, 1);
      assert.equal(serverToolEvents.length, 2);
      assert.equal(returnValue.reason, 'completed');
    });
  });

  // =========================================================================
  // 14. 消息构建验证
  // =========================================================================
  describe('消息构建验证', () => {
    it('tool_result message should use formatToolOutput (JSON-stringify objects)', async () => {
      const streamChat = fakeStreamChatThatReturns({
        text: 'time',
        content: [
          { type: 'text', text: 'time' },
          { type: 'tool_use', id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } },
        ],
        toolCalls: [{ id: 'toolu_01', name: 'get_current_time', input: { timezone: 'UTC' } }],
      });

      const runTool = fakeRunTool([
        { id: 'toolu_01', name: 'get_current_time', isError: false, output: { timezone: 'UTC', currentTime: '12:00' }, durationMs: 1 },
      ]);

      const iterator = queryLoop({ config: baseConfig, history: baseHistory, streamChat, runTool });
      await drain(iterator);

      // Find the tool_result message
      const toolResultMsg = returnValue.messages.find(m =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      );
      assert.ok(toolResultMsg, 'should have a tool_result message');
      assert.equal(toolResultMsg.content[0].tool_use_id, 'toolu_01');
      // formatToolOutput should JSON-stringify objects
      assert.equal(typeof toolResultMsg.content[0].content, 'string');
      assert.ok(toolResultMsg.content[0].content.includes('currentTime'));
    });
  });
});
