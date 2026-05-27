import { dom } from './dom.js';
import { escHtml } from './renderers.js';
import { state } from './state.js';

const DEFAULT_PROFILE = {
  title: '',
  description: '',
  selectionPrompt: '',
  systemPrompt: '',
  outputContract: '',
  allowedTools: ['web_search', 'get_current_time', 'calculator', 'uuid_gen', 'list_dir', 'git', 'code_outline', 'grep', 'glob', 'read_file', 'shell_command'],
  allowSubagents: false,
  maxDepth: 2,
  maxTurns: 3,
  timeoutMs: 90000,
  maxOutputChars: 2000,
  channelId: '',
  model: '',
  enabled: true,
};

function toolLabel(tool) {
  return tool.title || tool.name || tool.id;
}

function selectedTools(profile) {
  return new Set(Array.isArray(profile?.allowedTools) ? profile.allowedTools : []);
}

export function renderExpertAgentList() {
  if (!state.expertAgents.length) {
    dom.expertAgentList.innerHTML = '<div class="empty-panel">No expert agents configured.</div>';
    return;
  }

  dom.expertAgentList.innerHTML = state.expertAgents.map(agent => `
    <div class="expert-agent-card${agent.enabled ? ' enabled' : ''}" data-expert-agent-id="${escHtml(agent.id)}">
      <div class="expert-agent-card-main">
        <div class="expert-agent-info">
          <div class="expert-agent-title-row">
            <div class="expert-agent-title">${escHtml(agent.title || agent.id)}</div>
            ${agent.builtin ? '<span class="expert-agent-badge">Built-in</span>' : ''}
            ${agent.isDefault ? '<span class="expert-agent-badge">Default</span>' : ''}
            <span class="expert-agent-status">${agent.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="expert-agent-desc">${escHtml(agent.description || agent.selectionPrompt || '')}</div>
          <div class="expert-agent-meta">
            <span>${escHtml(agent.id)}</span>
            <span>${Number(agent.maxTurns || 0)} turns</span>
            <span>${Number(agent.timeoutMs || 0)}ms</span>
            <span>${(agent.allowedTools || []).length} tools</span>
            ${agent.model ? `<span>${escHtml(agent.model)}</span>` : ''}
          </div>
        </div>
        <label class="switch" title="Toggle expert agent">
          <input type="checkbox" data-action="toggle-expert-agent" ${agent.enabled ? 'checked' : ''} ${agent.isDefault ? 'disabled' : ''}>
          <span></span>
        </label>
      </div>
      <div class="expert-agent-actions">
        <button type="button" class="btn-text small" data-action="edit-expert-agent">Edit</button>
        ${agent.builtin ? '<button type="button" class="btn-text small" data-action="reset-expert-agent">Reset</button>' : ''}
        ${agent.builtin ? '' : '<button type="button" class="btn-text small danger" data-action="delete-expert-agent">Delete</button>'}
      </div>
    </div>
  `).join('');
}

function renderChannelOptions(profile) {
  const current = profile?.channelId || '';
  return [
    `<option value="" ${current ? '' : 'selected'}>Use parent channel</option>`,
    ...state.channels.map(channel => `<option value="${escHtml(channel.id)}" ${channel.id === current ? 'selected' : ''}>${escHtml(channel.name)}</option>`),
  ].join('');
}

function renderToolCheckboxes(profile) {
  const selected = selectedTools(profile);
  if (!state.tools.length) return '<div class="empty-panel">No tools available.</div>';
  return state.tools
    .filter(tool => tool.adapter !== 'unavailable')
    .map(tool => `
      <label class="expert-agent-tool-option">
        <input type="checkbox" value="${escHtml(tool.name || tool.id)}" ${selected.has(tool.name || tool.id) ? 'checked' : ''}>
        <span>${escHtml(toolLabel(tool))}</span>
        <small>${escHtml(tool.category || 'tool')}${tool.enabled ? '' : ' · disabled globally'}</small>
      </label>
    `).join('');
}

export function showExpertAgentEditor(agent = null) {
  const profile = agent || DEFAULT_PROFILE;
  dom.expertAgentEditorTitle.textContent = agent ? `Edit ${agent.title || agent.id}` : 'New Expert Agent';
  dom.editExpertAgentId.value = agent?.id || '';
  dom.editExpertAgentTitle.value = profile.title || '';
  dom.editExpertAgentEnabled.value = String(profile.enabled !== false);
  dom.editExpertAgentEnabled.disabled = profile.isDefault === true;
  dom.editExpertAgentDescription.value = profile.description || '';
  dom.editExpertAgentSelection.value = profile.selectionPrompt || '';
  dom.editExpertAgentSystem.value = profile.systemPrompt || '';
  dom.editExpertAgentOutput.value = profile.outputContract || '';
  dom.editExpertAgentChannel.innerHTML = renderChannelOptions(profile);
  dom.editExpertAgentModel.value = profile.model || '';
  dom.editExpertAgentMaxTurns.value = profile.maxTurns || 3;
  dom.editExpertAgentTimeout.value = profile.timeoutMs || 90000;
  dom.editExpertAgentOutputChars.value = profile.maxOutputChars || 2000;
  dom.editExpertAgentMaxDepth.value = profile.maxDepth || 2;
  dom.editExpertAgentAllowSubagents.checked = profile.allowSubagents === true;
  dom.editExpertAgentTools.innerHTML = renderToolCheckboxes(profile);
  dom.expertAgentEditorError.textContent = '';
  dom.expertAgentEditorError.classList.remove('visible');
  dom.expertAgentEditor.classList.remove('hidden');
}

export function hideExpertAgentEditor() {
  dom.expertAgentEditor.classList.add('hidden');
}

function numberValue(input, fallback) {
  const n = Number(input.value);
  return Number.isFinite(n) ? n : fallback;
}

export function expertAgentPayloadFromEditor() {
  const allowedTools = [...dom.editExpertAgentTools.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => input.value)
    .filter(Boolean);
  return {
    title: dom.editExpertAgentTitle.value.trim(),
    enabled: dom.editExpertAgentEnabled.value === 'true',
    description: dom.editExpertAgentDescription.value.trim(),
    selectionPrompt: dom.editExpertAgentSelection.value.trim(),
    systemPrompt: dom.editExpertAgentSystem.value.trim(),
    outputContract: dom.editExpertAgentOutput.value.trim(),
    channelId: dom.editExpertAgentChannel.value || null,
    model: dom.editExpertAgentModel.value.trim(),
    maxTurns: numberValue(dom.editExpertAgentMaxTurns, 3),
    timeoutMs: numberValue(dom.editExpertAgentTimeout, 90000),
    maxOutputChars: numberValue(dom.editExpertAgentOutputChars, 2000),
    maxDepth: numberValue(dom.editExpertAgentMaxDepth, 2),
    allowSubagents: dom.editExpertAgentAllowSubagents.checked,
    allowedTools,
  };
}

export function setExpertAgentEditorError(message = '') {
  dom.expertAgentEditorError.textContent = message;
  dom.expertAgentEditorError.classList.toggle('visible', Boolean(message));
}
