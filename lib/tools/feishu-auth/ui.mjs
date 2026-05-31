function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderFeishuAuth(block, collapsed = false, ctx) {
  const waiting = block.status !== 'completed';
  const url = block.verificationUrl || block.authorizationUrl || '';
  const meta = waiting
    ? [
      'waiting for authorization',
      block.popupOpened ? 'popup opened' : '',
      block.popupBlocked ? 'popup blocked' : '',
      block.expiresAt ? `expires ${formatDateTime(block.expiresAt)}` : '',
    ].filter(Boolean).join(' · ')
    : 'authorized';
  const message = waiting
    ? 'Complete Feishu authorization in the popup window. If it did not open, use the button below.'
    : 'Feishu authorization completed.';

  return `
    <div class="shell-command-toggle feishu-auth-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">↗</span>
          Feishu authorization
        </span>
        <span class="shell-command-meta ${waiting ? 'status-running' : 'status-ok'}">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <div class="feishu-auth-body">
          <p>${ctx.escHtml(message)}</p>
          ${url && waiting ? `<button type="button" class="btn-primary small" data-feishu-auth-url="${ctx.escHtml(url)}">Open Feishu</button>` : ''}
          ${block.popupBlocked && waiting ? '<p class="feishu-auth-warning">Your browser blocked the popup. Click Open Feishu to continue.</p>' : ''}
          ${block.deviceCode && waiting ? `<code>${ctx.escHtml(block.deviceCode)}</code>` : ''}
        </div>
      </div>
    </div>
  `;
}

export const renderType = 'feishu-auth';

export function renderBlock(block, collapsed, ctx) {
  return renderFeishuAuth(block, block.collapsed ?? collapsed, ctx);
}
