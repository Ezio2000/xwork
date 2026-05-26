import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  hideToolRunDetail,
  renderToolList,
  renderToolRuns,
  showChatPage,
  showToolRunDetail,
  showToolsPageFrame,
} from '../views.js';

export async function loadTools() {
  state.tools = await api('GET', '/api/v1/tools');
  renderToolList();
}

export async function loadToolRuns() {
  state.toolRuns = await api('GET', '/api/v1/tool-runs?limit=20');
  renderToolRuns();
}

export async function showToolsPage() {
  showToolsPageFrame();
  await loadTools();
  await loadToolRuns();
}

async function toggleTool(id, enabled) {
  const updated = await api('PUT', `/api/v1/tools/${id}`, { enabled });
  const idx = state.tools.findIndex(tool => tool.id === id);
  if (idx !== -1) state.tools[idx] = updated;
  renderToolList();
}

function replaceTool(updated) {
  const idx = state.tools.findIndex(tool => tool.id === updated.id);
  if (idx !== -1) state.tools[idx] = updated;
}

function toolForForm(form) {
  const card = form.closest('.tool-card');
  if (!card) return null;
  return state.tools.find(item => item.id === card.dataset.toolId) || null;
}

function setConfigError(form, message = '') {
  const error = form.querySelector('[data-role="tool-config-error"]');
  if (!error) return;
  error.textContent = message;
  error.classList.toggle('visible', Boolean(message));
}

function parseConfigForm(form) {
  const tool = toolForForm(form);
  const timeoutInput = form.elements.timeoutMs;
  const rawConfig = form.elements.config?.value || '{}';
  let config;
  try {
    config = JSON.parse(rawConfig);
  } catch (err) {
    throw new Error(`Config JSON is invalid: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Config JSON must be an object');
  }
  if (tool?.id === 'feishu_read' || tool?.id === 'feishu_auth') {
    const currentConfig = tool.config && typeof tool.config === 'object' && !Array.isArray(tool.config) ? tool.config : {};
    config = {
      app_id: currentConfig.app_id ?? currentConfig.appId ?? '',
      app_secret: currentConfig.app_secret ?? currentConfig.appSecret ?? '',
      user_access_token: currentConfig.user_access_token ?? currentConfig.userAccessToken ?? '',
      ...config,
    };
  }
  for (const field of form.querySelectorAll('[data-config-key]')) {
    const key = field.dataset.configKey;
    if (!key) continue;
    const aliases = String(field.dataset.configAliases || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    for (const alias of aliases) delete config[alias];
    config[key] = field.value;
  }
  const payload = { config };
  if (timeoutInput && !timeoutInput.disabled) {
    const timeoutMs = Number(timeoutInput.value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      throw new Error('Timeout must be an integer between 1 and 300000');
    }
    payload.timeoutMs = timeoutMs;
  }
  return payload;
}

async function saveToolConfig(card, form) {
  const payload = parseConfigForm(form);
  const updated = await api('PUT', `/api/v1/tools/${card.dataset.toolId}`, payload);
  replaceTool(updated);
  renderToolList();
}

async function resetToolConfig(card) {
  const tool = state.tools.find(item => item.id === card.dataset.toolId);
  if (!tool) return;
  const payload = { config: tool.defaultConfig || {} };
  if (tool.adapter !== 'anthropic_server') payload.timeoutMs = Number(tool.defaultTimeoutMs || tool.timeoutMs || 1);
  const updated = await api('PUT', `/api/v1/tools/${tool.id}`, payload);
  replaceTool(updated);
  renderToolList();
}

function applyToolConfigExample(card, index) {
  const tool = state.tools.find(item => item.id === card.dataset.toolId);
  const example = tool?.configExamples?.[index];
  if (!example) return;
  const textarea = card.querySelector('textarea[name="config"]');
  if (!textarea) return;
  const config = example.config || {};
  for (const field of card.querySelectorAll('[data-config-key]')) {
    const key = field.dataset.configKey;
    if (!key) continue;
    const aliases = String(field.dataset.configAliases || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    const value = config[key] ?? aliases.map(alias => config[alias]).find(item => item !== undefined);
    field.value = value === undefined || value === null ? '' : String(value);
  }
  const editableConfig = { ...config };
  for (const field of card.querySelectorAll('[data-config-key]')) {
    const key = field.dataset.configKey;
    if (key) delete editableConfig[key];
    for (const alias of String(field.dataset.configAliases || '').split(',').map(item => item.trim()).filter(Boolean)) {
      delete editableConfig[alias];
    }
  }
  textarea.value = JSON.stringify(editableConfig, null, 2);
  const form = textarea.closest('form');
  if (form) setConfigError(form);
}

export function bindToolsController() {
  dom.btnBackChatTools.addEventListener('click', showChatPage);
  dom.btnRefreshTools.addEventListener('click', loadTools);
  dom.btnRefreshToolRuns.addEventListener('click', loadToolRuns);
  dom.toolList.addEventListener('change', (event) => {
    const toggle = event.target.closest('input[data-action="toggle-tool"]');
    if (!toggle) return;
    const card = event.target.closest('.tool-card');
    if (!card) return;
    toggleTool(card.dataset.toolId, toggle.checked).catch(err => {
      alert(err.message);
      toggle.checked = !toggle.checked;
    });
  });
  dom.toolList.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-action="save-tool-config"]');
    if (!form) return;
    event.preventDefault();
    const card = form.closest('.tool-card');
    if (!card) return;
    setConfigError(form);
    saveToolConfig(card, form).catch(err => setConfigError(form, err.message));
  });
  dom.toolList.addEventListener('click', (event) => {
    const example = event.target.closest('[data-action="apply-tool-config-example"]');
    if (example) {
      const card = example.closest('.tool-card');
      if (card) applyToolConfigExample(card, Number(example.dataset.exampleIndex));
      return;
    }

    const reset = event.target.closest('[data-action="reset-tool-config"]');
    if (!reset) return;
    const card = reset.closest('.tool-card');
    if (!card) return;
    resetToolConfig(card).catch(err => {
      const form = reset.closest('form');
      if (form) setConfigError(form, err.message);
      else alert(err.message);
    });
  });

  dom.toolRunList.addEventListener('click', (event) => {
    const item = event.target.closest('.tool-run');
    if (!item) return;
    const run = state.toolRuns[Number(item.dataset.runIndex)];
    if (run) showToolRunDetail(run);
  });
  dom.btnCloseDetail.addEventListener('click', hideToolRunDetail);
  dom.toolRunDetail.querySelector('.detail-backdrop').addEventListener('click', hideToolRunDetail);
}
