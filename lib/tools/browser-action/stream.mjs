export const toolNames = ['browser_action'];

export function onToolCall(evt, stream, effects) {
  for (const tool of evt.tools || []) {
    if (tool.name !== 'browser_action' || !tool.id) continue;
    if (effects.isActiveConversation?.()) {
      effects.updateBrowserLivePreview?.({
        id: tool.id,
        name: tool.name,
        phase: 'call',
        status: 'running',
        action: tool.input?.action || 'browser',
        url: tool.input?.url || '',
        selector: tool.input?.selector || '',
        key: tool.input?.key || '',
        label: `call ${tool.input?.action || 'browser'}`,
      }, { conversationId: stream.conversationId });
    }
    const existing = stream.blocks.find(block => block.type === 'browser-action' && block.toolCallId === tool.id);
    if (existing) {
      Object.assign(existing, {
        status: 'running',
        action: tool.input?.action || existing.action || 'browser',
        textQuery: tool.input?.action !== 'type' ? tool.input?.text || existing.textQuery || '' : existing.textQuery || '',
        collapsed: false,
      });
      continue;
    }
    stream.blocks.push({
      type: 'browser-action',
      toolCallId: tool.id,
      status: 'running',
      action: tool.input?.action || 'browser',
      url: tool.input?.url || '',
      selector: tool.input?.selector || '',
      textQuery: tool.input?.action !== 'type' ? tool.input?.text || '' : '',
      key: tool.input?.key || '',
      steps: [{
        phase: 'call',
        action: tool.input?.action || 'browser',
        label: `call ${tool.input?.action || 'browser'}`,
        ts: new Date().toISOString(),
      }],
      collapsed: false,
      startedAt: Date.now(),
    });
  }
}

export function onToolDelta(evt, stream, effects) {
  if (evt.name !== 'browser_action' || !evt.id) return false;
  const block = stream.blocks.find(item => item.type === 'browser-action' && item.toolCallId === evt.id);
  if (!block) return true;
  block.steps = Array.isArray(block.steps) ? block.steps : [];
  block.steps.push({
    phase: evt.phase || 'event',
    action: evt.action || block.action || 'browser',
    label: evt.label || `${evt.phase || 'event'} ${evt.action || block.action || 'browser'}`,
    ts: evt.ts || new Date().toISOString(),
    url: evt.url,
    title: evt.title,
    selector: evt.selector,
    textQuery: evt.textQuery,
    key: evt.key,
    waitUntil: evt.waitUntil,
    waitState: evt.waitState,
    statusCode: evt.statusCode,
    screenshotUrl: evt.screenshotUrl,
    screenshotPath: evt.screenshotPath,
    count: evt.count,
    textLength: evt.textLength,
    resultType: evt.resultType,
    truncated: evt.truncated,
    fullPage: evt.fullPage,
    fullPageRequested: evt.fullPageRequested,
    fullPageTruncated: evt.fullPageTruncated,
    pageHeight: evt.pageHeight,
    screenshotWidth: evt.screenshotWidth,
    screenshotHeight: evt.screenshotHeight,
    closed: evt.closed,
  });
  if (evt.url) block.url = evt.url;
  if (evt.title) block.title = evt.title;
  if (evt.textQuery) block.textQuery = evt.textQuery;
  if (evt.screenshotUrl) block.screenshotUrl = evt.screenshotUrl;
  if (evt.screenshotPath) block.screenshotPath = evt.screenshotPath;
  if (evt.fullPageRequested !== undefined) block.fullPageRequested = evt.fullPageRequested;
  if (evt.fullPageTruncated !== undefined) block.fullPageTruncated = evt.fullPageTruncated;
  if (evt.pageHeight !== undefined) block.pageHeight = evt.pageHeight;
  if (evt.screenshotWidth !== undefined) block.screenshotWidth = evt.screenshotWidth;
  if (evt.screenshotHeight !== undefined) block.screenshotHeight = evt.screenshotHeight;
  if (evt.truncated !== undefined) block.truncated = evt.truncated;
  block.status = evt.phase === 'complete' ? 'completed' : 'running';
  block.collapsed = false;
  if (effects.isActiveConversation?.()) {
    effects.updateBrowserLivePreview?.({ ...evt, status: block.status }, { conversationId: stream.conversationId });
  }
  effects.scheduleRender();
  return true;
}

export function onToolResultTool(tool, stream, effects) {
  if (tool.name !== 'browser_action') return false;
  if (effects?.isActiveConversation?.()) {
    effects.completeBrowserLivePreview?.(tool, { conversationId: stream.conversationId });
  }
  return markExistingBrowserActionErrored(tool, stream);
}

export function markExistingBrowserActionErrored(tool, stream) {
  if (tool.name !== 'browser_action' || !tool.id || !tool.isError) return false;
  const existing = stream.blocks.find(block => block.type === 'browser-action' && block.toolCallId === tool.id);
  if (!existing) return false;
  existing.status = 'error';
  existing.error = String(tool.output || 'Browser action failed');
  existing.durationMs = tool.durationMs;
  existing.steps = Array.isArray(existing.steps) ? existing.steps : [];
  existing.steps.push({
    phase: 'error',
    action: existing.action || 'browser',
    label: existing.error,
    ts: new Date().toISOString(),
  });
  existing.collapsed = true;
  return true;
}
