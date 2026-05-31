function renderGlobList(block, collapsed = false, ctx) {
  const pattern = block.pattern || '';
  const files = block.files || [];
  const meta = [
    `${files.length} files`,
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const listing = files.map(file => file.path || file.name || '').filter(Boolean).join('\n');

  return `
    <div class="shell-command-toggle glob-list-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">📁</span>
          glob ${ctx.escHtml(pattern)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${ctx.escHtml(listing || '(no files)')}</code></pre>
      </div>
    </div>
  `;
}

export const renderType = 'glob-list';

export function renderBlock(block, collapsed, ctx) {
  return renderGlobList(block, block.collapsed ?? collapsed, ctx);
}
