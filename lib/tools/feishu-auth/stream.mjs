export const toolNames = ['feishu_read', 'feishu_auth'];

export function onToolDelta(evt, stream, effects) {
  if ((evt.name !== 'feishu_read' && evt.name !== 'feishu_auth') || !evt.id) return false;
  const existing = stream.blocks.find(item => item.type === 'feishu-auth' && item.toolCallId === evt.id);
  if (evt.phase === 'feishu_auth_pending') {
    const url = evt.verificationUrl || evt.authorizationUrl || '';
    const block = existing || {
      type: 'feishu-auth',
      toolCallId: evt.id,
      status: 'waiting',
      collapsed: false,
    };
    Object.assign(block, {
      status: 'waiting',
      verificationUrl: url,
      authorizationUrl: url,
      deviceCode: evt.deviceCode || block.deviceCode || '',
      expiresAt: evt.expiresAt || block.expiresAt || '',
      popupBlocked: block.popupBlocked === true,
      popupOpened: block.popupOpened === true,
    });
    if (!existing) stream.blocks.push(block);
    if (url && !block.popupAttempted && typeof window !== 'undefined') {
      block.popupAttempted = true;
      try {
        const popup = window.open(url, `xwork-feishu-auth-${evt.id}`, 'popup,width=960,height=760,noopener,noreferrer');
        block.popupOpened = Boolean(popup);
        block.popupBlocked = !popup;
      } catch {
        block.popupBlocked = true;
      }
    }
    effects.scheduleRender();
    return true;
  }
  if (evt.phase === 'feishu_auth_complete') {
    const block = existing || { type: 'feishu-auth', toolCallId: evt.id };
    Object.assign(block, {
      status: 'completed',
      collapsed: true,
      popupBlocked: false,
    });
    if (!existing) stream.blocks.push(block);
    effects.scheduleRender();
    return true;
  }
  return false;
}

export function installHandlers(root) {
  root.addEventListener('click', (event) => {
    const feishuAuth = event.target.closest('[data-feishu-auth-url]');
    if (feishuAuth) {
      event.preventDefault();
      const url = feishuAuth.dataset.feishuAuthUrl;
      if (url) window.open(url, 'xwork-feishu-auth-manual', 'popup,width=960,height=760,noopener,noreferrer');
    }
  });
}
