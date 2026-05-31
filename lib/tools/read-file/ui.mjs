function renderFileSnippet(block, collapsed = false, ctx) {
  const path = block.path || 'file';
  const range = block.startLine && block.endLine
    ? `L${block.startLine}-${block.endLine}`
    : '';
  const meta = [
    range,
    block.encoding || 'utf-8',
    block.truncated ? 'truncated' : '',
    block.size !== undefined ? `${Number(block.size)} bytes` : '',
  ].filter(Boolean).join(' · ');
  const content = block.content || block.contentPreview || '';
  const isMarkdown = block.contentFormat === 'markdown' || String(path).startsWith('feishu:');
  const contentHtml = isMarkdown
    ? `<div class="file-snippet-markdown">${ctx.renderContent(content)}</div>`
    : `<pre class="shell-command-output"><code>${ctx.escHtml(content)}</code></pre>`;

  return `
    <div class="shell-command-toggle file-snippet-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">📄</span>
          ${ctx.escHtml(path)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        ${contentHtml}
      </div>
    </div>
  `;
}

export const renderType = 'file-snippet';

export function renderBlock(block, collapsed, ctx) {
  return renderFileSnippet(block, block.collapsed ?? collapsed, ctx);
}
