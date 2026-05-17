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

  dom.toolRunList.addEventListener('click', (event) => {
    const item = event.target.closest('.tool-run');
    if (!item) return;
    const run = state.toolRuns[Number(item.dataset.runIndex)];
    if (run) showToolRunDetail(run);
  });
  dom.btnCloseDetail.addEventListener('click', hideToolRunDetail);
  dom.toolRunDetail.querySelector('.detail-backdrop').addEventListener('click', hideToolRunDetail);
}
