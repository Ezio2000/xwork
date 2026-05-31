function formatDirEntry(entry) {
  const indent = '  '.repeat(Math.max(0, (entry.depth || 1) - 1));
  const suffix = entry.kind === 'directory'
    ? entry.skipped ? '/' : '/'
    : entry.size != null ? ` (${entry.size} bytes)` : '';
  const skipped = entry.skipped ? ' [skipped]' : '';
  return `${indent}${entry.name}${suffix}${skipped}`;
}

function renderDirList(block, collapsed = false, ctx) {
  const path = block.path || '.';
  const entries = block.entries || [];
  const meta = [
    `${entries.length} entries`,
    block.depth ? `depth ${block.depth}` : '',
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const listing = entries.map(formatDirEntry).join('\n');

  return `
    <div class="shell-command-toggle dir-list-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">🗂️</span>
          list ${ctx.escHtml(path)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${ctx.escHtml(listing || '(empty directory)')}</code></pre>
      </div>
    </div>
  `;
}

export const renderType = 'dir-list';

export function renderBlock(block, collapsed, ctx) {
  return renderDirList(block, block.collapsed ?? collapsed, ctx);
}
