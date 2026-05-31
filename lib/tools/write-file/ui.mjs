function renderFileWrite(block, collapsed = false, ctx) {
  const path = block.path || 'file';
  const mode = block.mode || 'overwrite';
  const created = block.created === true;
  const deltaLines = (Number(block.afterLines) || 0) - (Number(block.beforeLines) || 0);
  const deltaBytes = (Number(block.afterSize) || 0) - (Number(block.beforeSize) || 0);
  const fmtDelta = (n) => (n > 0 ? `+${n}` : `${n}`);
  const modeLabel = mode === 'str_replace' ? 'edit' : mode;
  const metaItems = [
    created ? 'created' : modeLabel,
    `lines ${block.afterLines ?? '?'} (${fmtDelta(deltaLines)})`,
    `${block.afterSize ?? '?'} bytes (${fmtDelta(deltaBytes)})`,
    block.replacements ? `${block.replacements} match` : '',
    block.encoding || 'utf-8',
  ].filter(Boolean);
  const meta = metaItems.join(' · ');
  const icon = created ? '🆕' : mode === 'str_replace' ? '✏️' : mode === 'append' ? '➕' : '💾';
  const preview = block.preview || '';

  return `
    <div class="shell-command-toggle file-write-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">${icon}</span>
          ${ctx.escHtml(path)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${ctx.escHtml(preview)}</code></pre>
      </div>
    </div>
  `;
}

export const renderType = 'file-write';

export function renderBlock(block, collapsed, ctx) {
  return renderFileWrite(block, block.collapsed ?? collapsed, ctx);
}
