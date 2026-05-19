const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3137';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180000);

function safeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

function parseSseLines(buffer) {
  const lines = buffer.split('\n');
  return { lines: lines.slice(0, -1), rest: lines.at(-1) || '' };
}

function summarizeEvents(events) {
  const byType = {};
  const toolCalls = [];
  const toolResults = [];
  const agentEvents = [];

  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    if (event.type === 'tool_call') {
      for (const tool of event.tools || []) toolCalls.push({ id: tool.id, name: tool.name });
    }
    if (event.type === 'tool_result') {
      for (const tool of event.tools || []) {
        toolResults.push({
          id: tool.id,
          name: tool.name,
          isError: tool.isError,
          renderType: tool.renderType || null,
          durationMs: tool.durationMs,
        });
      }
    }
    if (event.type === 'agent_event') {
      agentEvents.push({
        runId: event.runId,
        eventType: event.eventType || event.event || null,
        status: event.status || null,
        label: event.label || null,
      });
    }
  }

  return { byType, toolCalls, toolResults, agentEvents };
}

async function readChatSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let terminal = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseLines(buffer);
    buffer = parsed.rest;

    for (const line of parsed.lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      events.push(event);
      if (event.type === 'done' || event.type === 'error') terminal = event;
    }
  }

  return { events, terminal, summary: summarizeEvents(events) };
}

async function run() {
  const startedAt = Date.now();
  const active = await api('GET', '/api/v1/active');
  if (!active.activeChannelId) throw new Error('No active channel configured');

  const title = `E2E complex ${new Date().toISOString()}`;
  const conversation = await api('POST', '/api/v1/conversations', { title });
  const runId = safeId('e2e_complex');

  const message = [
    '这是一次端到端复杂链路测试，请用中文完成，结果尽量精炼。',
    '',
    '请实际使用可用工具完成这些步骤：',
    '1. 用 get_current_time 获取 Asia/Shanghai 当前时间。',
    '2. 用 calculator 计算 ((12345 * 67) + 890) / 13，并在最终答案里写出数值。',
    '3. 用 uuid_gen 生成 2 个 UUID。',
    '4. 用 web_fetch 读取 https://example.com，并总结页面主题。',
    '5. 用 delegate_task 启动两个子 Agent：',
    '   - 子 Agent A：基于“后端是 queryLoop + tools runner + JSON store”的背景，列出 2 条后端架构风险。',
    '   - 子 Agent B：基于“前端拆成 stream-client / stream-reducer / render-controller”的背景，列出 2 条前端架构风险。',
    '',
    '最终请输出：时间、计算结果、UUID、example.com 摘要、两个子 Agent 结论、以及一句 E2E 是否通过的判断。',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let streamResult;

  try {
    const res = await fetch(`${BASE_URL}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        conversationId: conversation.id,
        message,
        channelId: active.activeChannelId,
        model: active.activeModel,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`POST /chat failed: ${res.status} ${await res.text()}`);
    }
    streamResult = await readChatSse(res);
  } finally {
    clearTimeout(timer);
  }

  const storedConversation = await api('GET', `/api/v1/conversations/${conversation.id}`);
  const agentRuns = await api('GET', `/api/v1/agent-runs?conversationId=${encodeURIComponent(conversation.id)}&limit=20&includeTest=true`);
  const toolRuns = await api('GET', '/api/v1/tool-runs?limit=50&includeTest=true');
  const usage = await api('GET', '/api/v1/usage?limit=100&includeTest=true');

  const relatedToolRuns = toolRuns.filter(run => run.context?.conversationId === conversation.id);
  const relatedUsageRuns = usage.runs.filter(run => run.conversationId === conversation.id);
  const lastAssistant = [...storedConversation.messages].reverse().find(msg => msg.role === 'assistant') || null;
  const assistantText = Array.isArray(lastAssistant?.blocks)
    ? lastAssistant.blocks.filter(block => block.type === 'text').map(block => block.content || '').join('\n').slice(0, 2000)
    : '';

  const report = {
    ok: streamResult.terminal?.type === 'done',
    baseUrl: BASE_URL,
    runId,
    conversationId: conversation.id,
    activeChannelId: active.activeChannelId,
    activeModel: active.activeModel,
    durationMs: Date.now() - startedAt,
    terminal: streamResult.terminal,
    eventSummary: streamResult.summary,
    storedMessageCount: storedConversation.messages.length,
    assistantBlockTypes: lastAssistant?.blocks?.map(block => block.type) || [],
    assistantTextPreview: assistantText,
    relatedAgentRuns: agentRuns.map(run => ({
      runId: run.runId,
      role: run.role,
      status: run.status,
      label: run.label,
      parentRunId: run.parentRunId,
      durationMs: run.durationMs,
    })),
    relatedToolRuns: relatedToolRuns.map(run => ({
      name: run.name,
      isError: run.isError,
      durationMs: run.durationMs,
      adapter: run.context?.adapter || null,
      agentRunId: run.context?.agentRunId || null,
    })),
    relatedUsageRuns: relatedUsageRuns.map(run => ({
      runId: run.runId,
      role: run.role,
      status: run.status,
      model: run.model,
      inputTokens: run.metrics.inputTokens,
      outputTokens: run.metrics.outputTokens,
      toolCalls: run.toolCounts.totalToolCalls,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

run().catch(err => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message || String(err),
    stack: err.stack,
  }, null, 2));
  process.exitCode = 1;
});
