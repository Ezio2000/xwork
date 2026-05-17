import { dom } from './dom.js';
import { state } from './state.js';
import { buildUsageReportView, buildUsageRunDetailView } from './usage-view.js';

export function renderUsageReport() {
  const view = buildUsageReportView(state.usage);
  dom.usageSummary.innerHTML = view.summaryHtml;
  dom.usageGroups.innerHTML = view.groupsHtml;
  dom.usageRunList.innerHTML = view.runListHtml;
  dom.usageGeneratedAt.textContent = view.generatedAtText;
}

export function showUsageRunDetail(run) {
  const view = buildUsageRunDetailView(run);
  if (!view) return;
  dom.usageDetailTitle.textContent = view.title;
  dom.usageDetailBody.innerHTML = view.bodyHtml;
  dom.usageRunDetail.classList.remove('hidden');
}

export function hideUsageRunDetail() {
  dom.usageRunDetail.classList.add('hidden');
}
