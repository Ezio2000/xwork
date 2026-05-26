import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';

let resetTimer = null;

const CLEAR_LABEL = 'Clear Feishu user access token';
const CLEARING_LABEL = 'Clearing Feishu user access token...';
const CLEARED_LABEL = 'Feishu user access token cleared';
const ERROR_LABEL = 'Failed to clear Feishu user access token';
const MENU_LABEL = 'Feishu token actions';

function feishuAuthTool() {
  return state.tools.find(tool => tool.id === 'feishu_auth') || null;
}

function setButtonLabel(button, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function setMenuOpen(open) {
  if (!dom.feishuTokenMenu || !dom.btnFeishuTokenMenu) return;
  dom.feishuTokenMenu.classList.toggle('hidden', !open);
  dom.btnFeishuTokenMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function renderChatHeaderActions() {
  const wrapper = dom.feishuTokenMenuWrap;
  const button = dom.btnFeishuTokenMenu;
  const clearButton = dom.btnClearFeishuToken;
  if (!wrapper || !button || !clearButton) return;
  const tool = feishuAuthTool();
  const visible = tool?.enabled === true;
  wrapper.classList.toggle('hidden', !visible);
  if (!visible) return;
  button.disabled = false;
  clearButton.disabled = false;
  if (!button.dataset.status) setButtonLabel(button, MENU_LABEL);
}

async function clearFeishuToken() {
  const button = dom.btnFeishuTokenMenu;
  const clearButton = dom.btnClearFeishuToken;
  const tool = feishuAuthTool();
  if (!button || !clearButton || !tool || button.disabled || clearButton.disabled) return;

  if (resetTimer) clearTimeout(resetTimer);
  setMenuOpen(false);
  button.disabled = true;
  clearButton.disabled = true;
  button.dataset.status = 'clearing';
  setButtonLabel(button, CLEARING_LABEL);
  try {
    const updated = await api('POST', '/api/v1/tools/feishu_auth/clear-token');
    for (const toolKey of ['feishu_auth', 'feishu_read']) {
      const updatedTool = updated?.[toolKey];
      if (!updatedTool) continue;
      const idx = state.tools.findIndex(item => item.id === updatedTool.id);
      if (idx !== -1) state.tools[idx] = updatedTool;
    }
    button.dataset.status = 'cleared';
    setButtonLabel(button, CLEARED_LABEL);
    resetTimer = setTimeout(() => {
      delete button.dataset.status;
      renderChatHeaderActions();
    }, 1600);
  } catch (err) {
    button.dataset.status = 'error';
    setButtonLabel(button, err.message || ERROR_LABEL);
    resetTimer = setTimeout(() => {
      delete button.dataset.status;
      renderChatHeaderActions();
    }, 2400);
  } finally {
    button.disabled = false;
    clearButton.disabled = false;
  }
}

function toggleFeishuMenu(event) {
  event?.stopPropagation();
  const isOpen = !dom.feishuTokenMenu?.classList.contains('hidden');
  setMenuOpen(!isOpen);
}

function closeFeishuMenu(event) {
  if (!dom.feishuTokenMenuWrap || dom.feishuTokenMenuWrap.classList.contains('hidden')) return;
  if (event?.target && dom.feishuTokenMenuWrap.contains(event.target)) return;
  setMenuOpen(false);
}

function handleHeaderKeydown(event) {
  if (event.key !== 'Escape') return;
  setMenuOpen(false);
}

export function bindChatHeaderController() {
  dom.btnFeishuTokenMenu?.addEventListener('click', toggleFeishuMenu);
  dom.btnClearFeishuToken?.addEventListener('click', clearFeishuToken);
  document.addEventListener('click', closeFeishuMenu);
  document.addEventListener('keydown', handleHeaderKeydown);
  renderChatHeaderActions();
}
