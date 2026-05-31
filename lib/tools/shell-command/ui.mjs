function processLikePrompt(cwd) {
  const value = String(cwd || '.');
  const short = value.length > 60 ? `...${value.slice(-57)}` : value;
  return `${short}>`;
}

function renderShellCommand(block, collapsed = false, ctx) {
  const exitCode = block.exitCode;
  const timedOut = block.timedOut === true;
  const running = block.status === 'running';
  const statusClass = running ? 'status-running' : timedOut || exitCode !== 0 ? 'status-error' : 'status-ok';
  const status = running ? 'running' : timedOut ? 'timeout' : `exit ${exitCode ?? '?'}`;
  const meta = [
    status,
    block.durationMs !== undefined && block.durationMs !== null ? `${Number(block.durationMs || 0)}ms` : '',
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const cwd = block.cwd || '.';
  const command = block.command || 'shell command';
  const stdout = block.stdout || '';
  const stderr = block.stderr || '';
  const prompt = processLikePrompt(cwd);

  return `
    <div class="shell-command-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">&gt;_</span>
          ${ctx.escHtml(block.command || 'shell command')}
        </span>
        <span class="shell-command-meta ${ctx.escHtml(statusClass)}">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <div class="shell-terminal">
          <div class="shell-terminal-title">
            <span class="shell-terminal-title-text">${ctx.escHtml(cwd)}</span>
          </div>
          <div class="shell-terminal-screen">
            <div class="shell-terminal-line shell-terminal-command">
              <span class="shell-terminal-prompt">${ctx.escHtml(prompt)}</span>
              <span class="shell-terminal-command-text">${ctx.escHtml(command)}</span>
              ${running ? '<span class="shell-terminal-cursor">|</span>' : ''}
            </div>
            ${stdout ? `<pre class="shell-terminal-output stdout"><code>${ctx.escHtml(stdout)}</code></pre>` : ''}
            ${stderr ? `<pre class="shell-terminal-output stderr"><code>${ctx.escHtml(stderr)}</code></pre>` : ''}
            ${running ? '<div class="shell-terminal-running">running...</div>' : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

export const renderType = 'shell-command';

export function renderBlock(block, collapsed, ctx) {
  return renderShellCommand(block, block.collapsed ?? collapsed, ctx);
}
