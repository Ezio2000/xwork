export const toolNames = ['shell_command'];

export function onToolCall(evt, stream) {
  for (const tool of evt.tools || []) {
    if (tool.name !== 'shell_command' || !tool.id) continue;
    const existing = stream.blocks.find(block => block.type === 'shell-command' && block.toolCallId === tool.id);
    if (existing) {
      Object.assign(existing, {
        status: 'running',
        command: tool.input?.command || existing.command || 'shell command',
        cwd: tool.input?.cwd || existing.cwd || '',
        startedAt: Date.now(),
        collapsed: false,
      });
      continue;
    }
    stream.blocks.push({
      type: 'shell-command',
      toolCallId: tool.id,
      status: 'running',
      command: tool.input?.command || 'shell command',
      cwd: tool.input?.cwd || '',
      stdout: '',
      stderr: '',
      collapsed: false,
      startedAt: Date.now(),
    });
  }
}

export function onToolDelta(evt, stream, effects) {
  if (evt.name !== 'shell_command' || !evt.id) return false;
  const block = stream.blocks.find(item => item.type === 'shell-command' && item.toolCallId === evt.id);
  if (!block) return true;
  if (evt.stream === 'stderr') {
    block.stderr = (block.stderr || '') + (evt.text || '');
  } else {
    block.stdout = (block.stdout || '') + (evt.text || '');
  }
  block.status = block.status || 'running';
  block.collapsed = false;
  effects.scheduleRender();
  return true;
}

export function onToolResultTool(tool, stream, effects, helpers) {
  if (tool.name !== 'shell_command') return false;
  return markExistingShellCommandErrored(tool, stream);
}

export function markExistingShellCommandErrored(tool, stream) {
  if (tool.name !== 'shell_command' || !tool.id || !tool.isError) return false;
  const existing = stream.blocks.find(block => block.type === 'shell-command' && block.toolCallId === tool.id);
  if (!existing) return false;
  Object.assign(existing, {
    status: 'error',
    durationMs: tool.durationMs,
    stderr: existing.stderr || 'Tool execution was blocked or failed before command output was available.',
    collapsed: true,
  });
  return true;
}
