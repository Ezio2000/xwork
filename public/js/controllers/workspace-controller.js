import { dom } from '../dom.js';
import { showWorkspacePageFrame, showChatPage } from '../navigation-view.js';

const ENDPOINT = '/api/v1/workspace';
let lastInfo = null;
let statusTimer = null;

function setStatus(message, kind = 'info') {
  if (!dom.workspaceStatus) return;
  dom.workspaceStatus.textContent = message || '';
  dom.workspaceStatus.dataset.kind = message ? kind : '';
  if (statusTimer) clearTimeout(statusTimer);
  if (message && kind === 'info') {
    statusTimer = setTimeout(() => {
      if (dom.workspaceStatus.textContent === message) {
        dom.workspaceStatus.textContent = '';
        delete dom.workspaceStatus.dataset.kind;
      }
    }, 4000);
  }
}

function applyInfo(info) {
  lastInfo = info || null;
  if (!info) return;
  if (dom.workspaceCurrentRoot) dom.workspaceCurrentRoot.textContent = info.root || '—';
  if (dom.workspaceCurrentLabel) dom.workspaceCurrentLabel.textContent = info.label || '—';
  if (dom.workspaceCurrentMode) {
    dom.workspaceCurrentMode.textContent = info.isDefault ? 'Default (xwork install)' : 'Custom mount';
  }
  if (dom.workspaceProjectRoot) dom.workspaceProjectRoot.textContent = info.projectRoot || '—';
}

async function loadWorkspace() {
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    applyInfo(info);
    if (dom.workspaceRootInput) {
      dom.workspaceRootInput.value = info.isDefault ? '' : info.root || '';
    }
    if (dom.workspaceLabelInput) {
      dom.workspaceLabelInput.value = info.label || '';
    }
  } catch (err) {
    setStatus(`Failed to load workspace: ${err.message}`, 'error');
  }
}

async function saveWorkspace({ reset = false } = {}) {
  const rootRaw = reset ? '' : (dom.workspaceRootInput?.value || '').trim();
  const labelRaw = reset ? '' : (dom.workspaceLabelInput?.value || '').trim();
  const payload = { root: rootRaw, label: labelRaw };
  setStatus('Saving…', 'info');
  try {
    const res = await fetch(ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body?.error || `HTTP ${res.status}`;
      throw new Error(message);
    }
    applyInfo(body);
    if (dom.workspaceRootInput) dom.workspaceRootInput.value = body.isDefault ? '' : body.root || '';
    if (dom.workspaceLabelInput) dom.workspaceLabelInput.value = body.label || '';
    setStatus(reset ? 'Workspace reset to default' : 'Workspace updated', 'info');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

export async function showWorkspacePage() {
  showWorkspacePageFrame();
  await loadWorkspace();
}

export function bindWorkspaceController() {
  if (!dom.workspacePage) return;
  if (dom.btnBackChatWorkspace) dom.btnBackChatWorkspace.addEventListener('click', showChatPage);
  if (dom.btnRefreshWorkspace) dom.btnRefreshWorkspace.addEventListener('click', () => {
    setStatus('');
    loadWorkspace();
  });
  if (dom.btnSaveWorkspace) dom.btnSaveWorkspace.addEventListener('click', () => saveWorkspace());
  if (dom.btnResetWorkspace) dom.btnResetWorkspace.addEventListener('click', () => saveWorkspace({ reset: true }));
}

export function currentWorkspaceInfo() {
  return lastInfo;
}
