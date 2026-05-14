import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { assistantMessage } from './lib/api.mjs';
import * as storage from './lib/storage.mjs';
import { queryLoop } from './lib/query-loop.mjs';
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

const app = express();
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const api = express.Router();

// --- Active channel + model ---
api.get('/active', (_req, res) => {
  const cfg = readConfig();
  res.json({
    activeChannelId: cfg.activeChannelId,
    activeModel: cfg.activeModel,
    channels: cfg.channels.map(maskChannel),
  });
});

api.post('/active', (req, res) => {
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
api.get('/channels', (_req, res) => {
  const cfg = readConfig();
  res.json(cfg.channels.map(maskChannel));
});

api.post('/channels', (req, res) => {
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

api.put('/channels/:id', (req, res) => {
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

api.delete('/channels/:id', (req, res) => {
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
api.get('/tools', async (_req, res) => {
  res.json(await listTools());
});

api.put('/tools/:id', async (req, res) => {
  const tool = await updateToolConfig(req.params.id, req.body || {});
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
});

api.post('/tools/:id/enable', async (req, res) => {
  const tool = await updateToolConfig(req.params.id, { enabled: true });
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
});

api.post('/tools/:id/disable', async (req, res) => {
  const tool = await updateToolConfig(req.params.id, { enabled: false });
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
});

api.get('/tool-runs', async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(await listToolRuns(limit));
});

// --- Conversation routes ---
api.get('/conversations', async (_req, res) => {
  res.json(await storage.listConversations());
});

api.post('/conversations', async (req, res) => {
  const id = randomUUID();
  const convo = await storage.createConversation(id, req.body.title || 'New Chat');
  res.json(convo);
});

api.get('/conversations/:id', async (req, res) => {
  const convo = await storage.getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Not found' });
  res.json(convo);
});

api.delete('/conversations/:id', async (req, res) => {
  await storage.deleteConversation(req.params.id);
  res.json({ ok: true });
});

// --- Chat route (SSE stream) ---
api.post('/chat', async (req, res) => {
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

  const serverToolInputs = new Map();
  const serverToolStartedAt = new Map();

  // AbortController: tied to client disconnect
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const toolContext = { conversationId, channelId: ch.id, model: requestModel };

  try {
    const iterator = queryLoop({
      config: channelConfig,
      history,
      maxTurns: 5,
      signal: ac.signal,
      toolContext,
      onDelta: (delta) => {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      },
      onThinkingDelta: (thinkingText) => {
        res.write(`data: ${JSON.stringify({ type: 'thinking', text: thinkingText })}\n\n`);
      },
      onServerToolEvent: (event) => {
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
    });

    // Consume tool events from the loop
    let iterResult = await iterator.next();
    while (!iterResult.done) {
      const evt = iterResult.value;
      if (evt.type === 'tool_call') {
        res.write(`data: ${JSON.stringify({
          type: 'tool_call',
          tools: [{ id: evt.id, name: evt.name, input: evt.input }],
        })}\n\n`);
      } else if (evt.type === 'tool_result') {
        res.write(`data: ${JSON.stringify({
          type: 'tool_result',
          tools: [{
            id: evt.id,
            name: evt.name,
            isError: evt.isError,
            durationMs: evt.durationMs,
          }],
        })}\n\n`);
      }
      iterResult = await iterator.next();
    }

    const finalState = iterResult.value;

    // Consolidate: keep only the original messages + merged assistant message
    const mergedResult = {
      ...(finalState.result || {}),
      text: finalState.text,
      content: finalState.content,
      serverToolEvents: finalState.serverToolEvents,
    };

    const storeMessages = [...history.slice(0, originalMessageCount + 1)];
    storeMessages.push(assistantMessage(mergedResult, requestModel));

    const title = originalMessageCount === 0 || existingTitle === 'New Chat'
      ? message.slice(0, 50) + (message.length > 50 ? '…' : '')
      : undefined;

    if (conversationId) {
      storage.saveConversation(conversationId, storeMessages, title).catch(() => {});
    }

    res.write(`data: ${JSON.stringify({ type: 'done', stopReason: finalState.stopReason, usage: finalState.usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

app.use('/api/v1', api);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`xwork running at http://localhost:${PORT}`);
});
