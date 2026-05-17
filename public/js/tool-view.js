import { dom } from './dom.js';
import { escHtml, formatDateTime } from './renderers.js';
import { state } from './state.js';

export function renderToolList() {
  if (!state.tools.length) {
    dom.toolList.innerHTML = '<div class="empty-panel">No tools available.</div>';
    return;
  }

  dom.toolList.innerHTML = state.tools.map(tool => `
    <div class="tool-card${tool.enabled ? ' enabled' : ''}" data-tool-id="${escHtml(tool.id)}">
      <div class="tool-info">
        <div class="tool-title-row">
          <div class="tool-title">${escHtml(tool.title || tool.name)}</div>
          <span class="tool-status">${tool.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div class="tool-desc">${escHtml(tool.description || '')}</div>
        <div class="tool-meta">
          <span>${escHtml(tool.name)}</span>
          <span>${escHtml(tool.adapter || 'builtin')}</span>
          <span>${escHtml(tool.category || 'general')}</span>
          <span>${Number(tool.timeoutMs || 0)}ms</span>
        </div>
      </div>
      <label class="switch" title="Toggle tool">
        <input type="checkbox" data-action="toggle-tool" ${tool.enabled ? 'checked' : ''}>
        <span></span>
      </label>
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
