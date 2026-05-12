import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { assistantMessage, streamChat } from './lib/api.mjs';
import * as storage from './lib/storage.mjs';
import { formatToolOutput, runTool } from './lib/tools/runner.mjs';
import { getEnabledToolDefinitions, listTools, updateToolConfig } from './lib/tools/registry.mjs';
import { appendToolRun, listToolRuns } from './lib/tools/runs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const DEFAULT_CONFIG = { channels: [], activeChannelId: null, activeModel: null };

function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function maskKey(key) {
  if (!key) return '';
  return '••••' + key.slice(-4);
}

function maskChannel(ch) {
  return { ...ch, apiKey: maskKey(ch.apiKey) };
}

function getActiveChannel(cfg) {
  const ch = cfg.channels.find(c => c.id === cfg.activeChannelId);
  return ch || cfg.channels[0] || null;
}

function appendAssistantMessage(history, result) {
  const content = Array.isArray(result.content) && result.content.length
    ? result.content
    : [{ type: 'text', text: result.text || '' }];
  history.push({ role: 'assistant', content });
}

function appendToolResults(history, results) {
  history.push({
    role: 'user',
    content: results.map(result => ({
      type: 'tool_result',
      tool_use_id: result.id,
      content: formatToolOutput(result.output),
      ...(result.isError ? { is_error: true } : {}),
    })),
  });
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- Active channel + model ---
app.get('/api/active', (_req, res) => {
  const cfg = readConfig();
  res.json({
    activeChannelId: cfg.activeChannelId,
    activeModel: cfg.activeModel,
    channels: cfg.channels.map(maskChannel),
  });
});

app.post('/api/active', (req, res) => {
  const cfg = readConfig();
  const { channelId, model } = req.body;
  if (channelId !== undefined) {
    if (!cfg.channels.find(c => c.id === channelId)) {
      return res.status(400).json({ error: 'Channel not found' });
    }
    cfg.activeChannelId = channelId;
  }
  if (model !== undefined) cfg.activeModel = model;
  writeConfig(cfg);
  res.json({
    activeChannelId: cfg.activeChannelId,
    activeModel: cfg.activeModel,
    channels: cfg.channels.map(maskChannel),
  });
});

// --- Channels CRUD ---
app.get('/api/channels', (_req, res) => {
  const cfg = readConfig();
  res.json(cfg.channels.map(maskChannel));
});

app.post('/api/channels', (req, res) => {
  const cfg = readConfig();
  const { name, baseUrl, apiKey, models, maxTokens, extraHeaders } = req.body;
  if (!name || !baseUrl) {
    return res.status(400).json({ error: 'name and baseUrl required' });
  }
  const ch = {
    id: randomUUID().slice(0, 8),
    name,
    baseUrl: baseUrl || 'https://api.deepseek.com/anthropic',
    apiKey: apiKey || '',
    models: models || [],
    maxTokens: maxTokens || 8192,
    extraHeaders: extraHeaders || {},
  };
  cfg.channels.push(ch);
  if (!cfg.activeChannelId) {
    cfg.activeChannelId = ch.id;
    cfg.activeModel = ch.models[0] || '';
  }
  writeConfig(cfg);
  res.json(maskChannel(ch));
});

app.put('/api/channels/:id', (req, res) => {
  const cfg = readConfig();
  const idx = cfg.channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' });

  const ch = cfg.channels[idx];
  const { name, baseUrl, apiKey, models, maxTokens, extraHeaders } = req.body;
  if (name !== undefined) ch.name = name;
  if (baseUrl !== undefined) ch.baseUrl = baseUrl;
  if (apiKey !== undefined && apiKey !== '' && !apiKey.startsWith('••••')) {
    ch.apiKey = apiKey;
  }
  if (models !== undefined) ch.models = models;
  if (maxTokens !== undefined) ch.maxTokens = maxTokens;
  if (extraHeaders !== undefined) ch.extraHeaders = extraHeaders;

  writeConfig(cfg);
  res.json(maskChannel(ch));
});

app.delete('/api/channels/:id', (req, res) => {
  const cfg = readConfig();
  const idx = cfg.channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' });
  cfg.channels.splice(idx, 1);
  if (cfg.activeChannelId === req.params.id) {
    cfg.activeChannelId = cfg.channels[0]?.id || null;
    cfg.activeModel = cfg.channels[0]?.models?.[0] || null;
  }
  writeConfig(cfg);
  res.json({ ok: true });
});

// --- Tools ---
app.get('/api/tools', async (_req, res) => {
  res.json(await listTools());
});

app.put('/api/tools/:id', async (req, res) => {
  const tool = await updateToolConfig(req.params.id, req.body || {});
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
});

app.post('/api/tools/:id/enable', async (req, res) => {
  const tool = await updateToolConfig(req.params.id, { enabled: true });
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
});

app.post('/api/tools/:id/disable', async (req, res) => {
  const tool = await updateToolConfig(req.params.id, { enabled: false });
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
});

app.get('/api/tool-runs', async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(await listToolRuns(limit));
});

// --- Conversation routes ---
app.get('/api/conversations', async (_req, res) => {
  res.json(await storage.listConversations());
});

app.post('/api/conversations', async (req, res) => {
  const id = randomUUID();
  const convo = await storage.createConversation(id, req.body.title || 'New Chat');
  res.json(convo);
});

app.get('/api/conversations/:id', async (req, res) => {
  const convo = await storage.getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json(convo);
});

app.delete('/api/conversations/:id', async (req, res) => {
  await storage.deleteConversation(req.params.id);
  res.json({ ok: true });
});

// --- Chat route (SSE stream) ---
app.post('/api/chat', async (req, res) => {
  const { conversationId, message, channelId, model } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const cfg = readConfig();

  // Resolve channel: explicit channelId > active channel > first channel
  let ch;
  if (channelId) {
    ch = cfg.channels.find(c => c.id === channelId);
  }
  if (!ch) ch = getActiveChannel(cfg);
  if (!ch) return res.status(400).json({ error: 'No channel configured' });
  if (!ch.apiKey) return res.status(400).json({ error: 'API key not configured for this channel' });

  let requestModel = model || cfg.activeModel || ch.models[0];
  if (ch.models?.length && !ch.models.includes(requestModel)) {
    requestModel = ch.models[0];
    cfg.activeModel = requestModel;
    cfg.activeChannelId = ch.id;
    writeConfig(cfg);
  }
  const enabledTools = await getEnabledToolDefinitions();
  const channelConfig = {
    baseUrl: ch.baseUrl,
    apiKey: ch.apiKey,
    model: requestModel,
    maxTokens: ch.maxTokens,
    extraHeaders: ch.extraHeaders,
    tools: enabledTools,
  };

  let history = [];
  let existingTitle = '';
  let originalMessageCount = 0;
  if (conversationId) {
    const convo = await storage.getConversation(conversationId);
    if (convo) {
      history = convo.messages;
      existingTitle = convo.title || '';
      originalMessageCount = history.length;
    }
  }
  history.push({ role: 'user', content: message });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let fullResponse = '';
  let finalResult = null;
  let lastUsage = null;
  let lastStopReason = null;
  const serverToolInputs = new Map();
	  const serverToolStartedAt = new Map();
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    for (let round = 0; round < 5 && !closed; round++) {
      const result = await streamChat(
        channelConfig,
        history,
        (delta) => {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
        },
        (thinkingText) => {
          res.write(`data: ${JSON.stringify({ type: 'thinking', text: thinkingText })}\n\n`);
        },
        (_fullText, stopReason, usage) => {
          lastStopReason = stopReason;
          lastUsage = usage;
        },
        (err) => {
          throw err;
        },
        (event) => {
          if (event.phase === 'call') {
            serverToolInputs.set(event.id, event.input || {});
	            serverToolStartedAt.set(event.id, Date.now());
            res.write(`data: ${JSON.stringify({
              type: 'tool_call',
              tools: [{ id: event.id, name: event.name, input: event.input || {} }],
            })}\n\n`);
          } else if (event.phase === 'result') {
            const input = serverToolInputs.get(event.id) || {};
            const output = {
              ...(event.data || {}),
              ...(event.errorCode ? { errorCode: event.errorCode } : {}),
            };
            appendToolRun({
              id: event.id,
              name: event.name,
              isError: event.isError,
              input,
              output,
              durationMs: Date.now() - (serverToolStartedAt.get(event.id) || Date.now()),
              context: { conversationId, channelId: ch.id, model: requestModel, adapter: event.name },
            }).catch(() => {});
            res.write(`data: ${JSON.stringify({
              type: 'tool_result',
              tools: [{
                id: event.id,
                name: event.name,
                isError: event.isError,
                durationMs: Date.now() - (serverToolStartedAt.get(event.id) || Date.now()),
                input,
                renderType: event.renderType,
                data: event.data,
              }],
            })}\n\n`);
          }
        },
      );

      lastStopReason = result.stopReason || lastStopReason;
      lastUsage = result.usage || lastUsage;
      finalResult = result;

      if (!result.toolCalls?.length) break;

      appendAssistantMessage(history, result);
      res.write(`data: ${JSON.stringify({
        type: 'tool_call',
        tools: result.toolCalls.map(call => ({ id: call.id, name: call.name })),
      })}\n\n`);

      const toolContext = { conversationId, channelId: ch.id, model: requestModel };
      const toolResults = await Promise.all(result.toolCalls.map(call => runTool(call, toolContext)));
      appendToolResults(history, toolResults);
      res.write(`data: ${JSON.stringify({
        type: 'tool_result',
        tools: toolResults.map(result => ({
          id: result.id,
          name: result.name,
          isError: result.isError,
          durationMs: result.durationMs,
        })),
      })}\n\n`);
    }

    history.push(assistantMessage(finalResult || {
      text: fullResponse,
    }, requestModel));
    const title = originalMessageCount === 0 || existingTitle === 'New Chat'
      ? message.slice(0, 50) + (message.length > 50 ? '…' : '')
      : undefined;

    if (conversationId) {
      storage.saveConversation(conversationId, history, title).catch(() => {});
    }

    res.write(`data: ${JSON.stringify({ type: 'done', stopReason: lastStopReason, usage: lastUsage })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`xwork running at http://localhost:${PORT}`);
});
