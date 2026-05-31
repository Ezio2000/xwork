function renderGrepMatches(block, collapsed = false, ctx) {
  const pattern = block.pattern || '';
  const meta = [
    `${Number(block.matchCount || block.matches?.length || 0)} matches`,
    block.truncated ? 'truncated' : '',
    block.scannedFiles !== undefined ? `${Number(block.scannedFiles)} files scanned` : '',
  ].filter(Boolean).join(' · ');
  const lines = (block.matches || []).map(match => {
    const location = `${match.path}:${match.line}`;
    const context = [
      ...(match.before || []).map(line => `  ${line}`),
      `> ${match.content || ''}`,
      ...(match.after || []).map(line => `  ${line}`),
    ].join('\n');
    return `${location}\n${context}`;
  }).join('\n\n');

  return `
    <div class="shell-command-toggle grep-matches-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">🔎</span>
          grep ${ctx.escHtml(pattern)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${ctx.escHtml(lines || '(no matches)')}</code></pre>
      </div>
    </div>
  `;
}

export const renderType = 'grep-matches';

export function renderBlock(block, collapsed, ctx) {
  return renderGrepMatches(block, block.collapsed ?? collapsed, ctx);
}
