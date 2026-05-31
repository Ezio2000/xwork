function browserStepLabel(step) {
  if (step.label) return step.label;
  const phase = step.phase || 'event';
  const action = step.action || 'browser';
  return `${phase} ${action}`;
}

function browserStepMeta(step) {
  const parts = [
    step.title,
    step.url,
    step.selector ? `selector ${step.selector}` : '',
    step.textQuery ? `text ${step.textQuery}` : '',
    step.key ? `key ${step.key}` : '',
    step.waitUntil ? `wait ${step.waitUntil}` : '',
    step.waitState ? `state ${step.waitState}` : '',
    step.statusCode ? `HTTP ${step.statusCode}` : '',
    step.count !== undefined ? `${Number(step.count || 0)} matches` : '',
    step.textLength !== undefined ? `${Number(step.textLength || 0)} chars` : '',
    step.resultType ? String(step.resultType) : '',
    step.screenshotWidth && step.screenshotHeight ? `${Number(step.screenshotWidth)}x${Number(step.screenshotHeight)}px` : '',
    step.fullPageTruncated ? 'viewport only' : '',
    step.screenshotPath,
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderBrowserAction(block, collapsed = false, ctx) {
  const action = block.action || 'browser';
  const title = block.title || block.url || 'Browser action';
  const running = block.status === 'running';
  const error = block.status === 'error';
  const captureMeta = [
    block.screenshotWidth && block.screenshotHeight ? `${Number(block.screenshotWidth)}x${Number(block.screenshotHeight)}px` : '',
    block.fullPageRequested && block.pageHeight ? `page ${Number(block.pageHeight)}px` : '',
    block.fullPageTruncated ? 'viewport only' : '',
  ].filter(Boolean).join(' · ');
  const meta = [
    running ? 'running' : error ? 'error' : '',
    action,
    block.statusCode ? `HTTP ${block.statusCode}` : '',
    block.resultType ? String(block.resultType) : '',
    block.truncated ? 'truncated' : '',
    block.closed ? 'closed' : '',
  ].filter(Boolean).join(' · ');
  const bodyParts = [];

  if (block.url) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>URL</span>
        <a href="${ctx.escHtml(block.url)}" target="_blank" rel="noreferrer">${ctx.escHtml(block.url)}</a>
      </div>
    `);
  }
  if (block.selector) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Selector</span>
        <code>${ctx.escHtml(block.selector)}</code>
      </div>
    `);
  }
  if (block.textQuery) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Text</span>
        <code>${ctx.escHtml(block.textQuery)}</code>
      </div>
    `);
  }
  if (block.key) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Key</span>
        <code>${ctx.escHtml(block.key)}</code>
      </div>
    `);
  }
  if (block.screenshotPath) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Screenshot</span>
        <code>${ctx.escHtml(block.screenshotPath)}</code>
      </div>
    `);
  }
  if (captureMeta) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Capture</span>
        <code>${ctx.escHtml(captureMeta)}</code>
      </div>
    `);
  }
  if (block.screenshotUrl) {
    bodyParts.push(`
      <div class="browser-action-preview">
        <a href="${ctx.escHtml(block.screenshotUrl)}" target="_blank" rel="noreferrer">
          <img src="${ctx.escHtml(block.screenshotUrl)}" alt="Browser screenshot">
        </a>
      </div>
    `);
  }
  if (Array.isArray(block.steps) && block.steps.length) {
    bodyParts.push(`
      <div class="browser-action-steps">
        ${block.steps.map(step => `
          <div class="browser-action-step ${ctx.escHtml(step.phase || 'event')}">
            <span class="browser-action-step-dot"></span>
            <span class="browser-action-step-main">
              <span class="browser-action-step-label">${ctx.escHtml(browserStepLabel(step))}</span>
              <span class="browser-action-step-meta">${ctx.escHtml(browserStepMeta(step))}</span>
            </span>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (Array.isArray(block.matches) && block.matches.length) {
    bodyParts.push(`
      <div class="browser-action-matches">
        ${block.matches.map(match => `
          <div class="browser-action-match">
            <span>#${Number(match.index || 0) + 1}</span>
            <code>${ctx.escHtml(match.tagName || '')}</code>
            <span>${ctx.escHtml(match.text || '')}</span>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (block.text) {
    bodyParts.push(`<pre class="browser-action-output"><code>${ctx.escHtml(block.text)}</code></pre>`);
  }
  if (block.result) {
    bodyParts.push(`<pre class="browser-action-output"><code>${ctx.escHtml(block.result)}</code></pre>`);
  }

  return `
    <div class="browser-action-toggle${collapsed ? ' collapsed' : ''}">
      <div class="browser-action-toggle-header" data-toggle-parent>
        <span class="browser-action-toggle-label">
          <span class="browser-action-icon">&#9711;</span>
          ${ctx.escHtml(title)}
        </span>
        <span class="browser-action-meta">${ctx.escHtml(meta)}</span>
        <span class="browser-action-toggle-arrow">&#9662;</span>
      </div>
      <div class="browser-action-toggle-body">
        ${bodyParts.join('') || '<div class="browser-action-empty">No browser output.</div>'}
      </div>
    </div>
  `;
}

export const renderType = 'browser-action';

export function renderBlock(block, collapsed, ctx) {
  return renderBrowserAction(block, block.collapsed ?? collapsed, ctx);
}
