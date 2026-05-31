let resetTimer = null;

const CLEAR_LABEL = 'Clear Feishu user access token';
const CLEARING_LABEL = 'Clearing Feishu user access token...';
const CLEARED_LABEL = 'Feishu user access token cleared';
const ERROR_LABEL = 'Failed to clear Feishu user access token';
const MENU_LABEL = 'Feishu token actions';
const FEISHU_AUTH_HIDDEN_CONFIG_KEYS = [
  'app_id',
  'app_secret',
  'appId',
  'appSecret',
  'user_access_token',
  'userAccessToken',
  'user_access_token_expires_at',
  'refresh_token',
  'refresh_token_expires_at',
];
const FEISHU_READ_HIDDEN_CONFIG_KEYS = [
  ...FEISHU_AUTH_HIDDEN_CONFIG_KEYS,
  'baseUrl',
  'authBaseUrl',
  'oauthScope',
];

export const toolIds = ['feishu_auth', 'feishu_read'];
export const hiddenConfigKeys = FEISHU_AUTH_HIDDEN_CONFIG_KEYS;

function feishuAuthTool(state) {
  return state.tools.find(tool => tool.id === 'feishu_auth') || null;
}

function escHtml(ctx, value) {
  return typeof ctx.escHtml === 'function'
    ? ctx.escHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function configValue(config, key, fallback = '') {
  const value = config && typeof config === 'object' ? config[key] : undefined;
  return value === undefined || value === null ? fallback : String(value);
}

function setButtonLabel(button, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function setMenuOpen(wrapper, open) {
  const menu = wrapper?.querySelector('[data-feishu-token-menu]');
  const button = wrapper?.querySelector('[data-feishu-token-menu-button]');
  if (!menu || !button) return;
  menu.classList.toggle('hidden', !open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function wrapperFromTarget(target) {
  return target?.closest?.('[data-tool-header-action="feishu-token"]') || null;
}

export function renderHeaderActions(ctx = {}) {
  const state = ctx.state || { tools: [] };
  const tool = feishuAuthTool(state);
  if (tool?.enabled !== true) return '';
  return `
    <div class="feishu-token-menu-wrap" data-tool-header-action="feishu-token">
      <button type="button" class="btn-icon feishu-token-button" data-feishu-token-menu-button title="${MENU_LABEL}" aria-label="${MENU_LABEL}" aria-haspopup="menu" aria-expanded="false">
        <span class="feishu-token-icon" aria-hidden="true">飞</span>
      </button>
      <div class="feishu-token-menu hidden" data-feishu-token-menu role="menu">
        <button type="button" class="feishu-token-menu-item" data-feishu-clear-token role="menuitem">${CLEAR_LABEL}</button>
      </div>
    </div>
  `;
}

export function editableConfig(tool, config = {}) {
  const out = { ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}) };
  const keys = tool?.id === 'feishu_read' ? FEISHU_READ_HIDDEN_CONFIG_KEYS : FEISHU_AUTH_HIDDEN_CONFIG_KEYS;
  for (const key of keys) {
    delete out[key];
  }
  if (tool?.id === 'feishu_auth') return out;
  if (tool?.id === 'feishu_read') return out;
  return out;
}

export function renderConfigFields(tool, ctx = {}) {
  if (tool?.id !== 'feishu_auth') return '';
  const config = tool.config || {};
  const appId = configValue(config, 'app_id', configValue(config, 'appId'));
  const appSecret = configValue(config, 'app_secret', configValue(config, 'appSecret'));

  return `
    <div class="tool-config-dynamic">
      <div class="tool-config-dynamic-title">Feishu App Credentials</div>
      <div class="tool-config-grid">
        <label class="tool-config-field">
          <span>App ID</span>
          <input type="text" data-config-key="app_id" data-config-aliases="appId" value="${escHtml(ctx, appId)}" autocomplete="off" spellcheck="false" placeholder="cli_xxx">
        </label>
        <label class="tool-config-field">
          <span>App Secret</span>
          <input type="password" data-config-key="app_secret" data-config-aliases="appSecret" value="${escHtml(ctx, appSecret)}" autocomplete="off" spellcheck="false" placeholder="app_secret">
        </label>
      </div>
    </div>
  `;
}

export function normalizeConfigPayload(tool, payload = {}) {
  if (tool?.id !== 'feishu_auth') return payload;
  const currentConfig = tool.config && typeof tool.config === 'object' && !Array.isArray(tool.config) ? tool.config : {};
  return {
    ...payload,
    config: {
      app_id: currentConfig.app_id ?? currentConfig.appId ?? '',
      app_secret: currentConfig.app_secret ?? currentConfig.appSecret ?? '',
      user_access_token: currentConfig.user_access_token ?? currentConfig.userAccessToken ?? '',
      ...(payload.config || {}),
    },
  };
}

async function clearFeishuToken(wrapper, ctx = {}) {
  const button = wrapper?.querySelector('[data-feishu-token-menu-button]');
  const clearButton = wrapper?.querySelector('[data-feishu-clear-token]');
  const state = ctx.state || { tools: [] };
  const api = ctx.api;
  const tool = feishuAuthTool(state);
  if (typeof api !== 'function') throw new Error('Missing tool header api context');
  if (!button || !clearButton || !tool || button.disabled || clearButton.disabled) return;

  if (resetTimer) clearTimeout(resetTimer);
  setMenuOpen(wrapper, false);
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
      ctx.renderChatHeaderActions?.();
    }, 1600);
  } catch (err) {
    button.dataset.status = 'error';
    setButtonLabel(button, err.message || ERROR_LABEL);
    resetTimer = setTimeout(() => {
      delete button.dataset.status;
      ctx.renderChatHeaderActions?.();
    }, 2400);
  } finally {
    button.disabled = false;
    clearButton.disabled = false;
  }
}

export function installHeaderActionHandlers(root, ctx = {}) {
  root.addEventListener('click', async (event) => {
    const menuButton = event.target.closest('[data-feishu-token-menu-button]');
    if (menuButton) {
      event.stopPropagation();
      const wrapper = wrapperFromTarget(menuButton);
      const menu = wrapper?.querySelector('[data-feishu-token-menu]');
      setMenuOpen(wrapper, menu?.classList.contains('hidden') === true);
      return;
    }

    const clearButton = event.target.closest('[data-feishu-clear-token]');
    if (clearButton) {
      event.preventDefault();
      await clearFeishuToken(wrapperFromTarget(clearButton), ctx);
    }
  });

  document.addEventListener('click', (event) => {
    for (const wrapper of root.querySelectorAll('[data-tool-header-action="feishu-token"]')) {
      if (event?.target && wrapper.contains(event.target)) continue;
      setMenuOpen(wrapper, false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const wrapper of root.querySelectorAll('[data-tool-header-action="feishu-token"]')) {
      setMenuOpen(wrapper, false);
    }
  });
}
