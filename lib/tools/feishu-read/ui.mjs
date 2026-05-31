function renderFeishuMedia(block, ctx) {
  const path = block.path || block.filename || 'feishu media';
  const previewUrl = block.previewUrl || block.url || '';
  const contentType = block.contentType || '';
  const isImage = /^image\//i.test(contentType);
  const meta = [
    contentType,
    block.size !== undefined ? `${Number(block.size)} bytes` : '',
  ].filter(Boolean).join(' · ');
  const body = isImage && previewUrl
    ? `<div class="feishu-media-preview"><img src="${ctx.escHtml(previewUrl)}" alt="${ctx.escHtml(block.filename || 'Feishu media')}" loading="lazy"></div>`
    : `<div class="feishu-media-file">
        ${previewUrl ? `<a href="${ctx.escHtml(previewUrl)}" target="_blank" rel="noopener noreferrer">Open media file</a>` : ''}
        ${block.filePath ? `<code>${ctx.escHtml(block.filePath)}</code>` : ''}
      </div>`;

  return `
    <div class="feishu-media-toggle">
      <div class="feishu-media-header">
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">▧</span>
          ${ctx.escHtml(path)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
      </div>
      <div class="feishu-media-body">
        ${body}
      </div>
    </div>
  `;
}

export const renderType = 'feishu-media';
export const altRenderTypes = ["file-snippet"];
export const keepExpanded = true;

export function renderBlock(block, collapsed, ctx) {
  return renderFeishuMedia(block, ctx);
}
