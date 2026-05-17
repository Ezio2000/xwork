import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  hideUsageRunDetail,
  renderUsageReport,
  showChatPage,
  showUsagePageFrame,
  showUsageRunDetail,
} from '../views.js';

export async function loadUsage() {
  state.usage = await api('GET', '/api/v1/usage?limit=100');
  renderUsageReport();
}

export async function showUsagePage() {
  showUsagePageFrame();
  await loadUsage();
}

export function bindUsageController() {
  dom.btnBackChatUsage.addEventListener('click', showChatPage);
  dom.btnRefreshUsage.addEventListener('click', loadUsage);
  dom.usageRunList.addEventListener('click', (event) => {
    const runItem = event.target.closest('.usage-run-line');
    if (runItem) {
      const run = state.usage?.runs?.find(item => item.runId === runItem.dataset.runId);
      if (run) showUsageRunDetail(run);
      return;
    }

    const taskItem = event.target.closest('.usage-task-summary');
    if (!taskItem) return;
    const task = taskItem.closest('.usage-task');
    const usageTask = state.usage?.tasks?.[Number(task?.dataset.taskIndex)];
    if (!usageTask) return;
    usageTask.expanded = !usageTask.expanded;
    renderUsageReport();
  });
  dom.usageRunList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.usage-run-line');
    if (!item) return;
    event.preventDefault();
    const run = state.usage?.runs?.find(candidate => candidate.runId === item.dataset.runId);
    if (run) showUsageRunDetail(run);
  });
  dom.btnCloseUsageDetail.addEventListener('click', hideUsageRunDetail);
  dom.usageRunDetail.querySelector('.detail-backdrop').addEventListener('click', hideUsageRunDetail);
}
