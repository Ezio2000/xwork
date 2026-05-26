import { dom } from './dom.js';
import { escHtml, formatDateTime } from './renderers.js';
import { state } from './state.js';

function prettyJson(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2);
}

function editableJsonConfig(tool, config = tool.config || {}) {
  const out = { ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}) };
  if (tool.id === 'feishu_read') {
    delete out.app_id;
    delete out.app_secret;
    delete out.appId;
    delete out.appSecret;
    delete out.user_access_token;
    delete out.userAccessToken;
    delete out.user_access_token_expires_at;
    delete out.refresh_token;
    delete out.refresh_token_expires_at;
  }
  return out;
}

function configValue(config, key, fallback = '') {
  const value = config && typeof config === 'object' ? config[key] : undefined;
  return value === undefined || value === null ? fallback : String(value);
}

function renderDynamicConfigFields(tool) {
  if (tool.id !== 'feishu_read') return '';
  const config = tool.config || {};
  const appId = configValue(config, 'app_id', configValue(config, 'appId'));
  const appSecret = configValue(config, 'app_secret', configValue(config, 'appSecret'));
  const userAccessToken = configValue(config, 'user_access_token', configValue(config, 'userAccessToken'));

  return `
    <div class="tool-config-dynamic">
      <div class="tool-config-dynamic-title">Feishu App Credentials</div>
      <div class="tool-config-grid">
        <label class="tool-config-field">
          <span>App ID</span>
          <input type="text" data-config-key="app_id" data-config-aliases="appId" value="${escHtml(appId)}" autocomplete="off" spellcheck="false" placeholder="cli_xxx">
        </label>
        <label class="tool-config-field">
          <span>App Secret</span>
          <input type="password" data-config-key="app_secret" data-config-aliases="appSecret" value="${escHtml(appSecret)}" autocomplete="off" spellcheck="false" placeholder="app_secret">
        </label>
        <label class="tool-config-field wide">
          <span>User Access Token</span>
          <input type="password" data-config-key="user_access_token" data-config-aliases="userAccessToken" value="${escHtml(userAccessToken)}" autocomplete="off" spellcheck="false" placeholder="u-xxx，用于 get_current_user">
        </label>
      </div>
    </div>
  `;
}

function configSchemaRows(schema = {}) {
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const entries = Object.entries(properties);
  if (!entries.length) return '<div class="tool-config-empty">No documented config keys.</div>';

  return entries.map(([key, prop]) => {
    const type = Array.isArray(prop?.type) ? prop.type.join(' | ') : prop?.type || 'value';
    const enumText = Array.isArray(prop?.enum) && prop.enum.length ? ` · ${prop.enum.join(', ')}` : '';
    return `
      <div class="tool-config-schema-row">
        <code>${escHtml(key)}</code>
        <span>${escHtml(type)}${escHtml(enumText)}</span>
        ${prop?.description ? `<p>${escHtml(prop.description)}</p>` : ''}
      </div>
    `;
  }).join('');
}

function configExamples(tool) {
  const examples = Array.isArray(tool.configExamples) ? tool.configExamples : [];
  if (!examples.length) {
    return `
      <div class="tool-config-examples">
        <div class="tool-config-examples-title">Example</div>
        <pre>${escHtml(prettyJson(tool.defaultConfig || {}))}</pre>
      </div>
    `;
  }

  return `
    <div class="tool-config-examples">
      <div class="tool-config-examples-title">Examples</div>
      ${examples.map((example, index) => `
        <div class="tool-config-example">
          <div class="tool-config-example-header">
            <span>${escHtml(example.title || `Example ${index + 1}`)}</span>
            <button type="button" class="btn-text small" data-action="apply-tool-config-example" data-example-index="${index}">Use</button>
          </div>
          <pre>${escHtml(prettyJson(example.config || {}))}</pre>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderToolList() {
  if (!state.tools.length) {
    dom.toolList.innerHTML = '<div class="empty-panel">No tools available.</div>';
    return;
  }

  dom.toolList.innerHTML = state.tools.map(tool => `
    <div class="tool-card${tool.enabled ? ' enabled' : ''}" data-tool-id="${escHtml(tool.id)}">
      <div class="tool-card-main">
        <div class="tool-info">
          <div class="tool-title-row">
            <div class="tool-title">${escHtml(tool.title || tool.name)}</div>
            <span class="tool-status">${tool.enabled ? 'Enabled' : 'Disabled'}</span>
            ${tool.unavailable ? '<span class="tool-status danger">Unavailable</span>' : ''}
          </div>
          <div class="tool-desc">${escHtml(tool.description || '')}</div>
          <div class="tool-meta">
            <span>${escHtml(tool.name)}</span>
            <span>${escHtml(tool.adapter || 'builtin')}</span>
            <span>${escHtml(tool.category || 'general')}</span>
            <span>${Number(tool.timeoutMs || 0)}ms</span>
            ${tool.maxUses !== undefined ? `<span>max ${Number(tool.maxUses)} uses</span>` : ''}
          </div>
        </div>
        <label class="switch" title="Toggle tool">
          <input type="checkbox" data-action="toggle-tool" ${tool.enabled ? 'checked' : ''} ${tool.unavailable ? 'disabled' : ''}>
          <span></span>
        </label>
      </div>
      <details class="tool-config-panel">
        <summary>Parameters</summary>
        <form class="tool-config-form" data-action="save-tool-config">
          <label class="tool-config-field">
            <span>Timeout (ms)</span>
            <input type="number" name="timeoutMs" min="1" max="300000" step="1" value="${Number(tool.timeoutMs || 0)}" ${tool.adapter === 'anthropic_server' ? 'disabled' : ''}>
          </label>
          ${configExamples(tool)}
          ${renderDynamicConfigFields(tool)}
          <label class="tool-config-field">
            <span>Config JSON</span>
            <textarea name="config" rows="8" spellcheck="false">${escHtml(prettyJson(editableJsonConfig(tool)))}</textarea>
          </label>
          <div class="tool-config-schema">
            <div class="tool-config-schema-title">Available Config Keys</div>
            ${configSchemaRows(tool.configSchema)}
          </div>
          <div class="tool-config-error" data-role="tool-config-error"></div>
          <div class="tool-config-actions">
            <button type="button" class="btn-text small" data-action="reset-tool-config">Reset</button>
            <button type="submit" class="btn-primary small">Save</button>
          </div>
        </form>
      </details>
    </div>
  `).join('');
}

export function renderToolRuns() {
  if (!state.toolRuns.length) {
    dom.toolRunList.innerHTML = '<div class="empty-panel">No tool runs yet.</div>';
    return;
  }

  dom.toolRunList.innerHTML = state.toolRuns.map((run, i) => `
    <div class="tool-run${run.isError ? ' error' : ''}" data-run-index="${i}">
      <div class="tool-run-main">
        <span class="tool-run-name">${escHtml(run.name || '')}</span>
        <span class="tool-run-status">${run.isError ? 'Error' : 'OK'}</span>
      </div>
      <div class="tool-run-meta">
        ${Number(run.durationMs || 0)}ms &middot; ${escHtml(formatDateTime(run.createdAt))}
      </div>
    </div>
  `).join('');
}

export function showToolRunDetail(run) {
  dom.detailTitle.textContent = run.name || 'Tool Run';
  const parts = [];

  parts.push(`
    <div class="detail-section">
      <div class="detail-meta-grid">
        <div class="detail-meta-item">
          <div class="dm-label">Status</div>
          <div class="dm-value" style="color:${run.isError ? 'var(--danger)' : 'var(--accent)'}">${run.isError ? 'Error' : 'OK'}</div>
        </div>
        <div class="detail-meta-item">
          <div class="dm-label">Duration</div>
          <div class="dm-value">${Number(run.durationMs || 0)}ms</div>
        </div>
        <div class="detail-meta-item">
          <div class="dm-label">Time</div>
          <div class="dm-value">${escHtml(formatDateTime(run.createdAt))}</div>
        </div>
        <div class="detail-meta-item">
          <div class="dm-label">Run ID</div>
          <div class="dm-value" style="font-size:11px">${escHtml(run.runId || '')}</div>
        </div>
      </div>
    </div>
  `);

  if (run.isError || run.output?.errorCode || run.output?.errors?.length) {
    const errorMsg = run.output?.errors?.join(', ') || run.output?.errorCode || String(run.output || 'Unknown error');
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Error</div>
        <div class="detail-error">${escHtml(errorMsg)}</div>
      </div>
    `);
  }

  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Input</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.input || {}, null, 2))}</pre></div>
    </div>
  `);

  if (run.output?.sources?.length) {
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Sources (${run.output.sources.length})</div>
        <div class="detail-sources">
          ${run.output.sources.map(source => `
            <div class="detail-source">
              <div class="ds-title">${escHtml(source.title || 'Untitled')}</div>
              ${source.url ? `<a class="ds-url" href="${escHtml(source.url)}" target="_blank" rel="noreferrer">${escHtml(source.url)}</a>` : ''}
              ${source.snippet ? `<div class="ds-snippet">${escHtml(source.snippet)}</div>` : ''}
              ${source.pageAge ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${escHtml(source.pageAge)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `);
  } else if (run.output?.resultCount !== undefined) {
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Output</div>
        <div class="detail-value">${run.output.resultCount} result(s)</div>
      </div>
    `);
  } else if (run.output && !run.output.sources) {
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Output</div>
        <div class="detail-value"><pre>${escHtml(JSON.stringify(run.output, null, 2))}</pre></div>
      </div>
    `);
  }

  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Context</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.context || {}, null, 2))}</pre></div>
    </div>
  `);

  dom.detailBody.innerHTML = parts.join('');
  dom.toolRunDetail.classList.remove('hidden');
}

export function hideToolRunDetail() {
  dom.toolRunDetail.classList.add('hidden');
}
