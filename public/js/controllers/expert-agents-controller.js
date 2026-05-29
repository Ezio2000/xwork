import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  expertAgentPayloadFromEditor,
  hideExpertAgentEditor,
  renderExpertAgentList,
  setExpertAgentEditorError,
  showChatPage,
  showExpertAgentEditor,
  showExpertAgentsPageFrame,
} from '../views.js';

async function ensureSupportData({ refreshTools = false } = {}) {
  if (refreshTools || !state.tools.length) {
    state.tools = await api('GET', '/api/v1/tools');
  }
  if (!state.channels.length) {
    const active = await api('GET', '/api/v1/active');
    state.channels = active.channels || [];
    state.activeChannelId = active.activeChannelId;
    state.activeModel = active.activeModel;
  }
}

export async function loadExpertAgents() {
  state.expertAgents = await api('GET', '/api/v1/expert-agents');
  renderExpertAgentList();
}

export async function showExpertAgentsPage() {
  showExpertAgentsPageFrame();
  await ensureSupportData({ refreshTools: true });
  await loadExpertAgents();
}

async function refreshExpertAgentsPage() {
  await ensureSupportData({ refreshTools: true });
  await loadExpertAgents();
  const editingId = dom.editExpertAgentId.value;
  if (editingId) {
    const agent = state.expertAgents.find(item => item.id === editingId);
    if (agent) showExpertAgentEditor(agent);
  }
}

function replaceExpertAgent(updated) {
  const index = state.expertAgents.findIndex(agent => agent.id === updated.id);
  if (index === -1) state.expertAgents.push(updated);
  else state.expertAgents[index] = updated;
}

async function saveExpertAgent() {
  setExpertAgentEditorError();
  const id = dom.editExpertAgentId.value;
  const payload = expertAgentPayloadFromEditor();
  if (!payload.title) {
    setExpertAgentEditorError('Name is required');
    return;
  }
  if (!payload.systemPrompt) {
    setExpertAgentEditorError('System Prompt is required');
    return;
  }

  const previous = dom.btnSaveExpertAgent.textContent;
  dom.btnSaveExpertAgent.disabled = true;
  dom.btnSaveExpertAgent.textContent = 'Saving...';
  try {
    const updated = id
      ? await api('PUT', `/api/v1/expert-agents/${id}`, payload)
      : await api('POST', '/api/v1/expert-agents', payload);
    replaceExpertAgent(updated);
    showExpertAgentEditor(updated);
  } catch (err) {
    setExpertAgentEditorError(err.message || String(err));
  } finally {
    dom.btnSaveExpertAgent.disabled = false;
    dom.btnSaveExpertAgent.textContent = previous;
  }
}

async function toggleExpertAgent(id, enabled) {
  const updated = await api('PUT', `/api/v1/expert-agents/${id}`, { enabled });
  replaceExpertAgent(updated);
  renderExpertAgentList();
}

async function deleteExpertAgent(id) {
  if (!confirm('Delete this expert agent?')) return;
  await api('DELETE', `/api/v1/expert-agents/${id}`);
  state.expertAgents = state.expertAgents.filter(agent => agent.id !== id);
  renderExpertAgentList();
  if (dom.editExpertAgentId.value === id) hideExpertAgentEditor();
}

async function resetExpertAgent(id) {
  if (!confirm('Reset this built-in expert agent to defaults?')) return;
  const updated = await api('POST', `/api/v1/expert-agents/${id}/reset`);
  replaceExpertAgent(updated);
  renderExpertAgentList();
  if (dom.editExpertAgentId.value === id) showExpertAgentEditor(updated);
}

export function bindExpertAgentsController() {
  dom.btnBackChatExpertAgents.addEventListener('click', showChatPage);
  dom.btnRefreshExpertAgents.addEventListener('click', () => {
    refreshExpertAgentsPage().catch(err => alert(err.message || String(err)));
  });
  dom.btnAddExpertAgent.addEventListener('click', () => showExpertAgentEditor(null));
  dom.btnCancelExpertAgent.addEventListener('click', hideExpertAgentEditor);
  dom.btnSaveExpertAgent.addEventListener('click', saveExpertAgent);

  dom.expertAgentList.addEventListener('change', (event) => {
    const toggle = event.target.closest('input[data-action="toggle-expert-agent"]');
    if (!toggle) return;
    const card = toggle.closest('[data-expert-agent-id]');
    if (!card) return;
    toggleExpertAgent(card.dataset.expertAgentId, toggle.checked).catch(err => {
      alert(err.message || String(err));
      toggle.checked = !toggle.checked;
    });
  });

  dom.expertAgentList.addEventListener('click', (event) => {
    if (event.target.closest('.switch')) return;
    const card = event.target.closest('[data-expert-agent-id]');
    if (!card) return;
    const id = card.dataset.expertAgentId;
    const action = event.target.closest('button')?.dataset.action;
    const agent = state.expertAgents.find(item => item.id === id);
    if (!action) {
      if (agent) showExpertAgentEditor(agent);
      return;
    }
    if (action === 'delete-expert-agent') deleteExpertAgent(id).catch(err => alert(err.message || String(err)));
    if (action === 'reset-expert-agent') resetExpertAgent(id).catch(err => alert(err.message || String(err)));
  });
}
