function formatAboutValue(value, ctx) {
  if (value === null || value === undefined) return '<span class="about-nil">-</span>';
  if (typeof value === 'boolean') return `<span class="about-bool">${value ? 'yes' : 'no'}</span>`;
  if (typeof value === 'number') return `<span class="about-number">${value}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="about-nil">(empty)</span>';
    const isSimple = value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    if (isSimple) {
      return `<span class="about-list">${value.map(v => `<span class="about-chip">${ctx.escHtml(String(v))}</span>`).join(' ')}</span>`;
    }
    return value.map((item, i) => {
      if (typeof item === 'object' && item !== null) {
        return `<div class="about-nested-card"><span class="about-index">#${i + 1}</span>${renderAboutPairs(item, ctx)}</div>`;
      }
      return `<div class="about-row"><span class="about-index">#${i + 1}</span><span class="about-value">${formatAboutValue(item, ctx)}</span></div>`;
    }).join('');
  }
  if (typeof value === 'object') return renderAboutPairs(value, ctx);
  return `<span class="about-string">${ctx.escHtml(String(value))}</span>`;
}

function renderAboutPairs(obj, ctx) {
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  if (keys.length === 0) return '<span class="about-nil">(empty)</span>';
  return `<dl class="about-pairs">${keys.map(key => {
    const val = obj[key];
    return `<div class="about-row"><dt>${ctx.escHtml(key)}</dt><dd>${formatAboutValue(val, ctx)}</dd></div>`;
  }).join('')}</dl>`;
}

function renderAboutXwork(block, collapsed = false, ctx) {
  const query = block.query || '';
  const title = block.title || block.name || 'xwork info';
  const error = block.error || '';
  const hint = block.hint || '';
  const meta = [query, block.error ? 'error' : 'ok'].filter(Boolean).join(' · ');

  if (error) {
    return `
      <div class="shell-command-toggle about-xwork-toggle${collapsed ? ' collapsed' : ''}">
        <div class="shell-command-toggle-header" data-toggle-parent>
          <span class="shell-command-toggle-label">
            <span class="shell-command-icon">ℹ</span>
            about_xwork ${ctx.escHtml(query)}
          </span>
          <span class="shell-command-meta status-error">${ctx.escHtml(error)}</span>
          <span class="shell-command-toggle-arrow">&#9662;</span>
        </div>
        <div class="shell-command-toggle-body">
          <pre class="shell-command-output"><code>${ctx.escHtml(JSON.stringify(block, null, 2))}</code></pre>
        </div>
      </div>
    `;
  }

  const pairs = renderAboutPairs(block, ctx);

  return `
    <div class="shell-command-toggle about-xwork-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">ℹ</span>
          ${ctx.escHtml(title)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <div class="about-xwork-body">
          ${pairs}
          ${hint ? `<div class="about-hint">${ctx.escHtml(hint)}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

export const renderType = 'about-xwork';

export function renderBlock(block, collapsed, ctx) {
  return renderAboutXwork(block, block.collapsed ?? collapsed, ctx);
}
