function isTerminalSubagentStatus(status) {
  const value = String(status || '').toLowerCase();
  return value && value !== 'running' && value !== 'tool_error';
}

function subagentFrameBlocks(block, ctx) {
  const out = [];
  const meta = [
    block.expertAgent?.title ? `expert ${block.expertAgent.title}` : '',
    block.durationMs !== undefined && block.durationMs !== null ? `${Number(block.durationMs || 0)}ms` : '',
    block.runId ? `run ${String(block.runId).slice(0, 8)}` : '',
  ].filter(Boolean).join(' · ');

  if (meta) out.push({ type: 'text', content: `_${meta}_` });
  if (block.task) out.push({ type: 'text', content: blockquote(block.task) });
  const content = Array.isArray(block.blocks) && block.blocks.length
    ? block.blocks
    : subagentContentBlocks(block, ctx);
  out.push(...content);

  return out.length ? out : [{ type: 'text', content: 'Running...' }];
}

function subagentContentBlocks(block, ctx) {
  const out = [];
  if (Array.isArray(block.timeline) && block.timeline.length) {
    for (const item of block.timeline) {
      if (item?.kind === 'text' && item.text) {
        out.push({ type: 'text', content: item.text });
      } else if (item?.kind === 'event') {
        out.push(...ctx.subagentEventToBlocks(item.event));
      }
    }
  } else {
    if (block.text || block.error) out.push({ type: 'text', content: block.text || block.error || '' });
    for (const event of Array.isArray(block.events) ? block.events : []) {
      out.push(...ctx.subagentEventToBlocks(event));
    }
  }

  return out;
}

function blockquote(text) {
  return String(text || '')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function renderSubagentRun(block, collapsed, ctx) {
  const status = block.status || 'running';
  const expertTitle = block.expertAgent?.title || '';
  const label = expertTitle || block.label || block.task || 'Expert Agent';
  const blocks = subagentFrameBlocks(block, ctx);
  const runCollapsed = typeof block.collapsed === 'boolean'
    ? block.collapsed
    : Boolean(collapsed && isTerminalSubagentStatus(status));
  const nestedCollapsed = collapsed || runCollapsed;
  const runningClass = !isTerminalSubagentStatus(status) ? ' running' : '';
  const statusLabel = block.thinking && !isTerminalSubagentStatus(status) ? 'thinking...' : status;
  return `
    <div class="subagent-toggle${runningClass}${runCollapsed ? ' collapsed' : ''}" data-agent-run-id="${ctx.escHtml(block.runId || '')}">
      <div class="subagent-toggle-header" data-toggle-parent>
        <span class="subagent-toggle-label">${ctx.escHtml(label)}</span>
        <span class="subagent-status ${ctx.escHtml(status)}">${ctx.escHtml(statusLabel)}</span>
        <span class="subagent-toggle-arrow">▾</span>
      </div>
      <div class="subagent-toggle-body">
        <div class="subagent-content">${ctx.renderBlocks(blocks, nestedCollapsed)}</div>
      </div>
    </div>
  `;
}

export const renderType = 'subagent-run';

export function renderBlock(block, collapsed, ctx) {
  return renderSubagentRun(block, collapsed, ctx);
}
