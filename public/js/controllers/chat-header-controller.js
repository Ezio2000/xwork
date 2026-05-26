import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';

const TOKEN_KEYS = [
  'user_access_token',
  'userAccessToken',
  'user_access_token_expires_at',
  'refresh_token',
  'refresh_token_expires_at',
];

let resetTimer = null;

function feishuAuthTool() {
  return state.tools.find(tool => tool.id === 'feishu_auth') || null;
}

export function renderChatHeaderActions() {
  const button = dom.btnClearFeishuToken;
  if (!button) return;
  const tool = feishuAuthTool();
  const visible = tool?.enabled === true;
  button.classList.toggle('hidden', !visible);
  if (!visible) return;
  button.disabled = false;
  if (!button.dataset.status) button.textContent = 'Clear Feishu Token';
}

function tokenClearedConfig(config = {}) {
  const next = { ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}) };
  for (const key of TOKEN_KEYS) delete next[key];
  next.user_access_token = '';
  return next;
}

async function clearFeishuToken() {
  const button = dom.btnClearFeishuToken;
  const tool = feishuAuthTool();
  if (!button || !tool || button.disabled) return;

  if (resetTimer) clearTimeout(resetTimer);
  button.disabled = true;
  button.dataset.status = 'clearing';
  button.textContent = 'Clearing...';
  try {
    const updatedAuth = await api('PUT', '/api/v1/tools/feishu_auth', {
      config: tokenClearedConfig(tool.config),
    });
    const authIdx = state.tools.findIndex(item => item.id === 'feishu_auth');
    if (authIdx !== -1) state.tools[authIdx] = updatedAuth;

    const readTool = state.tools.find(item => item.id === 'feishu_read');
    if (readTool?.config) {
      const updatedRead = await api('PUT', '/api/v1/tools/feishu_read', {
        config: tokenClearedConfig(readTool.config),
      });
      const readIdx = state.tools.findIndex(item => item.id === 'feishu_read');
      if (readIdx !== -1) state.tools[readIdx] = updatedRead;
    }
    button.dataset.status = 'cleared';
    button.textContent = 'Cleared';
    resetTimer = setTimeout(() => {
      delete button.dataset.status;
      renderChatHeaderActions();
    }, 1600);
  } catch (err) {
    button.dataset.status = 'error';
    button.textContent = err.message || 'Clear failed';
    resetTimer = setTimeout(() => {
      delete button.dataset.status;
      renderChatHeaderActions();
    }, 2400);
  } finally {
    button.disabled = false;
  }
}

export function bindChatHeaderController() {
  dom.btnClearFeishuToken?.addEventListener('click', clearFeishuToken);
  renderChatHeaderActions();
}
