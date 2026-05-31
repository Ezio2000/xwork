function formatGitSummary(block) {
  const summary = block.summary || {};
  switch (block.action) {
    case 'status':
      return [
        summary.branch ? `branch ${summary.branch}` : '',
        summary.clean ? 'clean' : '',
        summary.stagedCount ? `${summary.stagedCount} staged` : '',
        summary.unstagedCount ? `${summary.unstagedCount} unstaged` : '',
        summary.untrackedCount ? `${summary.untrackedCount} untracked` : '',
      ].filter(Boolean).join(' · ');
    case 'branch':
      return [
        summary.current ? `current ${summary.current}` : '',
        summary.branchCount !== undefined ? `${summary.branchCount} branches` : '',
      ].filter(Boolean).join(' · ');
    case 'log':
    case 'reflog':
    case 'stash_list':
      return summary.commitCount !== undefined ? `${summary.commitCount} entries` : '';
    default:
      return '';
  }
}

function renderGitOutput(block, collapsed = false, ctx) {
  const action = block.action || 'git';
  const meta = [
    block.exitCode === 0 ? 'ok' : `exit ${block.exitCode ?? '?'}`,
    formatGitSummary(block),
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const output = block.output || '';

  return `
    <div class="shell-command-toggle git-output-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">⎇</span>
          git ${ctx.escHtml(action)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${ctx.escHtml(output || '(no output)')}</code></pre>
      </div>
    </div>
  `;
}

export const renderType = 'git-output';

export function renderBlock(block, collapsed, ctx) {
  return renderGitOutput(block, block.collapsed ?? collapsed, ctx);
}
