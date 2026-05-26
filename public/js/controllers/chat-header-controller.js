import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';

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

async function clearFeishuToken() {
  const button = dom.btnClearFeishuToken;
  const tool = feishuAuthTool();
  if (!button || !tool || button.disabled) return;

  if (resetTimer) clearTimeout(resetTimer);
  button.disabled = true;
  button.dataset.status = 'clearing';
  button.textContent = 'Clearing...';
  try {
    const updated = await api('POST', '/api/v1/tools/feishu_auth/clear-token');
    for (const toolKey of ['feishu_auth', 'feishu_read']) {
      const updatedTool = updated?.[toolKey];
      if (!updatedTool) continue;
      const idx = state.tools.findIndex(item => item.id === updatedTool.id);
      if (idx !== -1) state.tools[idx] = updatedTool;
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
