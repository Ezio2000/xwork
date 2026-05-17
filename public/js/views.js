import { dom } from './dom.js';
import { state } from './state.js';
import { contentToBlocks, escHtml, formatDateTime, messageSources, messageText, renderBlocks, renderContent, renderSourceCards } from './renderers.js';

export function scrollBottom() {
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

export function renderSelectors() {
  dom.channelSelect.innerHTML = state.channels.map(channel =>
    `<option value="${channel.id}" ${channel.id === state.activeChannelId ? 'selected' : ''}>${escHtml(channel.name)}</option>`
  ).join('');

  const channel = state.channels.find(item => item.id === state.activeChannelId);
  const models = channel ? channel.models : [];
  if (models.length && !models.includes(state.activeModel)) {
    state.activeModel = models[0];
  }
  dom.modelSelect.innerHTML = models.map(model =>
    `<option value="${model}" ${model === state.activeModel ? 'selected' : ''}>${model}</option>`
  ).join('');
}

export function showChannelsPage() {
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
  dom.channelsPage.classList.remove('hidden');
  renderChannelList();
  dom.channelEditor.classList.add('hidden');
}

export function showToolsPageFrame() {
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.remove('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
}

export function showUsagePageFrame() {
  hideToolRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.remove('hidden');
  dom.pricingPage.classList.add('hidden');
}

export function showPricingPageFrame() {
  hideToolRunDetail();
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.remove('hidden');
}

export function showChatPage() {
  hideToolRunDetail();
  hideUsageRunDetail();
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
  dom.chatMain.classList.remove('hidden');
}

export function showSettings() {
  dom.settingsModal.classList.remove('hidden');
}

export function hideSettings() {
  dom.settingsModal.classList.add('hidden');
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text).toString().replace(/\/+$/, '');
  } catch {
    return text.replace(/\/+$/, '');
  }
}

function inferProvider(channel = {}) {
  const baseUrl = normalizeBaseUrl(channel.baseUrl).toLowerCase();
  if (baseUrl.includes('deepseek.com')) return 'deepseek';
  if (baseUrl.includes('anthropic.com')) return 'anthropic';
  if (baseUrl.includes('openai.com')) return 'openai';
  if (baseUrl.includes('googleapis.com')) return 'google';
  const name = String(channel.name || '').toLowerCase();
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('anthropic') || name.includes('claude')) return 'anthropic';
  if (name.includes('openai')) return 'openai';
  if (name.includes('google') || name.includes('gemini')) return 'google';
  return '';
}

function findBasePricing(channel, model) {
  const provider = inferProvider(channel);
  return state.basePricing.find(item => (
    item.model === model
    && String(item.provider || '').toLowerCase() === provider
  ))
    || null;
}

export function effectivePricingForChannelModel(channel, model) {
  const override = channel?.pricing?.models?.[model];
  if (override) return { pricing: override, source: 'Channel Override' };
  const base = findBasePricing(channel, model);
  if (base) return { pricing: base, source: 'Base Default' };
  return { pricing: null, source: 'Missing' };
}

const USD_EXCHANGE_RATES = {
  USD: 1,
  CNY: 7.2,
  EUR: 0.92,
  HKD: 7.8,
};

function convertCurrency(value, fromCurrency = 'USD', toCurrency = 'USD') {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const fromRate = USD_EXCHANGE_RATES[String(fromCurrency || 'USD').toUpperCase()];
  const toRate = USD_EXCHANGE_RATES[String(toCurrency || 'USD').toUpperCase()];
  if (!fromRate || !toRate) return n;
  return (n / fromRate) * toRate;
}

function fmtPrice(value, currency = 'USD', displayCurrency = state.pricingCurrency || 'USD') {
  if (value === null || value === undefined || value === '') return '-';
  const n = convertCurrency(value, currency, displayCurrency);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function pricingPayloadFromDom(prefix = 'editPricing') {
  return {
    provider: dom[`${prefix}Provider`]?.value?.trim(),
    model: dom[`${prefix}Model`]?.value?.trim(),
    currency: (dom[`${prefix}Currency`]?.value?.trim() || 'USD').toUpperCase(),
    unit: 'per_1m_tokens',
    inputTokenPrice: numberOrNull(dom[`${prefix}Input`]?.value),
    cacheReadInputTokenPrice: numberOrNull(dom[`${prefix}CacheRead`]?.value),
    cacheCreationInputTokenPrice: numberOrNull(dom[`${prefix}CacheCreate`]?.value),
    outputTokenPrice: numberOrNull(dom[`${prefix}Output`]?.value),
    webSearchRequestPrice: numberOrNull(dom[`${prefix}WebSearch`]?.value),
    requestPrice: numberOrNull(dom[`${prefix}Request`]?.value),
    sourceUrl: dom[`${prefix}SourceUrl`]?.value?.trim() || '',
    updatedAt: dom[`${prefix}UpdatedAt`]?.value?.trim() || new Date().toISOString(),
    notes: dom[`${prefix}Notes`]?.value?.trim() || '',
  };
}

export function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function collectChannelPricingOverrides(channel) {
  const models = {};
  for (const row of dom.channelPricingList.querySelectorAll('.channel-pricing-row')) {
    const model = row.dataset.model;
    if (!model) continue;
    const currentOverride = channel?.pricing?.models?.[model];
    const values = {
      currency: 'USD',
      unit: 'per_1m_tokens',
      inputTokenPrice: null,
      cacheReadInputTokenPrice: null,
      cacheCreationInputTokenPrice: null,
      outputTokenPrice: null,
      webSearchRequestPrice: null,
      requestPrice: null,
      sourceUrl: currentOverride?.sourceUrl || '',
      updatedAt: currentOverride?.updatedAt || new Date().toISOString(),
      notes: currentOverride?.notes || '',
    };
    for (const input of row.querySelectorAll('[data-price-field]')) {
      const field = input.dataset.priceField;
      if (field === 'currency') {
        values.currency = (input.value.trim() || 'USD').toUpperCase();
      } else {
        values[field] = numberOrNull(input.value);
      }
    }
    const hasAnyPrice = [
      values.inputTokenPrice,
      values.cacheReadInputTokenPrice,
      values.cacheCreationInputTokenPrice,
      values.outputTokenPrice,
      values.webSearchRequestPrice,
      values.requestPrice,
    ].some(value => value !== null);
    if (hasAnyPrice) models[model] = values;
  }
  return { models };
}

function pricingValues(pricing = {}) {
  const currency = pricing.currency || 'USD';
  return [
    `input ${fmtPrice(pricing.inputTokenPrice, currency)}`,
    `output ${fmtPrice(pricing.outputTokenPrice, currency)}`,
    `cache ${fmtPrice(pricing.cacheReadInputTokenPrice, currency)}`,
    `create ${fmtPrice(pricing.cacheCreationInputTokenPrice, currency)}`,
    `call ${fmtPrice(pricing.requestPrice ?? 0, currency)}`,
  ].join(' · ');
}

export function renderChannelList() {
  dom.channelList.innerHTML = state.channels.map(channel => `
    <div class="channel-card${channel.id === state.activeChannelId ? ' active' : ''}" data-channel-id="${channel.id}">
      <div class="ch-info">
        <div class="ch-name">${escHtml(channel.name)}</div>
        <div class="ch-meta">${escHtml(channel.baseUrl)} · Anthropic Messages · ${channel.models.length} models</div>
      </div>
      <span class="ch-badge">anthropic</span>
      <div class="ch-actions">
        <button data-action="edit" data-id="${channel.id}">Edit</button>
        <button data-action="delete" data-id="${channel.id}" class="danger">Del</button>
      </div>
    </div>
  `).join('');
}

function renderChannelPricingRows(channel) {
  const models = channel?.models || [];
  if (!models.length) {
    return '<div class="empty-panel">No models configured for this channel.</div>';
  }
  return models.map(model => {
    const effective = effectivePricingForChannelModel(channel, model);
    const override = channel?.pricing?.models?.[model] || null;
    const pricing = effective.pricing || {};
    const editPricing = override || {};
    const currency = editPricing.currency || pricing.currency || 'USD';
    return `
      <div class="channel-pricing-row" data-model="${escHtml(model)}">
        <div class="channel-pricing-main">
          <div>
            <div class="channel-pricing-model">${escHtml(model)}</div>
            <div class="channel-pricing-values">${escHtml(effective.pricing ? pricingValues(pricing) : 'No pricing configured')}</div>
          </div>
          <span class="pricing-source ${effective.source === 'Missing' ? 'missing' : ''}">${escHtml(effective.source)}</span>
        </div>
        <div class="channel-pricing-edit">
          <input data-price-field="inputTokenPrice" type="number" min="0" step="0.000001" placeholder="Input / 1M" value="${editPricing.inputTokenPrice ?? ''}">
          <input data-price-field="cacheReadInputTokenPrice" type="number" min="0" step="0.000001" placeholder="Cache / 1M" value="${editPricing.cacheReadInputTokenPrice ?? ''}">
          <input data-price-field="cacheCreationInputTokenPrice" type="number" min="0" step="0.000001" placeholder="Create / 1M" value="${editPricing.cacheCreationInputTokenPrice ?? ''}">
          <input data-price-field="outputTokenPrice" type="number" min="0" step="0.000001" placeholder="Output / 1M" value="${editPricing.outputTokenPrice ?? ''}">
          <input data-price-field="webSearchRequestPrice" type="number" min="0" step="0.000001" placeholder="Web / req" value="${editPricing.webSearchRequestPrice ?? ''}">
          <input data-price-field="requestPrice" type="number" min="0" step="0.000001" placeholder="Call / req" value="${editPricing.requestPrice ?? ''}">
          <input data-price-field="currency" type="text" placeholder="USD" value="${escHtml(currency)}">
        </div>
        <div class="channel-pricing-actions">
          <button type="button" class="btn-text small" data-action="use-base" ${findBasePricing(channel, model) ? '' : 'disabled'}>Use Base</button>
          <button type="button" class="btn-text small danger" data-action="clear-override">Clear Override</button>
        </div>
      </div>
    `;
  }).join('');
}

export function showChannelEditor(channel) {
  if (channel) {
    dom.editorTitle.textContent = 'Edit Channel';
    dom.editChannelId.value = channel.id;
    dom.editName.value = channel.name || '';
    dom.editBaseUrl.value = channel.baseUrl || '';
    dom.editApiKey.value = channel.apiKey || '';
    dom.editApiKey.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
    dom.editModels.value = (channel.models || []).join(', ');
    dom.editMaxTokens.value = channel.maxTokens || 8192;
    dom.channelPricingSection.classList.remove('hidden');
    dom.channelPricingList.innerHTML = renderChannelPricingRows(channel);
  } else {
    dom.editorTitle.textContent = 'New Channel';
    dom.editChannelId.value = '';
    dom.editName.value = '';
    dom.editBaseUrl.value = 'https://api.deepseek.com/anthropic';
    dom.editApiKey.value = '';
    dom.editApiKey.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
    dom.editModels.value = '';
    dom.editMaxTokens.value = 8192;
    dom.channelPricingSection.classList.add('hidden');
    dom.channelPricingList.innerHTML = '';
  }
  dom.channelEditor.classList.remove('hidden');
}

export function hideChannelEditor() {
  dom.channelEditor.classList.add('hidden');
}

export function renderBasePricing() {
  if (dom.pricingDisplayCurrency) dom.pricingDisplayCurrency.value = state.pricingCurrency || 'USD';
  if (!state.basePricing.length) {
    dom.pricingCountLabel.textContent = '0 models';
    dom.pricingList.innerHTML = '<div class="empty-panel">No base pricing configured.</div>';
    return;
  }
  dom.pricingCountLabel.textContent = `${state.basePricing.length} model${state.basePricing.length === 1 ? '' : 's'}`;

  const rows = state.basePricing.map(entry => {
    const currency = entry.currency || 'USD';
    return `
      <div class="pricing-row" data-pricing-id="${escHtml(entry.id)}">
        <div class="pricing-identity">
          <div class="pricing-model">${escHtml(entry.model)}</div>
          <div class="pricing-meta">${escHtml(entry.provider || 'unknown')}</div>
        </div>
        <div class="price-cell"><span>Input</span><strong>${escHtml(fmtPrice(entry.inputTokenPrice, currency))}</strong></div>
        <div class="price-cell"><span>Output</span><strong>${escHtml(fmtPrice(entry.outputTokenPrice, currency))}</strong></div>
        <div class="price-cell"><span>Cache</span><strong>${escHtml(fmtPrice(entry.cacheReadInputTokenPrice, currency))}</strong></div>
        <div class="price-cell"><span>Create</span><strong>${escHtml(fmtPrice(entry.cacheCreationInputTokenPrice, currency))}</strong></div>
        <div class="price-cell"><span>Call</span><strong>${escHtml(fmtPrice(entry.requestPrice ?? 0, currency))}</strong></div>
        <div class="pricing-actions">
          <button class="btn-text small" data-action="edit-pricing">Edit</button>
          <button class="btn-text small danger" data-action="delete-pricing">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  dom.pricingList.innerHTML = `
    <div class="pricing-table">
      <div class="pricing-table-head">
        <span>Model</span>
        <span>Input</span>
        <span>Output</span>
        <span>Cache</span>
        <span>Create</span>
        <span>Call</span>
        <span></span>
      </div>
      ${rows}
    </div>
  `;
}

export function showPricingEditor(entry) {
  dom.pricingEditorTitle.textContent = entry ? 'Edit Base Price' : 'New Base Price';
  dom.editPricingId.value = entry?.id || '';
  dom.editPricingProvider.value = entry?.provider || '';
  dom.editPricingModel.value = entry?.model || '';
  dom.editPricingCurrency.value = entry?.currency || 'USD';
  dom.editPricingInput.value = entry?.inputTokenPrice ?? '';
  dom.editPricingCacheRead.value = entry?.cacheReadInputTokenPrice ?? '';
  dom.editPricingCacheCreate.value = entry?.cacheCreationInputTokenPrice ?? '';
  dom.editPricingOutput.value = entry?.outputTokenPrice ?? '';
  dom.editPricingWebSearch.value = entry?.webSearchRequestPrice ?? '';
  dom.editPricingRequest.value = entry?.requestPrice ?? '';
  dom.editPricingSourceUrl.value = entry?.sourceUrl || '';
  dom.editPricingUpdatedAt.value = entry?.updatedAt || new Date().toISOString().slice(0, 10);
  dom.editPricingNotes.value = entry?.notes || '';
  dom.pricingEditor.classList.remove('hidden');
}

export function hidePricingEditor() {
  dom.pricingEditor.classList.add('hidden');
}

export function pricingPayloadFromEditor() {
  const payload = pricingPayloadFromDom();
  if (!dom.editPricingId.value) {
    const rawId = [payload.provider, payload.model].filter(Boolean).join('-');
    payload.id = rawId ? rawId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) : '';
  }
  return payload;
}

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
        ${Number(run.durationMs || 0)}ms · ${escHtml(formatDateTime(run.createdAt))}
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

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function fmtPercent(value) {
  return value === null || value === undefined ? '-' : `${Math.round(Number(value) * 1000) / 10}%`;
}

function fmtDuration(value) {
  if (value === null || value === undefined) return '-';
  const n = Number(value || 0);
  return n >= 1000 ? `${Math.round(n / 100) / 10}s` : `${Math.round(n)}ms`;
}

function fmtDate(value) {
  return formatDateTime(value) || '-';
}

function metricCard(label, value, hint = '') {
  return `
    <div class="usage-metric">
      <div class="usage-metric-label">${escHtml(label)}</div>
      <div class="usage-metric-value">${escHtml(value)}</div>
      ${hint ? `<div class="usage-metric-hint">${escHtml(hint)}</div>` : ''}
    </div>
  `;
}

function fmtCost(cost = {}) {
  if (cost.totalCost === null || cost.totalCost === undefined) return 'Missing';
  const currency = cost.currency || 'USD';
  return `${currency} ${Number(cost.totalCost || 0).toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  })}`;
}

function usageBar(ratio) {
  const pct = Math.max(0, Math.min(100, Number(ratio || 0) * 100));
  const hue = Math.round((pct / 100) * 120);
  return `
    <div class="usage-cache-bar">
      <span style="width:${pct}%;background-color:hsl(${hue} 65% 42%)"></span>
    </div>
  `;
}

function metricBadges(metrics = {}, extras = {}) {
  return [
    `${fmtNumber(metrics.totalInputTokens)} in`,
    `${fmtNumber(metrics.cacheReadInputTokens)} cached`,
    `${fmtNumber(metrics.uncachedInputTokens)} uncached`,
    `${fmtNumber(metrics.outputTokens)} out`,
    `${fmtNumber(metrics.webSearchRequests)} web`,
    extras.cost ? `cost ${fmtCost(extras.cost)}` : '',
    extras.toolCalls !== undefined ? `${fmtNumber(extras.toolCalls)} tools` : '',
    extras.subagents ? `${fmtNumber(extras.subagents)} subagents` : '',
  ].filter(Boolean).map(item => `<span>${escHtml(item)}</span>`).join('');
}

function renderUsageRunLine(run) {
  return `
    <div class="usage-run-line" data-run-id="${escHtml(run.runId)}">
      <div class="usage-run-line-main">
        <div class="usage-run-title">
          <span class="usage-role ${escHtml(run.role)}">${escHtml(run.role)}</span>
          <span>${escHtml(run.label || run.task || run.runId)}</span>
        </div>
        <div class="usage-run-cache">${fmtPercent(run.metrics?.cacheHitRatio)}</div>
      </div>
      <div class="usage-run-meta">
        <span>${escHtml(run.model || 'unknown')}</span>
        <span>${fmtDuration(run.durationMs)}</span>
        ${metricBadges(run.metrics, { toolCalls: run.toolCounts?.totalToolCalls, cost: run.cost })}
      </div>
      ${usageBar(run.metrics?.cacheHitRatio)}
    </div>
  `;
}

function renderUsageTask(task, index) {
  const metrics = task.metrics || {};
  const expanded = Boolean(task.expanded);
  return `
    <div class="usage-task${expanded ? ' expanded' : ''}" data-task-index="${index}">
      <div class="usage-task-summary" data-action="toggle-usage-task">
        <div class="usage-run-main">
          <div class="usage-run-title">
            <span class="usage-task-arrow">${expanded ? '▾' : '▸'}</span>
            <span class="usage-role root">task</span>
            <span>${escHtml(task.label || task.task || task.rootRunId)}</span>
          </div>
          <div class="usage-run-cache">${fmtPercent(metrics.cacheHitRatio)}</div>
        </div>
        <div class="usage-run-meta">
          <span>${escHtml(task.model || 'unknown')}</span>
          <span>${fmtDate(task.startedAt)}</span>
          <span>${fmtDuration(task.durationMs)}</span>
          <span>${fmtNumber(task.runCount)} runs</span>
          ${metricBadges(metrics, {
            toolCalls: task.toolCounts?.totalToolCalls,
            subagents: task.subagentCount,
            cost: task.cost,
          })}
        </div>
        ${usageBar(metrics.cacheHitRatio)}
      </div>
      ${expanded ? `
        <div class="usage-task-detail">
          ${(task.runs || []).map(renderUsageRunLine).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderUsageGroup(title, rows = []) {
  if (!rows.length) return '';
  return `
    <div class="usage-group-card">
      <h3>${escHtml(title)}</h3>
      <div class="usage-group-table">
        ${rows.map(row => `
          <div class="usage-group-row">
            <span class="usage-group-key">${escHtml(row.key)}</span>
            <span>${fmtNumber(row.requestCount)} req</span>
            <span>${fmtCost(row.cost)}</span>
            <span>${fmtPercent(row.weightedCacheHitRatio)}</span>
            <span>${fmtDuration(row.averageDurationMs)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

export function renderUsageReport() {
  const report = state.usage;
  if (!report) {
    dom.usageSummary.innerHTML = '<div class="empty-panel">No usage data loaded.</div>';
    dom.usageGroups.innerHTML = '';
    dom.usageRunList.innerHTML = '';
    dom.usageGeneratedAt.textContent = '';
    return;
  }

  const s = report.summary || {};
  dom.usageSummary.innerHTML = [
    metricCard('Tasks', fmtNumber((report.tasks || []).length), `${fmtNumber(s.requestCount)} runs`),
    metricCard('Cache Hit', fmtPercent(s.weightedCacheHitRatio), `${fmtNumber(s.cacheReadInputTokens)} cached tokens`),
    metricCard('Input', fmtNumber(s.totalInputTokens), `${fmtNumber(s.uncachedInputTokens)} uncached`),
    metricCard('Output', fmtNumber(s.outputTokens), 'generated tokens'),
    metricCard('Cost', fmtCost(s.cost), `${fmtNumber(s.cost?.unpricedRunCount)} partial/missing`),
    metricCard('Latency', fmtDuration(s.averageDurationMs), 'average duration'),
    metricCard('Web Search', fmtNumber(s.webSearchRequests), 'requests'),
  ].join('');

  dom.usageGroups.innerHTML = [
    renderUsageGroup('By Role', report.groups?.byRole || []),
    renderUsageGroup('By Model', report.groups?.byModel || []),
    renderUsageGroup('By Status', report.groups?.byStatus || []),
  ].join('');

  dom.usageGeneratedAt.textContent = `Generated ${fmtDate(report.generatedAt)}`;
  const tasks = report.tasks || [];
  if (!tasks.length) {
    dom.usageRunList.innerHTML = '<div class="empty-panel">No agent tasks found.</div>';
    return;
  }

  dom.usageRunList.innerHTML = tasks.map(renderUsageTask).join('');
}

export function showUsageRunDetail(run) {
  if (!run) return;
  dom.usageDetailTitle.textContent = run.label || run.task || run.runId;
  const parts = [];
  parts.push(`
    <div class="detail-section">
      <div class="detail-meta-grid">
        <div class="detail-meta-item"><div class="dm-label">Role</div><div class="dm-value">${escHtml(run.role)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Status</div><div class="dm-value">${escHtml(run.status)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Cache Hit</div><div class="dm-value">${fmtPercent(run.metrics?.cacheHitRatio)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Cost</div><div class="dm-value">${escHtml(fmtCost(run.cost))}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Duration</div><div class="dm-value">${fmtDuration(run.durationMs)}</div></div>
      </div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Cost</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.cost || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Token Metrics</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.metrics || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Tool Counts</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify({ ...(run.toolCounts || {}), subagentCount: run.subagentCount }, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Raw Usage</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.usage || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Run</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify({
        runId: run.runId,
        rootRunId: run.rootRunId,
        parentRunId: run.parentRunId,
        conversationId: run.conversationId,
        model: run.model,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        task: run.task,
      }, null, 2))}</pre></div>
    </div>
  `);
  dom.usageDetailBody.innerHTML = parts.join('');
  dom.usageRunDetail.classList.remove('hidden');
}

export function hideUsageRunDetail() {
  dom.usageRunDetail.classList.add('hidden');
}

export function renderConvoList() {
  dom.convList.innerHTML = state.conversations.map(conversation =>
    `<div class="conv-item${conversation.id === state.activeId ? ' active' : ''}" data-id="${conversation.id}">
      <span class="conv-title">${escHtml(conversation.title)}</span>
      <button class="conv-delete" data-id="${conversation.id}" title="Delete">×</button>
    </div>`
  ).join('');
}

export function hydrateAssistantMessages(messages) {
  const toolResultsByAssistant = {};

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const map = {};

    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role !== 'user') break;
      if (!Array.isArray(next.content)) continue;
      for (const part of next.content) {
        if (part.type !== 'tool_result' || typeof part.content !== 'string') continue;
        try {
          const data = JSON.parse(part.content);
          if (Array.isArray(data.uuids)) {
            map[part.tool_use_id] = { type: 'uuid-list', uuids: data.uuids, count: data.count ?? data.uuids.length };
          }
        } catch {}
      }
    }

    if (Object.keys(map).length) {
      toolResultsByAssistant[i] = map;
    }
  }

  const hydrated = messages.map((message, i) => {
    if (message.role !== 'assistant') return message;
    const toolMap = toolResultsByAssistant[i];
    if (Array.isArray(message.blocks)) {
      if (toolMap && !message.blocks.some(block => block.type === 'uuid-list')) {
        const blocks = contentToBlocks(message.content, message.sources, message.searchCount, toolMap);
        if (blocks) return { ...message, blocks };
      }
      return message;
    }
    const blocks = contentToBlocks(message.content, message.sources, message.searchCount, toolMap);
    return blocks ? { ...message, blocks } : message;
  });

  for (const msg of hydrated) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.blocks)) continue;
    let lastTextIdx = -1;
    let firstPostTextUuid = -1;
    for (let i = 0; i < msg.blocks.length; i++) {
      const block = msg.blocks[i];
      if (block.type === 'text' && block.content?.trim()) lastTextIdx = i;
      if (block.type === 'uuid-list' && lastTextIdx >= 0 && firstPostTextUuid < 0) firstPostTextUuid = i;
    }
    if (firstPostTextUuid < 0) continue;
    const before = msg.blocks.slice(0, lastTextIdx).filter(block => block.type !== 'uuid-list');
    const uuids = msg.blocks.filter(block => block.type === 'uuid-list');
    const after = msg.blocks.slice(lastTextIdx).filter(block => block.type !== 'uuid-list');
    msg.blocks = [...before, ...uuids, ...after];
  }

  return hydrated;
}

export function isVisibleMessage(message) {
  if (message.role === 'tool') return false;
  return messageText(message).trim().length > 0;
}

export function renderMessages() {
  const visibleMessages = state.messages.filter(isVisibleMessage);
  const stream = state.activeId ? state.streamingByConversationId.get(state.activeId) : null;
  if (visibleMessages.length === 0 && !stream) {
    dom.messages.innerHTML = `
      <div class="empty-state">
        <div class="brand">xwork</div>
        <p>Ask anything. Configure channels in Settings to get started.</p>
      </div>`;
    return;
  }

  const pendingMessages = [...visibleMessages];
  if (stream && pendingMessages.length <= stream.originalMessageCount) {
    pendingMessages.push({ role: 'user', content: stream.message });
  }

  const html = pendingMessages.map(message => {
    if (message.role === 'assistant' && Array.isArray(message.blocks)) {
      return `<div class="message assistant">
        <div class="role-label">ASSISTANT</div>
        <div class="content">${renderBlocks(message.blocks, true)}</div>
      </div>`;
    }
    return `<div class="message ${message.role}">
      <div class="role-label">${message.role === 'user' ? 'YOU' : 'ASSISTANT'}</div>
      <div class="content">${renderContent(messageText(message))}</div>
      ${message.role === 'assistant' ? `<div class="web-sources">${renderSourceCards(messageSources(message), true, message.searchCount || 0)}</div>` : ''}
    </div>`;
  }).join('');
  dom.messages.innerHTML = stream
    ? `${html}
      <div class="message assistant streaming" data-chat-run-id="${escHtml(stream.runId || '')}">
        <div class="role-label">ASSISTANT</div>
        <div class="content"></div>
      </div>`
    : html;
}

export function addUserMessage(text) {
  const emptyState = dom.messages.querySelector('.empty-state');
  if (emptyState) dom.messages.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="role-label">You</div><div class="content">${renderContent(text)}</div>`;
  dom.messages.appendChild(div);
  scrollBottom();
}

export function addAssistantPlaceholder(stream = null) {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  if (stream?.runId) div.dataset.chatRunId = stream.runId;
  div.innerHTML = `<div class="role-label">ASSISTANT</div><div class="content"></div>`;
  dom.messages.appendChild(div);
  scrollBottom();
  return {
    rootEl: div,
    contentEl: div.querySelector('.content'),
  };
}
